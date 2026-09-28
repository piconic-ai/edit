import { Hono } from 'hono'
import { HOST_HEADER } from './room.ts'

export { Room } from './room.ts'

// Room ids are 128+ bits, base64url without padding.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/
// Blob ids are 128-bit HMACs, base64url without padding.
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * A room id is derived from its host token, so the Worker can tell the host
 * apart without storing anything: only whoever created the room knows a token
 * that hashes to its id.
 */
export async function roomIdFor(hostToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostToken))
  return base64url(new Uint8Array(digest)).slice(0, 22)
}

const app = new Hono<{ Bindings: Env }>()

app.post('/api/rooms', async (c) => {
  const hostToken = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return c.json({ id: await roomIdFor(hostToken), hostToken }, 201)
})

app.get('/api/rooms/:id/ws', async (c) => {
  const id = c.req.param('id')
  if (!ROOM_ID.test(id)) return c.text('invalid room id', 400)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected a WebSocket upgrade', 426)
  }

  // Never trust a role header coming from outside.
  const headers = new Headers(c.req.raw.headers)
  headers.delete(HOST_HEADER)
  const auth = c.req.header('Authorization')
  if (auth) {
    const token = /^Bearer (\S+)$/.exec(auth)?.[1]
    if (!token || (await roomIdFor(token)) !== id) return c.text('invalid host token', 403)
    headers.set(HOST_HEADER, '1')
  }

  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(new Request(c.req.raw, { headers }))
})

// Encrypted attachments, stored while the room's host is connected. Anyone in
// the room may read and write them, as they may join the WebSocket.
app.all('/api/rooms/:id/blobs/:blobId', async (c) => {
  const id = c.req.param('id')
  if (!ROOM_ID.test(id) || !BLOB_ID.test(c.req.param('blobId'))) {
    return c.text('invalid room or blob id', 400)
  }
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(c.req.raw)
})

export default app
