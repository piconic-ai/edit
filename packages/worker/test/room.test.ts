import { env, exports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { roomIdFor } from '../src/index.ts'
import { MAX_BLOB_BYTES, MAX_MESSAGE_BYTES, MAX_PEERS } from '../src/room.ts'

const ROOM_CLOSED = 4001

interface Room {
  id: string
  hostToken: string
}

async function createRoom(): Promise<Room> {
  const res = await exports.default.fetch('https://ima.test/api/rooms', { method: 'POST' })
  expect(res.status).toBe(201)
  return res.json<Room>()
}

interface Peer {
  ws: WebSocket
  received: ArrayBuffer[]
  closed: Promise<CloseEvent>
}

function upgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://ima.test/api/rooms/${id}/ws`, {
    headers: { Upgrade: 'websocket', ...headers },
  })
}

async function connect(id: string, headers: Record<string, string> = {}): Promise<Peer> {
  const res = await upgrade(id, headers)
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('no websocket')
  const received: ArrayBuffer[] = []
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) received.push(ev.data)
  })
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return { ws, received, closed }
}

const host = (room: Room) => connect(room.id, { Authorization: `Bearer ${room.hostToken}` })

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('rooms', () => {
  it('issues unguessable room ids derived from the host token', async () => {
    const a = await createRoom()
    const b = await createRoom()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.id).toBe(await roomIdFor(a.hostToken))
    expect(a.id).not.toBe(b.id)
  })

  it('rejects malformed ids, plain requests and wrong host tokens', async () => {
    expect((await exports.default.fetch('https://ima.test/api/rooms/nope/ws')).status).toBe(400)
    const room = await createRoom()
    expect((await exports.default.fetch(`https://ima.test/api/rooms/${room.id}/ws`)).status).toBe(
      426,
    )
    const other = await createRoom()
    const res = await upgrade(room.id, { Authorization: `Bearer ${other.hostToken}` })
    expect(res.status).toBe(403)
  })

  it('relays binary frames to everyone but the sender', async () => {
    const room = await createRoom()
    const a = await host(room)
    const b = await connect(room.id)
    const c = await connect(room.id)
    a.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => b.received.length === 1 && c.received.length === 1)
    expect([...new Uint8Array(b.received[0] ?? new ArrayBuffer(0))]).toEqual([1, 2, 3])
    expect(a.received).toHaveLength(0)
    b.ws.send(new Uint8Array([4]))
    await until(() => a.received.length === 1)
  })

  it('keeps rooms isolated', async () => {
    const one = await createRoom()
    const two = await createRoom()
    const a = await host(one)
    const other = await host(two)
    const b = await connect(two.id)
    a.ws.send(new Uint8Array([9]))
    await new Promise((r) => setTimeout(r, 50))
    expect(other.received).toHaveLength(0)
    expect(b.received).toHaveLength(0)
  })

  it('turns guests away while there is no host', async () => {
    const room = await createRoom()
    const guest = await connect(room.id)
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('ignores a role header sent by a client', async () => {
    const room = await createRoom()
    const guest = await connect(room.id, { 'X-Ima-Host': '1' })
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('closes the room for everyone when the host leaves', async () => {
    const room = await createRoom()
    const h = await host(room)
    const a = await connect(room.id)
    const b = await connect(room.id)
    h.ws.close(1000, 'bye')
    expect((await a.closed).code).toBe(ROOM_CLOSED)
    expect((await b.closed).code).toBe(ROOM_CLOSED)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
  })

  it('stays open while a reconnected host is still there', async () => {
    const room = await createRoom()
    const stale = await host(room)
    await host(room)
    const guest = await connect(room.id)
    stale.ws.close(1000, 'replaced')
    await new Promise((r) => setTimeout(r, 50))
    guest.ws.send(new Uint8Array([1]))
    const closedEarly = await Promise.race([
      guest.closed.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 50)),
    ])
    expect(closedEarly).toBe(false)
  })

  it('closes sockets that send text or oversized frames', async () => {
    const room = await createRoom()
    await host(room)
    const text = await connect(room.id)
    text.ws.send('hello')
    expect((await text.closed).code).toBe(1003)

    const big = await connect(room.id)
    big.ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))
    expect((await big.closed).code).toBe(1009)
  })

  it('caps the number of peers', async () => {
    const room = await createRoom()
    await host(room)
    for (let i = 1; i < MAX_PEERS; i++) await connect(room.id)
    expect((await upgrade(room.id)).status).toBe(429)
  })
})

// A blob id: 22 base64url characters.
const blobId = (n: number) => `blob${String(n).padStart(18, '0')}`

function blobUrl(room: Room | string, id: string): string {
  return `https://ima.test/api/rooms/${typeof room === 'string' ? room : room.id}/blobs/${id}`
}

const putBlob = (room: Room, id: string, body: Uint8Array<ArrayBuffer>) =>
  exports.default.fetch(blobUrl(room, id), { method: 'PUT', body })

const getBlob = (room: Room, id: string) => exports.default.fetch(blobUrl(room, id))

/** A PUT whose body arrives only when finish() is called. */
function slowPut(room: Room, id: string, size: number) {
  const { readable, writable } = new FixedLengthStream(size)
  const res = exports.default.fetch(blobUrl(room, id), { method: 'PUT', body: readable })
  return {
    // Give the request time to reach the room and claim the id.
    started: () => new Promise((r) => setTimeout(r, 50)),
    finish: async () => {
      const writer = writable.getWriter()
      await writer.write(new Uint8Array(size))
      await writer.close()
      return res
    },
  }
}

// Blobs live under the room's Durable Object id.
async function roomBlobs(room: Room): Promise<string[]> {
  const prefix = `rooms/${env.ROOM.idFromName(room.id).toString()}/`
  return (await env.BLOBS.list({ prefix })).objects.map((o) => o.key)
}

describe('blobs', () => {
  it('stores and serves blobs while the host is connected', async () => {
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array([1, 2, 3]))).status).toBe(201)
    const res = await getBlob(room, blobId(1))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Cache-Control')).toContain('private')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3])
    expect((await getBlob(room, blobId(2))).status).toBe(404)
  })

  it('keeps the first upload under an id', async () => {
    const room = await createRoom()
    await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    expect((await putBlob(room, blobId(1), new Uint8Array([2]))).status).toBe(200)
    const res = await getBlob(room, blobId(1))
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1])
  })

  it('keeps rooms apart', async () => {
    const one = await createRoom()
    const two = await createRoom()
    await host(one)
    await host(two)
    await putBlob(one, blobId(1), new Uint8Array([1]))
    expect((await getBlob(two, blobId(1))).status).toBe(404)
  })

  it('refuses blobs while there is no host', async () => {
    const room = await createRoom()
    expect((await putBlob(room, blobId(1), new Uint8Array([1]))).status).toBe(410)
    expect((await getBlob(room, blobId(1))).status).toBe(410)
  })

  it('rejects malformed ids, other methods and oversized blobs', async () => {
    const room = await createRoom()
    await host(room)
    expect((await exports.default.fetch(blobUrl(room, 'short'))).status).toBe(400)
    expect((await exports.default.fetch(blobUrl('nope', blobId(1)))).status).toBe(400)
    const del = await exports.default.fetch(blobUrl(room, blobId(1)), { method: 'DELETE' })
    expect(del.status).toBe(405)
    const big = await putBlob(room, blobId(1), new Uint8Array(MAX_BLOB_BYTES + 1))
    expect(big.status).toBe(413)
    // A stream of unknown length is sent without Content-Length.
    const { readable, writable } = new TransformStream()
    const unsized = exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'PUT',
      body: readable,
    })
    await writable.close()
    expect((await unsized).status).toBe(411)
  })

  it('refuses a second upload of an id while the first is in flight', async () => {
    const room = await createRoom()
    await host(room)
    const first = slowPut(room, blobId(1), 4)
    await first.started()
    expect((await putBlob(room, blobId(1), new Uint8Array(4))).status).toBe(409)
    expect((await first.finish()).status).toBe(201)
    expect((await putBlob(room, blobId(1), new Uint8Array(4))).status).toBe(200)
  })

  it('drops an upload that outlives its session', async () => {
    const room = await createRoom()
    const h = await host(room)
    const upload = slowPut(room, blobId(1), 90)
    await upload.started()
    h.ws.close(1000, 'bye')
    await new Promise((r) => setTimeout(r, 50))
    await host(room)
    expect((await upload.finish()).status).toBe(410)
    expect(await roomBlobs(room)).toEqual([])
    // The ended session's reservation does not count against the new one.
    expect((await putBlob(room, blobId(2), new Uint8Array(90))).status).toBe(201)
  })

  it('enforces the room quota', async () => {
    // The tests run with a quota of 100 bytes and 3 blobs (vitest.config.ts).
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
    expect((await putBlob(room, blobId(2), new Uint8Array(20))).status).toBe(429)
    expect((await putBlob(room, blobId(3), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(4), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(5), new Uint8Array(0))).status).toBe(429)
    // A repeated upload is free.
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(200)
  })

  it('deletes the blobs and the quota when the host leaves', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    await putBlob(room, blobId(2), new Uint8Array([2]))
    expect(await roomBlobs(room)).toHaveLength(2)

    h.ws.close(1000, 'bye')
    await guest.closed
    await vi.waitFor(async () => expect(await roomBlobs(room)).toEqual([]))
    expect((await getBlob(room, blobId(1))).status).toBe(410)

    // The next session starts with a fresh quota.
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
  })
})
