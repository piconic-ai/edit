/**
 * WebSocket close code sent to everyone in a room when its host leaves.
 * Clients must not reconnect on it: the session is over.
 */
export const ROOM_CLOSED = 4001

/**
 * WebSocket close code sent to a guest who tries to join a room that already
 * has as many guests as the relay allows. Clients must not reconnect on it by
 * themselves: the room stays full until someone leaves.
 */
export const ROOM_FULL = 4002
