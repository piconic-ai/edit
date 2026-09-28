import {
  type Attachment,
  blobIdFor,
  contentHash,
  decryptBlob,
  deriveBlobKeys,
  generateKey,
} from '@ima/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentError,
  Attachments,
  type AttachmentsOptions,
  hostAttachments,
  MAX_BYTES,
  whyNoImages,
} from '../src/attachments.ts'

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA'
// A PNG with a text chunk that must not reach the room.
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...[0, 0, 0, 2],
  ...[0x74, 0x45, 0x58, 0x74],
  0x68,
  0x69,
  ...[0, 0, 0, 0], // tEXt "hi"
  ...[0, 0, 0, 0],
  ...[0x49, 0x45, 0x4e, 0x44],
  ...[0, 0, 0, 0], // IEND
])
const STRIPPED = new Uint8Array([...PNG.subarray(0, 8), ...PNG.subarray(22)])

async function setup(statuses: number[] = [201], opts: Partial<AttachmentsOptions> = {}) {
  const keys = await deriveBlobKeys(generateKey())
  const sent: Attachment[] = []
  const requests: { url: string; body: Uint8Array }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body as Uint8Array })
    return new Response(null, { status: statuses.shift() ?? 201 })
  })
  const attachments = new Attachments({
    roomId: ROOM,
    keys,
    send: (a) => sent.push(a),
    fetch: fetch as typeof globalThis.fetch,
    retryDelayMs: 1,
    ...opts,
  })
  attachments.host = { dir: 'assets', maxBytes: 1000 }
  // Answers every announcement like a host that saves images.
  const store = () => {
    for (const a of sent.splice(0)) {
      if (a.kind === 'announce') {
        attachments.handle({ kind: 'stored', hash: a.hash, path: `assets/${a.hash}.png` })
      }
    }
  }
  return { keys, sent, requests, attachments, store }
}

const file = (bytes: Uint8Array = PNG) => new Blob([bytes as Uint8Array<ArrayBuffer>])

describe('Attachments', () => {
  it('uploads the stripped image encrypted, announces it, and waits for the host', async () => {
    const { keys, sent, requests, attachments } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const hash = await contentHash(STRIPPED)
    expect(sent[0]).toEqual({ kind: 'announce', hash, mime: 'image/png' })
    expect(requests[0]?.url).toBe(`/api/rooms/${ROOM}/blobs/${await blobIdFor(keys, hash)}`)
    expect(await decryptBlob(keys, requests[0]?.body as Uint8Array, hash)).toEqual(STRIPPED)
    expect(attachments.uploading.get()).toBe(1)

    attachments.handle({ kind: 'stored', hash, path: `assets/${hash}.png` })
    expect(await upload).toBe(`assets/${hash}.png`)
    expect(attachments.uploading.get()).toBe(0)
  })

  it('needs a host that saves images', async () => {
    const { attachments } = await setup()
    attachments.host = null
    await expect(attachments.upload(file())).rejects.toThrow(/too old/)
  })

  it('refuses what is not an image', async () => {
    const { attachments, requests } = await setup()
    const svg = new TextEncoder().encode('<svg/>')
    await expect(attachments.upload(file(svg))).rejects.toThrow(/Only PNG, JPEG, GIF and WebP/)
    expect(requests).toHaveLength(0)
  })

  it('waits out someone uploading the same image', async () => {
    const { attachments, requests, store } = await setup([409, 409, 201])
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    store()
    await expect(upload).resolves.toMatch(/^assets\//)
  })

  it.each([
    [410, /ended/],
    [413, /too large/],
    [429, /cannot take more/],
    [500, /could not be uploaded/],
  ])('explains a %i from the server', async (status, message) => {
    const { attachments, sent } = await setup([status])
    await expect(attachments.upload(file())).rejects.toThrow(message)
    expect(sent).toHaveLength(0)
  })

  it('explains why the host refused', async () => {
    const { attachments, sent } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'rejected', hash, reason: 'quota' })
    await expect(upload).rejects.toThrow(AttachmentError)
    await expect(upload).rejects.toThrow(/cannot take more/)
  })

  it('gives up when the host does not answer', async () => {
    const { attachments } = await setup([201], { storedTimeoutMs: 20 })
    await expect(attachments.upload(file())).rejects.toThrow(/did not answer/)
    expect(attachments.uploading.get()).toBe(0)
  })

  it('announces again after reconnecting', async () => {
    const { attachments, sent } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    attachments.reconnected()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'stored', hash, path: 'assets/x.png' })
    await upload
    sent.length = 0
    attachments.reconnected()
    expect(sent).toHaveLength(0)
  })

  it('adds the same image twice at once', async () => {
    const { attachments, sent } = await setup([201, 201])
    const first = attachments.upload(file())
    const second = attachments.upload(file())
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    // One announcement, answered once, settles both.
    expect(sent).toHaveLength(1)
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'stored', hash, path: `assets/${hash}.png` })
    expect(await Promise.all([first, second])).toEqual([`assets/${hash}.png`, `assets/${hash}.png`])
  })

  it('ignores answers about other images', async () => {
    const { attachments } = await setup()
    attachments.handle({ kind: 'stored', hash: '0'.repeat(32), path: 'assets/x.png' })
    attachments.handle({ kind: 'rejected', hash: '0'.repeat(32), reason: 'type' })
  })
})

describe('whyNoImages', () => {
  const host = { dir: 'assets', maxBytes: 1000 }

  it('lets images in only with a host that saves them, in an open room', () => {
    expect(whyNoImages('connected', true, host)).toBeNull()
    expect(whyNoImages('closed', true, host)).toMatch(/ended/)
    expect(whyNoImages('connected', true, null)).toMatch(/too old/)
  })

  it('does not blame the host before hearing from it', () => {
    for (const [status, hostHere] of [
      ['connecting', false],
      ['disconnected', true],
      ['connected', false],
    ] as const) {
      expect(whyNoImages(status, hostHere, null)).toMatch(/Connecting to the host/)
    }
  })
})

describe('hostAttachments', () => {
  const states = (...list: Record<string, unknown>[]) => new Map(list.map((s, i) => [i, s]))

  it('reads what the host says', () => {
    expect(
      hostAttachments(
        states({ name: 'guest' }, { role: 'host', attachments: { dir: 'assets', maxBytes: 500 } }),
      ),
    ).toEqual({ dir: 'assets', maxBytes: 500 })
  })

  it('caps the size at what the server takes', () => {
    const got = hostAttachments(states({ role: 'host', attachments: { dir: 'a', maxBytes: 1e12 } }))
    expect(got?.maxBytes).toBe(MAX_BYTES)
  })

  it('is null for older hosts and odd values', () => {
    expect(hostAttachments(states({ role: 'host' }))).toBeNull()
    expect(hostAttachments(states({ name: 'guest' }))).toBeNull()
    for (const attachments of [
      { dir: '../x', maxBytes: 1 },
      { dir: 'a b', maxBytes: 1 },
      { dir: 'assets', maxBytes: 0 },
      { dir: 'assets', maxBytes: '1' },
    ]) {
      expect(hostAttachments(states({ role: 'host', attachments }))).toBeNull()
    }
  })
})
