package protocol

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// Status is the connection state of a Client. StatusClosed is final: the host
// ended the session.
type Status string

// errDestroyed ends the connection loop when the Client was destroyed mid-dial.
var errDestroyed = errors.New("client destroyed")

const (
	StatusConnecting   Status = "connecting"
	StatusConnected    Status = "connected"
	StatusDisconnected Status = "disconnected"
	StatusClosed       Status = "closed"
)

type ClientOptions struct {
	// URL is the WebSocket URL of the room. It must never contain the key.
	URL       string
	Key       []byte
	Doc       *crdt.Doc
	Awareness *awareness.Awareness
	// Header holds extra handshake headers.
	Header     http.Header
	Dial       Dialer
	MinBackoff time.Duration
	MaxBackoff time.Duration
	OnStatus   func(Status)
	OnError    func(error)
	// OnSynced is called once, on the connection's read loop, when the first
	// SyncStep2 from a peer has been applied: the doc now holds what the room
	// had. Return quickly.
	OnSynced func()
	// OnAttachment is called with each attachment message from the room, on
	// the connection's read loop: return quickly.
	OnAttachment func(Attachment)
	// OnCanvas is called with each canvas message from the room, on the
	// connection's read loop: return quickly.
	OnCanvas func(CanvasMessage)
}

// Client keeps a Doc and Awareness in sync with every other peer in a room.
//
// The server is a dumb relay, so the peers run a symmetric protocol: on connect a
// peer sends SyncStep1 (to pull what it is missing), its full state as SyncStep2
// (to push what others are missing) and its awareness state. Every peer answers
// SyncStep1 with SyncStep2. All frames are end-to-end encrypted.
//
// Changes applied from the room carry the Client as their origin.
type Client struct {
	opts   ClientOptions
	cipher *Cipher
	doc    *crdt.Doc
	aw     *awareness.Awareness

	// applying serializes applying remote updates with Do.
	applying sync.Mutex

	mu        sync.Mutex
	status    Status
	out       *outbox
	started   bool
	destroyed bool
	synced    bool
	unsubs    []func()

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func NewClient(opts ClientOptions) (*Client, error) {
	cipher, err := NewCipher(opts.Key)
	if err != nil {
		return nil, err
	}
	if opts.Dial == nil {
		opts.Dial = DialWebSocket
	}
	if opts.MinBackoff == 0 {
		opts.MinBackoff = 500 * time.Millisecond
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		opts:   opts,
		cipher: cipher,
		doc:    opts.Doc,
		aw:     opts.Awareness,
		status: StatusDisconnected,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	c.unsubs = []func(){
		c.doc.OnUpdate(c.handleDocUpdate),
		c.aw.OnUpdate(c.handleAwarenessUpdate),
		c.aw.OnChange(c.handleAwarenessChange),
	}
	return c, nil
}

// Status returns the current connection state.
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// Connect starts connecting (and reconnecting) in the background.
func (c *Client) Connect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started || c.destroyed {
		return
	}
	c.started = true
	go c.run()
}

// Do runs fn while no remote update is being applied, so fn can read the
// document and then change it without a remote edit slipping in between.
func (c *Client) Do(fn func()) {
	c.applying.Lock()
	defer c.applying.Unlock()
	fn()
}

// Destroy announces departure, closes the connection and stops reconnecting.
func (c *Client) Destroy() {
	c.mu.Lock()
	if c.destroyed {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()

	// Queued on the current connection by handleAwarenessUpdate.
	c.aw.SetLocalState(nil)

	c.mu.Lock()
	c.destroyed = true
	out := c.out
	c.out = nil
	started := c.started
	c.mu.Unlock()

	for _, unsub := range c.unsubs {
		unsub()
	}
	if out != nil {
		out.drain()
	}
	c.cancel()
	if out != nil {
		_ = out.conn.Close()
	}
	if started {
		<-c.done
	}
	c.setStatus(StatusDisconnected)
}

func (c *Client) run() {
	defer close(c.done)
	attempts := 0
	for {
		c.setStatus(StatusConnecting)
		conn, err := c.opts.Dial(c.ctx, c.opts.URL, c.opts.Header)
		if err == nil {
			attempts = 0
			err = c.serve(conn)
		}
		if c.ctx.Err() != nil || errors.Is(err, errDestroyed) {
			return
		}
		c.dropRemoteAwareness()
		if closeCode(err) == RoomClosed {
			c.setStatus(StatusClosed)
			return
		}
		c.onError(err)
		c.setStatus(StatusDisconnected)

		backoff := min(c.opts.MaxBackoff, c.opts.MinBackoff<<min(attempts, 16))
		delay := time.Duration(float64(backoff) * (0.5 + rand.Float64()/2))
		attempts++
		select {
		case <-time.After(delay):
		case <-c.ctx.Done():
			return
		}
	}
}

// serve runs one connection until it fails.
func (c *Client) serve(conn Conn) error {
	out := newOutbox(conn)
	c.mu.Lock()
	if c.destroyed {
		c.mu.Unlock()
		out.stop()
		_ = conn.Close()
		return errDestroyed
	}
	c.out = out
	c.mu.Unlock()
	c.setStatus(StatusConnected)

	c.send(MessageSync, ysync.EncodeSyncStep1(c.doc))
	step2 := encoding.NewEncoder()
	step2.WriteVarUint(ysync.MsgSyncStep2)
	step2.WriteVarBytes(c.doc.EncodeStateAsUpdate())
	c.send(MessageSync, step2.Bytes())
	c.sendAwareness([]uint64{c.aw.ClientID()})

	for {
		data, err := conn.Read(c.ctx)
		if err != nil {
			c.mu.Lock()
			if c.out == out {
				c.out = nil
			}
			c.mu.Unlock()
			out.stop()
			_ = conn.Close()
			return err
		}
		if err := c.receive(data); err != nil {
			c.onError(err)
		}
	}
}

func (c *Client) receive(data []byte) error {
	plaintext, err := c.cipher.Decrypt(data)
	if err != nil {
		return err
	}
	t, payload, err := DecodeMessage(plaintext)
	if errors.Is(err, ErrUnknownMessageType) {
		// A newer peer may send message types we do not know yet.
		return nil
	}
	if err != nil {
		return err
	}
	if t == MessageAttachment {
		a, err := DecodeAttachment(payload)
		if errors.Is(err, ErrUnknownAttachmentKind) {
			return nil
		}
		if err != nil {
			return err
		}
		if c.opts.OnAttachment != nil {
			c.opts.OnAttachment(a)
		}
		return nil
	}
	if t == MessageCanvas {
		m, err := DecodeCanvas(payload)
		if errors.Is(err, ErrUnknownCanvasKind) {
			return nil
		}
		if err != nil {
			return err
		}
		if c.opts.OnCanvas != nil {
			c.opts.OnCanvas(m)
		}
		return nil
	}
	if t == MessageSync {
		c.applying.Lock()
		reply, err := ysync.ApplySyncMessage(c.doc, payload, c)
		c.applying.Unlock()
		if err != nil {
			return err
		}
		if len(reply) > 0 {
			c.send(MessageSync, reply)
		}
		if kind, _, err := ysync.ReadSyncMessage(payload); err == nil && kind == ysync.MsgSyncStep2 {
			c.markSynced()
		}
		return nil
	}
	update, err := encoding.NewDecoder(payload).ReadVarBytes()
	if err != nil {
		return err
	}
	return c.aw.ApplyUpdate(update, c)
}

// markSynced reports the first full state received from a peer, once.
func (c *Client) markSynced() {
	c.mu.Lock()
	first := !c.synced
	c.synced = true
	c.mu.Unlock()
	if first && c.opts.OnSynced != nil {
		c.opts.OnSynced()
	}
}

func (c *Client) handleDocUpdate(update []byte, origin any) {
	if origin == c {
		return
	}
	c.send(MessageSync, ysync.EncodeUpdate(update))
}

func (c *Client) handleAwarenessUpdate(ev awareness.UpdateEvent) {
	if ev.Origin == c {
		return
	}
	ids := append(append(append([]uint64{}, ev.Added...), ev.Updated...), ev.Removed...)
	c.sendAwareness(ids)
}

// Someone new showed up: tell them about us right away instead of waiting for the
// periodic awareness renewal.
func (c *Client) handleAwarenessChange(ev awareness.ChangeEvent) {
	if ev.Origin == c && len(ev.Added) > 0 {
		c.sendAwareness([]uint64{c.aw.ClientID()})
	}
}

func (c *Client) dropRemoteAwareness() {
	// Every remote client counts as expired after a zero timeout; the local one never does.
	// Unlike removeAwarenessStates in the TS client, RemoveExpired takes no origin, so
	// handleAwarenessUpdate tries to broadcast the removals too; send drops them since
	// we are disconnected.
	c.aw.RemoveExpired(0)
}

// SendAttachment sends an attachment message to everyone else in the room.
// Like every other frame, it is dropped while disconnected; retrying is up to
// the caller.
func (c *Client) SendAttachment(a Attachment) error {
	payload, err := EncodeAttachment(a)
	if err != nil {
		return err
	}
	c.send(MessageAttachment, payload)
	return nil
}

// SendCanvas sends a canvas message to everyone else in the room. Like every
// other frame, it is dropped while disconnected.
func (c *Client) SendCanvas(m CanvasMessage) error {
	payload, err := EncodeCanvas(m)
	if err != nil {
		return err
	}
	c.send(MessageCanvas, payload)
	return nil
}

func (c *Client) sendAwareness(ids []uint64) {
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(c.aw.EncodeUpdate(ids))
	c.send(MessageAwareness, enc.Bytes())
}

// send queues a frame on the current connection, or drops it while
// disconnected: the handshake on reconnect carries everything that was missed.
func (c *Client) send(t MessageType, payload []byte) {
	c.mu.Lock()
	out := c.out
	c.mu.Unlock()
	if out == nil {
		return
	}
	out.push(c.cipher.Encrypt(EncodeMessage(t, payload)))
}

func (c *Client) setStatus(s Status) {
	c.mu.Lock()
	if c.status == s {
		c.mu.Unlock()
		return
	}
	c.status = s
	c.mu.Unlock()
	if c.opts.OnStatus != nil {
		c.opts.OnStatus(s)
	}
}

func (c *Client) onError(err error) {
	if err != nil && c.opts.OnError != nil {
		c.opts.OnError(err)
	}
}

// outbox writes frames to a connection in order, without blocking the sender.
type outbox struct {
	conn   Conn
	mu     sync.Mutex
	queue  [][]byte
	closed bool
	wake   chan struct{}
	done   chan struct{}
}

func newOutbox(conn Conn) *outbox {
	o := &outbox{conn: conn, wake: make(chan struct{}, 1), done: make(chan struct{})}
	go o.loop()
	return o
}

func (o *outbox) push(frame []byte) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	o.queue = append(o.queue, frame)
	o.mu.Unlock()
	o.signal()
}

func (o *outbox) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func (o *outbox) loop() {
	defer close(o.done)
	for {
		o.mu.Lock()
		queue := o.queue
		o.queue = nil
		closed := o.closed
		o.mu.Unlock()
		for _, frame := range queue {
			if err := o.conn.Write(context.Background(), frame); err != nil {
				o.mu.Lock()
				o.closed = true
				o.queue = nil
				o.mu.Unlock()
				return
			}
		}
		if closed && len(queue) == 0 {
			return
		}
		if len(queue) == 0 {
			<-o.wake
		}
	}
}

// drain stops accepting frames and waits (for a while) until the queued ones are written.
func (o *outbox) drain() {
	o.mu.Lock()
	o.closed = true
	o.mu.Unlock()
	o.signal()
	select {
	case <-o.done:
	case <-time.After(5 * time.Second):
	}
}

// stop discards queued frames without waiting.
func (o *outbox) stop() {
	o.mu.Lock()
	o.closed = true
	o.queue = nil
	o.mu.Unlock()
	o.signal()
}
