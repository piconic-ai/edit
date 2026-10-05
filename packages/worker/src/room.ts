import { DurableObject } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  ADMISSION_PATTERN,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
} from '@pedit/protocol/admission'
import { ROOM_CLOSED } from '@pedit/protocol/close'

// Shared browser code brings DOM's SubtleCrypto into this program. Augment it
// with the documented Workers extension also present in our generated types.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean
  }
}

export const MAX_PEERS = 32
export const MAX_MESSAGE_BYTES = 1024 * 1024
/** Set by the Worker (never by clients) on the host's upgrade request. */
export const HOST_HEADER = 'X-Pedit-Host'

/** An attachment of up to 10 MiB, plus its AES-GCM IV and tag. */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024 + 28
/** Default quota of one room; BLOB_QUOTA_BYTES and BLOB_QUOTA_COUNT override it. */
export const ROOM_BLOB_BYTES = 100 * 1024 * 1024
export const ROOM_BLOB_COUNT = 500

const HOST_TAG = 'host'
const BLOB_PATH = /\/blobs\/([A-Za-z0-9_-]{22})$/
const USAGE_KEY = 'blobUsage'
const ADMISSION_KEY = 'admissionHash'

interface Usage {
  bytes: number
  count: number
}

/**
 * A room relays encrypted frames between its peers. It never parses or stores them;
 * it cannot, since it never sees the key.
 *
 * A room lives only as long as its host is connected: guests are turned away
 * while there is no host, and everyone is disconnected with ROOM_CLOSED as soon
 * as the host leaves, so nothing lingers (and nothing keeps waking the room up)
 * after a session ends.
 *
 * Attachments are the one thing a room keeps: encrypted blobs in R2, only while
 * the host is connected, deleted when the host leaves. The room counts their
 * size and number (never their content) to enforce its quota.
 */
export class Room extends DurableObject<Env> {
  // Blob ids being uploaded right now, so two uploads of one id cannot race.
  private readonly uploading = new Set<string>()
  // Deleting the blobs of a session that just ended. A reconnecting host must
  // not start using blobs before it finishes.
  private cleaning: Promise<void> = Promise.resolve()
  // Bumped by every cleanup, so an upload that spans one knows its quota
  // reservation belonged to the session that ended. In memory only: nothing
  // is in flight while the room hibernates.
  private generation = 0

  override async fetch(request: Request): Promise<Response> {
    const blob = BLOB_PATH.exec(new URL(request.url).pathname)?.[1]
    if (blob) return this.blob(request, blob)

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    const token = readAdmissionProtocol(request.headers.get('Sec-WebSocket-Protocol'))
    if (!token) return new Response('room admission required; update your client', { status: 403 })
    const isHost = request.headers.get(HOST_HEADER) === '1'
    if (!isHost && this.hosts().length === 0) {
      // Accept only to tell the client why: browsers cannot read HTTP errors of
      // a failed upgrade, but they do see close codes.
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      server.close(ROOM_CLOSED, 'room is closed')
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
      })
    }
    // Authenticate before taking a peer slot. Only the authenticated host may
    // register the verifier; a guest cannot claim an unopened room's token.
    if (!(await this.authorize(token, isHost)))
      return new Response('invalid room admission', { status: 403 })
    if (this.ctx.getWebSockets().length >= MAX_PEERS) {
      return new Response('room is full', { status: 429 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, isHost ? [HOST_TAG] : [])
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
    })
  }

  private async authorize(token: string, register = false): Promise<boolean> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    // Persist the verifier across hibernation. Read after hashing so concurrent
    // host handshakes cannot each install a different token.
    const expected = this.ctx.storage.kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (expected) return crypto.subtle.timingSafeEqual(expected, digest)
    if (!register) return false
    this.ctx.storage.kv.put(ADMISSION_KEY, digest)
    return true
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      ws.close(1003, 'binary frames only')
      return
    }
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'message too big')
      return
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(message)
      } catch {
        // The peer is going away; its close handler cleans up.
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    safeClose(ws, code, reason)
    await this.closeIfHostLeft(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, 'error')
    await this.closeIfHostLeft(ws)
  }

  private hosts(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(HOST_TAG).filter((s) => s !== except)
  }

  private async closeIfHostLeft(ws: WebSocket): Promise<void> {
    if (!this.ctx.getTags(ws).includes(HOST_TAG) || this.hosts(ws).length > 0) return
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) safeClose(peer, ROOM_CLOSED, 'the host left')
    }
    // End the session at once: its quota and uploads no longer count.
    this.generation++
    this.ctx.storage.kv.delete(USAGE_KEY)
    this.ctx.storage.kv.delete(ADMISSION_KEY)
    this.cleaning = this.cleaning.then(() => this.deleteBlobs())
    await this.cleaning
  }

  private async blob(request: Request, id: string): Promise<Response> {
    const token = request.headers.get(ADMISSION_HEADER)
    if (!token || !ADMISSION_PATTERN.test(token))
      return new Response('room admission required', { status: 403 })
    // Another session may end while we wait, chaining a newer cleanup.
    let cleaning: Promise<void>
    do {
      cleaning = this.cleaning
      await cleaning
    } while (cleaning !== this.cleaning)
    if (this.hosts().length === 0) return new Response('room is closed', { status: 410 })
    if (!(await this.authorize(token)))
      return new Response('invalid room admission', { status: 403 })
    const key = this.blobPrefix() + id
    if (request.method === 'GET') {
      const object = await this.env.BLOBS.get(key)
      if (!object) return new Response('no such blob', { status: 404 })
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(object.size),
          'Cache-Control': 'private, max-age=3600',
        },
      })
    }
    if (request.method === 'PUT') return this.putBlob(request, key)
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } })
  }

  private async putBlob(request: Request, key: string): Promise<Response> {
    const header = request.headers.get('Content-Length')
    const length = Number(header)
    if (!header || !Number.isSafeInteger(length) || length < 0) {
      return new Response('Content-Length required', { status: 411 })
    }
    if (length > MAX_BLOB_BYTES) return new Response('blob too large', { status: 413 })
    // Claim the id before awaiting anything.
    if (this.uploading.has(key)) return new Response('upload in progress', { status: 409 })
    this.uploading.add(key)
    try {
      return await this.upload(request, key, length)
    } finally {
      this.uploading.delete(key)
    }
  }

  private async upload(request: Request, key: string, length: number): Promise<Response> {
    const generation = this.generation
    const ended = () => this.generation !== generation
    const closed = () => new Response('room is closed', { status: 410 })

    // The first upload under an id wins; receivers check the content anyway.
    if (await this.env.BLOBS.head(key)) return new Response(null, { status: 200 })
    if (ended()) return closed()

    // Reserve the quota before awaiting anything else, so concurrent uploads
    // cannot all squeeze in under it.
    const usage = this.usage()
    const quota = this.quota()
    if (usage.bytes + length > quota.bytes || usage.count + 1 > quota.count) {
      return new Response('room quota exceeded', { status: 429 })
    }
    this.setUsage({ bytes: usage.bytes + length, count: usage.count + 1 })
    try {
      const body = await request.arrayBuffer()
      if (body.byteLength !== length) throw new Error('body does not match Content-Length')
      await this.env.BLOBS.put(key, body)
    } catch {
      // A reservation of a session that ended was dropped with it.
      if (!ended()) {
        const now = this.usage()
        this.setUsage({ bytes: now.bytes - length, count: now.count - 1 })
      }
      return new Response('upload failed', { status: 400 })
    }
    // The session may have ended while we were uploading, and its cleanup may
    // have missed this blob.
    if (ended()) {
      await this.env.BLOBS.delete(key)
      return closed()
    }
    return new Response(null, { status: 201 })
  }

  // Deletion failures are left to the bucket's lifecycle rule.
  private async deleteBlobs(): Promise<void> {
    const prefix = this.blobPrefix()
    try {
      let cursor: string | undefined
      do {
        const page = await this.env.BLOBS.list({ prefix, cursor })
        if (page.objects.length > 0) await this.env.BLOBS.delete(page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    } catch (error) {
      console.error('failed to delete blobs', error)
    }
  }

  // The Durable Object id is derived from the room id, and only this room knows it.
  private blobPrefix(): string {
    return `rooms/${this.ctx.id.toString()}/`
  }

  private usage(): Usage {
    return this.ctx.storage.kv.get<Usage>(USAGE_KEY) ?? { bytes: 0, count: 0 }
  }

  private setUsage(usage: Usage): void {
    this.ctx.storage.kv.put(USAGE_KEY, usage)
  }

  private quota(): Usage {
    return {
      bytes: Number(this.env.BLOB_QUOTA_BYTES) || ROOM_BLOB_BYTES,
      count: Number(this.env.BLOB_QUOTA_COUNT) || ROOM_BLOB_COUNT,
    }
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Already closed.
  }
}
