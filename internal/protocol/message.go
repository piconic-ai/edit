package protocol

import (
	"errors"
	"fmt"
)

type MessageType byte

const (
	MessageSync       MessageType = 0
	MessageAwareness  MessageType = 1
	MessageAttachment MessageType = 2
	MessageCanvas     MessageType = 3
)

// RoomClosed is the WebSocket close code sent to everyone in a room when its
// host leaves. Clients must not reconnect on it: the session is over.
const RoomClosed = 4001

// ClientOutdated is the WebSocket close code for a client that speaks an older
// protocol version than the server. Clients must not reconnect on it: pedit
// has to be updated first.
const ClientOutdated = 4002

// ServerOutdated is the WebSocket close code for a client that speaks a newer
// protocol version than the server. Clients must not reconnect on it: the
// server has to be updated.
const ServerOutdated = 4003

// RoomFull is the WebSocket close code sent to a guest who tries to join a
// room that already has as many guests as the relay allows. Clients must not
// reconnect on it by themselves: the room stays full until someone leaves.
const RoomFull = 4004

// RelayBusy is the WebSocket close code for a connection the relay turns away
// because too many came from the same network just now. Clients reconnect, but
// wait longer than after a dropped connection.
const RelayBusy = 4005

// ErrUnknownMessageType marks a message type this version does not know, from
// a newer peer. Clients skip such messages instead of reporting them.
var ErrUnknownMessageType = errors.New("unknown message type")

// EncodeMessage prefixes a payload with a one-byte message type.
func EncodeMessage(t MessageType, payload []byte) []byte {
	out := make([]byte, 1+len(payload))
	out[0] = byte(t)
	copy(out[1:], payload)
	return out
}

func DecodeMessage(data []byte) (MessageType, []byte, error) {
	if len(data) == 0 {
		return 0, nil, fmt.Errorf("empty message")
	}
	t := MessageType(data[0])
	switch t {
	case MessageSync, MessageAwareness, MessageAttachment, MessageCanvas:
		return t, data[1:], nil
	}
	return 0, nil, fmt.Errorf("%w: %d", ErrUnknownMessageType, data[0])
}
