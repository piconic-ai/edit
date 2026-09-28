import {
  type Attachment,
  type BlobKeys,
  blobIdFor,
  contentHash,
  encryptBlob,
  type RoomStatus,
} from '@ima/protocol'
import { ImageError, prepareImage, type Shrink } from './image.ts'
import { Store } from './store.ts'

/** What the host's ima says about saving images, from its awareness state. */
export interface HostAttachments {
  /** The directory, beside the shared file, that links point into. */
  dir: string
  maxBytes: number
}

/** The server's cap on one attachment; the host may ask for less. */
export const MAX_BYTES = 10 * 1024 * 1024

type State = { [key: string]: unknown }

/**
 * Whether the host saves images, and where. Hosts before attachments say
 * nothing, and then nobody can add images.
 */
export function hostAttachments(states: Map<number, State>): HostAttachments | null {
  for (const state of states.values()) {
    if (state.role !== 'host') continue
    const a = state.attachments as { dir?: unknown; maxBytes?: unknown } | undefined
    if (!a || typeof a.dir !== 'string' || !/^[A-Za-z0-9._-]+$/.test(a.dir)) return null
    if (typeof a.maxBytes !== 'number' || !(a.maxBytes > 0)) return null
    return { dir: a.dir, maxBytes: Math.min(a.maxBytes, MAX_BYTES) }
  }
  return null
}

/**
 * Why images cannot be added right now, or null when they can. Before the
 * host's awareness state arrives, and while reconnecting, its absence says
 * nothing about its version.
 */
export function whyNoImages(
  status: RoomStatus,
  hostHere: boolean,
  host: HostAttachments | null,
): string | null {
  if (status === 'closed') return 'The session has ended.'
  if (status !== 'connected' || !hostHere) return 'Connecting to the host. Try again in a moment.'
  if (!host) return "The host's ima is too old to save images."
  return null
}

/** A reason an image was not added, worded for the person who added it. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

const MESSAGES = {
  unsupported: "The host's ima is too old to save images.",
  type: 'Only PNG, JPEG, GIF and WebP images can be added.',
  too_large: 'The image is too large to add.',
  unreadable: 'The image could not be read.',
  quota: 'This session cannot take more images.',
  closed: 'The session has ended.',
  failed: 'The image could not be uploaded. Try again.',
  timeout: 'The host did not answer, so the image was not added.',
  refused: 'The host could not save the image.',
} as const

// Reasons the host gives in `rejected` messages.
const REJECTED: Record<string, keyof typeof MESSAGES> = {
  type: 'type',
  too_large: 'too_large',
  quota: 'quota',
}

export interface AttachmentsOptions {
  roomId: string
  keys: BlobKeys
  /** Sends an attachment message to the room. */
  send: (attachment: Attachment) => void
  fetch?: typeof fetch
  shrink?: Shrink
  /** How long to wait for the host to save an upload. */
  storedTimeoutMs?: number
  /** How long to wait before retrying an upload someone else is making. */
  retryDelayMs?: number
}

interface Pending {
  mime: string
  promise: Promise<string>
  resolve: (path: string) => void
  reject: (error: AttachmentError) => void
}

const RETRIES = 5

/**
 * Adds images to the room: uploads them encrypted, tells the room, and waits
 * for the host to save them. Only then does the link go into the document,
 * so it never points at a file that is not there.
 */
export class Attachments {
  /** Images being added right now. */
  readonly uploading = new Store(0)
  /** Set from the host's awareness state; null while it does not save images. */
  host: HostAttachments | null = null

  #opts: AttachmentsOptions
  #fetch: typeof fetch
  #pending = new Map<string, Pending>()

  constructor(opts: AttachmentsOptions) {
    this.#opts = opts
    this.#fetch = opts.fetch ?? ((...args) => fetch(...args))
  }

  /** Adds an image; resolves with its path relative to the shared file. */
  async upload(file: Blob): Promise<string> {
    this.uploading.set(this.uploading.get() + 1)
    try {
      return await this.#upload(file)
    } finally {
      this.uploading.set(this.uploading.get() - 1)
    }
  }

  /** Handles an attachment message from the room. */
  handle(attachment: Attachment): void {
    if (attachment.kind === 'stored') {
      this.#pending.get(attachment.hash)?.resolve(attachment.path)
    } else if (attachment.kind === 'rejected') {
      const reason = REJECTED[attachment.reason] ?? 'refused'
      this.#pending.get(attachment.hash)?.reject(new AttachmentError(MESSAGES[reason]))
    }
  }

  /** Frames sent while disconnected are lost: announce what still waits. */
  reconnected(): void {
    for (const [hash, p] of this.#pending) {
      this.#opts.send({ kind: 'announce', hash, mime: p.mime })
    }
  }

  async #upload(file: Blob): Promise<string> {
    const host = this.host
    if (!host) throw new AttachmentError(MESSAGES.unsupported)
    let image: Awaited<ReturnType<typeof prepareImage>>
    try {
      image = await prepareImage(
        new Uint8Array(await file.arrayBuffer()),
        host.maxBytes,
        this.#opts.shrink,
      )
    } catch (error) {
      if (error instanceof ImageError) throw new AttachmentError(MESSAGES[error.reason])
      throw error
    }
    const hash = await contentHash(image.bytes)
    const waiting = this.#pending.get(hash)
    if (waiting) return waiting.promise
    await this.#put(hash, await encryptBlob(this.#opts.keys, image.bytes))
    // Another upload of the same image may have got here first.
    const announced = this.#pending.get(hash)
    if (announced) return announced.promise
    return this.#announce(hash, image.type)
  }

  async #put(hash: string, body: Uint8Array): Promise<void> {
    const url = `/api/rooms/${this.#opts.roomId}/blobs/${await blobIdFor(this.#opts.keys, hash)}`
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.#fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer> })
      } catch {
        throw new AttachmentError(MESSAGES.failed)
      }
      if (res.ok) return
      // Someone is uploading the same image right now.
      if (res.status === 409 && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, this.#opts.retryDelayMs ?? 500))
        continue
      }
      if (res.status === 410) throw new AttachmentError(MESSAGES.closed)
      if (res.status === 413) throw new AttachmentError(MESSAGES.too_large)
      if (res.status === 429) throw new AttachmentError(MESSAGES.quota)
      throw new AttachmentError(MESSAGES.failed)
    }
  }

  #announce(hash: string, mime: string): Promise<string> {
    let resolve!: (path: string) => void
    let reject!: (error: AttachmentError) => void
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(
      () => reject(new AttachmentError(MESSAGES.timeout)),
      this.#opts.storedTimeoutMs ?? 30_000,
    )
    const done = () => {
      clearTimeout(timer)
      if (this.#pending.get(hash)?.promise === promise) this.#pending.delete(hash)
    }
    promise.then(done, done)
    this.#pending.set(hash, { mime, promise, resolve, reject })
    this.#opts.send({ kind: 'announce', hash, mime })
    return promise
  }
}
