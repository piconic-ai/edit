package protocol_test

import (
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const wait = 3 * time.Second

type peer struct {
	*protocol.Client
	doc  *crdt.Doc
	aw   *awareness.Awareness
	text *crdt.YText
}

func (p *peer) String() string { return p.text.ToString() }

func (p *peer) insert(index int, s string) {
	p.doc.Transact(func(txn *crdt.Transaction) { p.text.Insert(txn, index, s, nil) })
}

type joinOpts struct {
	init         string
	state        map[string]any
	header       http.Header
	onError      func(error)
	onAttachment func(protocol.Attachment)
	onSynced     func()
}

func join(t *testing.T, relay *prototest.Relay, key string, o joinOpts) *peer {
	t.Helper()
	raw, err := protocol.DecodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	text := doc.GetText("content")
	if o.init != "" {
		doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, o.init, nil) })
	}
	aw := awareness.New(uint64(doc.ClientID()))
	if o.state == nil {
		o.state = map[string]any{} // like a JavaScript Awareness starts
	}
	aw.SetLocalState(o.state)
	client, err := protocol.NewClient(protocol.ClientOptions{
		URL:          "ws://test",
		Key:          raw,
		Doc:          doc,
		Awareness:    aw,
		Header:       o.header,
		Dial:         relay.Dial,
		MinBackoff:   20 * time.Millisecond,
		OnError:      o.onError,
		OnAttachment: o.onAttachment,
		OnSynced:     o.onSynced,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Destroy)
	client.Connect()
	return &peer{Client: client, doc: doc, aw: aw, text: text}
}

func hostHeader() http.Header { return http.Header{"Authorization": {"Bearer t"}} }

func TestLateJoinerGetsFullDocument(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "# notes\n"})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "# notes\n" }, "guest to get the doc")
}

func TestReportsSyncedOnceWithTheDocument(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "# notes\n", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	var mu sync.Mutex
	var seen []string
	var guest *peer
	guest = join(t, relay, key, joinOpts{onSynced: func() {
		mu.Lock()
		defer mu.Unlock()
		// The doc already holds the room's state when synced is reported.
		seen = append(seen, guest.String())
	}})
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(seen) > 0 }, "synced")
	// Another peer's SyncStep2, and a reconnect, do not report it again.
	join(t, relay, key, joinOpts{})
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "reconnected")
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(seen, []string{"# notes\n"}) {
		t.Fatalf("synced reports = %q", seen)
	}
}

func TestConcurrentEditsBothWays(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	a := join(t, relay, key, joinOpts{init: "hello"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "hello" }, "b to sync")
	a.insert(0, "A")
	b.insert(5, "B")
	prototest.WaitFor(t, wait, func() bool {
		sa, sb := a.String(), b.String()
		return sa == sb && strings.Contains(sa, "A") && strings.Contains(sa, "B")
	}, "convergence")
}

func TestUTF16Offsets(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	a := join(t, relay, key, joinOpts{init: "🌏 world"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "🌏 world" }, "b to sync")
	b.insert(2, "!") // right after the surrogate pair
	prototest.WaitFor(t, wait, func() bool { return a.String() == "🌏! world" }, "a to see the edit")
}

func TestPushesOfflineEditsOfReconnectingHost(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	guest := join(t, relay, key, joinOpts{})
	join(t, relay, key, joinOpts{init: "written before anyone joined"})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "written before anyone joined" }, "guest to sync")
}

func TestAwareness(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{state: map[string]any{"role": "host"}})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{state: map[string]any{"name": "guest"}})
	stateOf := func(p, of *peer) map[string]any {
		return p.aw.GetStates()[of.aw.ClientID()].State
	}
	prototest.WaitFor(t, wait, func() bool {
		return reflect.DeepEqual(stateOf(guest, host), map[string]any{"role": "host"}) &&
			reflect.DeepEqual(stateOf(host, guest), map[string]any{"name": "guest"})
	}, "awareness exchange")
	host.Destroy()
	prototest.WaitFor(t, wait, func() bool {
		_, ok := guest.aw.GetStates()[host.aw.ClientID()]
		return !ok
	}, "host to leave")
}

func TestOnlyCiphertextOnTheWire(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	join(t, relay, key, joinOpts{init: "top secret plaintext"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "top secret plaintext" }, "b to sync")
	for _, f := range relay.Frames() {
		if strings.Contains(string(f), "top secret") {
			t.Fatal("plaintext leaked onto the wire")
		}
	}
}

func TestIgnoresPeersWithDifferentKey(t *testing.T) {
	relay := prototest.NewRelay(false)
	a := join(t, relay, protocol.GenerateKey(), joinOpts{init: "mine"})
	var mu sync.Mutex
	var errs []error
	b := join(t, relay, protocol.GenerateKey(), joinOpts{onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")
	a.insert(4, "!") // reaches b as a frame it cannot decrypt
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(errs) > 0 }, "a decrypt error")
	if b.String() != "" || a.String() != "mine!" {
		t.Fatalf("a=%q b=%q", a.String(), b.String())
	}
}

func TestAttachments(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var got []protocol.Attachment
	a := join(t, relay, key, joinOpts{})
	b := join(t, relay, key, joinOpts{onAttachment: func(at protocol.Attachment) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, at)
	}})
	prototest.WaitFor(t, wait, func() bool {
		return a.Status() == protocol.StatusConnected && b.Status() == protocol.StatusConnected
	}, "both connected")
	sent := protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hashA, Mime: "image/png"}
	if err := a.SendAttachment(sent); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) > 0 }, "the attachment")
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(got, []protocol.Attachment{sent}) {
		t.Fatalf("got %+v", got)
	}
	if err := a.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentWant}); err == nil {
		t.Fatal("an invalid attachment should not be sent")
	}
}

func TestSkipsMessagesFromNewerPeers(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var errs []error
	b := join(t, relay, key, joinOpts{onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")

	// A newer peer sends a message type and an attachment kind b does not
	// know, then an edit.
	raw, _ := protocol.DecodeKey(key)
	c, _ := protocol.NewCipher(raw)
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for _, m := range [][]byte{
		protocol.EncodeMessage(9, []byte{1, 2, 3}),
		protocol.EncodeMessage(protocol.MessageAttachment, []byte{9, 1, 2, 3}),
	} {
		if err := conn.Write(t.Context(), c.Encrypt(m)); err != nil {
			t.Fatal(err)
		}
	}
	a := join(t, relay, key, joinOpts{init: "after"})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "after" && a.String() == "after" }, "b to keep syncing")
	mu.Lock()
	defer mu.Unlock()
	if len(errs) > 0 {
		t.Fatalf("errors: %v", errs)
	}
}

func TestReconnectsAfterDrop(t *testing.T) {
	relay := prototest.NewRelay(false)
	var mu sync.Mutex
	var statuses []protocol.Status
	raw, _ := protocol.DecodeKey(protocol.GenerateKey())
	doc := crdt.New()
	c, _ := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://test", Key: raw, Doc: doc, Awareness: awareness.New(uint64(doc.ClientID())),
		Dial: relay.Dial, MinBackoff: 20 * time.Millisecond,
		OnStatus: func(s protocol.Status) { mu.Lock(); statuses = append(statuses, s); mu.Unlock() },
	})
	t.Cleanup(c.Destroy)
	c.Connect()
	prototest.WaitFor(t, wait, func() bool { return c.Status() == protocol.StatusConnected }, "connected")
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return len(relay.URLs()) == 2 && c.Status() == protocol.StatusConnected }, "reconnect")
	mu.Lock()
	defer mu.Unlock()
	want := []protocol.Status{"connecting", "connected", "disconnected", "connecting", "connected"}
	if !reflect.DeepEqual(statuses, want) {
		t.Fatalf("statuses = %v", statuses)
	}
}

func TestPassesHandshakeHeaders(t *testing.T) {
	relay := prototest.NewRelay(false)
	join(t, relay, protocol.GenerateKey(), joinOpts{header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return len(relay.Headers()) == 1 }, "dial")
	if got := relay.Headers()[0].Get("Authorization"); got != "Bearer t" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestStopsForGoodWhenHostLeaves(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "x" }, "guest to sync")
	host.Destroy()
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusClosed }, "guest closed")
	time.Sleep(200 * time.Millisecond)
	if guest.Status() != protocol.StatusClosed || len(relay.URLs()) != 2 {
		t.Fatalf("status=%v dials=%d", guest.Status(), len(relay.URLs()))
	}
}

func TestStopsForGoodWhenRoomIsFull(t *testing.T) {
	relay := prototest.NewRelay(true)
	relay.Guests = 1
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	first := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return first.String() == "x" }, "first guest to sync")
	late := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return late.Status() == protocol.StatusFull }, "late guest turned away")
	time.Sleep(200 * time.Millisecond)
	if late.Status() != protocol.StatusFull || len(relay.URLs()) != 3 {
		t.Fatalf("status=%v dials=%d", late.Status(), len(relay.URLs()))
	}
}

func TestTurnedAwayWithoutHost(t *testing.T) {
	relay := prototest.NewRelay(true)
	guest := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusClosed }, "guest closed")
}
