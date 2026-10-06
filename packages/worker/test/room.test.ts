import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { ADMISSION_HEADER, admissionProtocols } from '@pedit/protocol/admission'
import { describe, expect, it, vi } from 'vitest'
import { roomIdFor } from '../src/index.ts'
import {
  BLOB_OVERHEAD,
  BYTE_RATE,
  limits,
  MAX_MESSAGE_BYTES,
  MAX_PEERS,
  MAX_UPLOADS,
  MESSAGE_RATE,
  RATE_LIMITED,
  type Room as RoomObject,
} from '../src/room.ts'

const ROOM_CLOSED = 4001
const CLIENT_OUTDATED = 4002
const SERVER_OUTDATED = 4003
const ROOM_FULL = 4004
// The tests run with small limits (vitest.config.ts).
const { guests: GUESTS, blobBytes: BLOB_BYTES } = limits(env)

interface Room {
  id: string
  hostToken: string
  admission: string
}

const admissions = new Map<string, string>()

async function createRoom(): Promise<Room> {
  const res = await exports.default.fetch('https://pedit.test/api/rooms', { method: 'POST' })
  expect(res.status).toBe(201)
  const room = await res.json<Room>()
  room.admission = crypto.randomUUID().replaceAll('-', '') + 'A'.repeat(11)
  admissions.set(room.id, room.admission)
  return room
}

interface Peer {
  ws: WebSocket
  received: ArrayBuffer[]
  closed: Promise<CloseEvent>
}

function upgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://pedit.test/api/rooms/${id}/ws`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': admissionProtocols(admissions.get(id)!).join(', '),
      ...headers,
    },
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

/**
 * Stops the room's clock at 0 and returns a way to move it, so a test decides
 * how much the allowances refill however slowly its messages are relayed.
 */
async function stopClock(room: Room): Promise<(ms: number) => void> {
  let now = 0
  const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
  await runInDurableObject(stub, (instance: RoomObject) => {
    instance['now'] = () => now
  })
  return (ms) => {
    now += ms
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('rooms', () => {
  it('rejects keyless clients before they consume peer slots', async () => {
    const room = await createRoom()
    await host(room)
    for (let i = 0; i < MAX_PEERS + 1; i++) {
      expect((await upgrade(room.id, { 'Sec-WebSocket-Protocol': '' })).status).toBe(403)
    }
    const wrong = admissionProtocols('B'.repeat(43)).join(', ')
    expect((await upgrade(room.id, { 'Sec-WebSocket-Protocol': wrong })).status).toBe(403)
    expect(
      (await upgrade(room.id, { 'Sec-WebSocket-Protocol': wrong, 'X-Pedit-Host': '1' })).status,
    ).toBe(403)
    const valid = await upgrade(room.id)
    expect(valid.status).toBe(101)
    expect(valid.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v1')
    valid.webSocket?.accept()
    valid.webSocket?.close()
  })

  it('tells clients of another protocol version to update, before admission', async () => {
    const room = await createRoom()
    await host(room)
    const admission = admissionProtocols(admissions.get(room.id)!)[1]
    const old = await upgrade(room.id, { 'Sec-WebSocket-Protocol': `pedit-v0, ${admission}` })
    expect(old.status).toBe(101)
    expect(old.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v0')
    // A wrong admission makes no difference: the version is checked first.
    const newer = await connect(room.id, {
      'Sec-WebSocket-Protocol': `pedit-v2, pedit-admission.${'B'.repeat(43)}`,
    })
    expect((await newer.closed).code).toBe(SERVER_OUTDATED)
    const ws = old.webSocket!
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(CLIENT_OUTDATED)
    // Neither took a peer slot or registered anything.
    const guest = await connect(room.id)
    guest.ws.close()
  })

  it('only lets the host register admission and preserves it across hibernation', async () => {
    const room = await createRoom()
    const attacker = await connect(room.id, {
      'Sec-WebSocket-Protocol': admissionProtocols('B'.repeat(43)).join(', '),
    })
    expect((await attacker.closed).code).toBe(ROOM_CLOSED)
    await host(room)
    const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
    await evictDurableObject(stub)
    await connect(room.id)
    expect(
      (
        await upgrade(room.id, {
          'Sec-WebSocket-Protocol': admissionProtocols('B'.repeat(43)).join(', '),
        })
      ).status,
    ).toBe(403)
    // Even an authenticated host cannot change the token during this session.
    expect(
      (
        await upgrade(room.id, {
          Authorization: `Bearer ${room.hostToken}`,
          'Sec-WebSocket-Protocol': admissionProtocols('B'.repeat(43)).join(', '),
        })
      ).status,
    ).toBe(403)
  })

  it('issues unguessable room ids derived from the host token', async () => {
    const a = await createRoom()
    const b = await createRoom()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.id).toBe(await roomIdFor(a.hostToken))
    expect(a.id).not.toBe(b.id)
  })

  it('rejects malformed ids, plain requests and wrong host tokens', async () => {
    expect((await exports.default.fetch('https://pedit.test/api/rooms/nope/ws')).status).toBe(400)
    const room = await createRoom()
    expect((await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`)).status).toBe(
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
    const guest = await connect(room.id, { 'X-Pedit-Host': '1' })
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

  it('turns guests away once the room has as many as the relay allows', async () => {
    const room = await createRoom()
    await host(room)
    const first = await connect(room.id)
    for (let i = 1; i < GUESTS; i++) await connect(room.id)
    const late = await connect(room.id)
    const closed = await late.closed
    expect(closed.code).toBe(ROOM_FULL)
    expect(closed.reason).toBe('room is full')
    // The host is not a guest: a reconnecting host still gets in.
    const again = await host(room)
    expect(again.ws.readyState).toBe(WebSocket.OPEN)
    // Someone leaving frees their place.
    first.ws.close(1000, 'bye')
    await first.closed
    await vi.waitFor(async () => {
      const next = await connect(room.id)
      expect(next.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  it('caps the number of connections', async () => {
    const room = await createRoom()
    for (let i = 0; i < MAX_PEERS; i++) await host(room)
    expect((await (await host(room)).closed).code).toBe(ROOM_FULL)
  })

  it('reads its limits from the Worker vars, within the defaults', () => {
    expect(limits({})).toEqual({
      guests: MAX_PEERS - 1,
      blobBytes: 10 * 1024 * 1024,
      quotaBytes: 100 * 1024 * 1024,
      quotaCount: 500,
    })
    expect(limits({ ROOM_GUESTS: '100' }).guests).toBe(MAX_PEERS - 1)
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(limits({ ROOM_GUESTS: bad, BLOB_MAX_BYTES: bad }).guests).toBe(MAX_PEERS - 1)
      expect(limits({ BLOB_MAX_BYTES: bad }).blobBytes).toBe(10 * 1024 * 1024)
    }
  })

  it('closes a connection that sends too many messages', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await stopClock(room)
    for (let i = 0; i <= MESSAGE_RATE.burst; i++) guest.ws.send(new Uint8Array(1))
    expect((await guest.closed).code).toBe(RATE_LIMITED)
    // The burst itself was relayed, and nobody else was cut off.
    await until(() => h.received.length === MESSAGE_RATE.burst)
    expect(h.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('closes a connection that sends too many bytes', async () => {
    const room = await createRoom()
    await host(room)
    const guest = await connect(room.id)
    await stopClock(room)
    const big = new Uint8Array(MAX_MESSAGE_BYTES)
    for (let i = 0; i <= BYTE_RATE.burst / MAX_MESSAGE_BYTES; i++) guest.ws.send(big)
    expect((await guest.closed).code).toBe(RATE_LIMITED)
  })

  it('lets a steady sender keep going', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    const tick = await stopClock(room)
    // The whole burst, then a second's worth of messages each second. Each
    // batch is relayed before the clock moves, so it all counts against the
    // allowance at the time it was sent.
    const relayed = (n: number) =>
      vi.waitFor(() => expect(h.received.length).toBe(n), { timeout: 10_000 })
    for (let i = 0; i < MESSAGE_RATE.burst; i++) guest.ws.send(new Uint8Array(1))
    let total = MESSAGE_RATE.burst
    await relayed(total)
    for (let second = 0; second < 2; second++) {
      tick(1000)
      for (let i = 0; i < MESSAGE_RATE.perSecond; i++) guest.ws.send(new Uint8Array(1))
      total += MESSAGE_RATE.perSecond
      await relayed(total)
    }
    expect(guest.ws.readyState).toBe(WebSocket.OPEN)
  }, 30_000)
})

// A blob id: 22 base64url characters.
const blobId = (n: number) => `blob${String(n).padStart(18, '0')}`

function blobUrl(room: Room | string, id: string): string {
  return `https://pedit.test/api/rooms/${typeof room === 'string' ? room : room.id}/blobs/${id}`
}

const putBlob = (room: Room, id: string, body: Uint8Array<ArrayBuffer>) =>
  exports.default.fetch(blobUrl(room, id), {
    method: 'PUT',
    body,
    headers: { [ADMISSION_HEADER]: room.admission },
  })

const getBlob = (room: Room, id: string) =>
  exports.default.fetch(blobUrl(room, id), { headers: { [ADMISSION_HEADER]: room.admission } })

/** A PUT whose body arrives only when finish() is called. */
function slowPut(room: Room, id: string, size: number) {
  const { readable, writable } = new FixedLengthStream(size)
  const res = exports.default.fetch(blobUrl(room, id), {
    method: 'PUT',
    body: readable,
    headers: { [ADMISSION_HEADER]: room.admission },
  })
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
  it('rejects missing and wrong admission without consuming blob quota', async () => {
    const room = await createRoom()
    await host(room)
    for (const token of ['', 'B'.repeat(43)]) {
      for (let i = 0; i < 4; i++) {
        expect(
          (
            await exports.default.fetch(blobUrl(room, blobId(i)), {
              method: 'PUT',
              body: new Uint8Array(),
              headers: { [ADMISSION_HEADER]: token, 'X-Pedit-Host': '1' },
            })
          ).status,
        ).toBe(403)
      }
      expect(
        (
          await exports.default.fetch(blobUrl(room, blobId(0)), {
            headers: { [ADMISSION_HEADER]: token },
          })
        ).status,
      ).toBe(403)
    }
    expect(await roomBlobs(room)).toEqual([])
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
    expect((await getBlob(room, blobId(1))).status).toBe(200)
  })

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
    const del = await exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'DELETE',
      headers: { [ADMISSION_HEADER]: room.admission },
    })
    expect(del.status).toBe(405)
    const big = await putBlob(room, blobId(1), new Uint8Array(BLOB_BYTES + BLOB_OVERHEAD + 1))
    expect(big.status).toBe(413)
    const fits = await putBlob(room, blobId(2), new Uint8Array(BLOB_BYTES))
    expect(fits.status).toBe(201)
    // A stream of unknown length is sent without Content-Length.
    const { readable, writable } = new TransformStream()
    const unsized = exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'PUT',
      headers: { [ADMISSION_HEADER]: room.admission },
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

  it('takes only a few uploads at once', async () => {
    const room = await createRoom()
    await host(room)
    const slow = Array.from({ length: MAX_UPLOADS }, (_, i) => slowPut(room, blobId(i), 4))
    // Wait for every slow upload to reach the room, looking inside it: any
    // probe from outside would take an upload slot itself.
    const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
    await vi.waitFor(() =>
      runInDurableObject(stub, (instance: RoomObject) =>
        expect(instance['uploading'].size).toBe(MAX_UPLOADS),
      ),
    )
    const busy = await putBlob(room, blobId(MAX_UPLOADS), new Uint8Array(4))
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBe('1')
    for (const upload of slow) expect((await upload.finish()).status).toBe(201)
    expect((await putBlob(room, blobId(MAX_UPLOADS), new Uint8Array(4))).status).toBe(201)
  })

  it('waits out every cleanup before serving a new session', async () => {
    const room = await createRoom()
    const first = await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    // Two sessions end back to back; each chains a cleanup.
    first.ws.close(1000, 'bye')
    const second = await host(room)
    second.ws.close(1000, 'bye')
    await host(room)
    const res = await getBlob(room, blobId(1))
    expect(res.status).toBe(404)
    expect(await roomBlobs(room)).toEqual([])
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
    // The tests run with a quota of 100 bytes and 5 blobs (vitest.config.ts).
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
    expect((await putBlob(room, blobId(2), new Uint8Array(20))).status).toBe(429)
    expect((await putBlob(room, blobId(3), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(4), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(5), new Uint8Array(0))).status).toBe(201)
    expect((await putBlob(room, blobId(6), new Uint8Array(0))).status).toBe(201)
    expect((await putBlob(room, blobId(7), new Uint8Array(0))).status).toBe(429)
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
