/**
 * WebSocket close code sent to everyone in a room when its host leaves.
 * Clients must not reconnect on it: the session is over.
 */
export const ROOM_CLOSED = 4001

/**
 * WebSocket close code for a client that speaks an older protocol version
 * than the server. Clients must not reconnect on it: the client has to be
 * updated (or the page reloaded) first.
 */
export const CLIENT_OUTDATED = 4002

/**
 * WebSocket close code for a client that speaks a newer protocol version than
 * the server. Clients must not reconnect on it: the server has to be updated.
 */
export const SERVER_OUTDATED = 4003
