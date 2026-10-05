import { ROOM_CLOSED } from './close.ts'
import type { SocketLike } from './room.ts'

export interface RelayOptions {
  /**
   * Behave like the real Room: a socket that sent an Authorization header is the
   * host, guests are turned away while no host is connected, and everyone is
   * disconnected with ROOM_CLOSED when the last host leaves.
   */
  hosted?: boolean
}

/** An in-memory stand-in for the Worker: relays every frame to all other sockets. */
export class Relay {
  sockets = new Set<FakeSocket>()
  frames: Uint8Array[] = []
  urls: string[] = []
  headers: (Record<string, string> | undefined)[] = []
  protocols: (string[] | undefined)[] = []

  constructor(readonly opts: RelayOptions = {}) {}

  create = (url: string, headers?: Record<string, string>, protocols?: string[]): SocketLike => {
    this.urls.push(url)
    this.headers.push(headers)
    this.protocols.push(protocols)
    const socket = new FakeSocket(this, Boolean(headers?.Authorization))
    this.sockets.add(socket)
    queueMicrotask(() => {
      if (this.opts.hosted && !socket.isHost && !this.hasHost()) {
        socket.close(ROOM_CLOSED)
        return
      }
      socket.readyState = 1
      socket.onopen?.({})
    })
    return socket
  }

  hasHost(except?: FakeSocket): boolean {
    return [...this.sockets].some((s) => s.isHost && s !== except && s.readyState !== 3)
  }

  /** Called by a socket as it closes. */
  left(socket: FakeSocket): void {
    this.sockets.delete(socket)
    if (this.opts.hosted && socket.isHost && !this.hasHost()) {
      for (const peer of this.sockets) peer.close(ROOM_CLOSED)
    }
  }
}

export class FakeSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(
    private relay: Relay,
    readonly isHost: boolean,
  ) {}
  send(data: Uint8Array) {
    this.relay.frames.push(data)
    for (const peer of this.relay.sockets) {
      if (peer !== this && peer.readyState === 1) {
        const copy = data.slice().buffer
        queueMicrotask(() => peer.onmessage?.({ data: copy }))
      }
    }
  }
  close(code?: number) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay.left(this)
    queueMicrotask(() => this.onclose?.({ code }))
  }
}
