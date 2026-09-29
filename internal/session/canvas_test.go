package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/piconic-ai/ima/internal/canvas"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/piconic-ai/ima/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const board = "{\n" +
	"\t\"nodes\":[\n" +
	"\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\",\"x\":0,\"y\":0,\"width\":250,\"height\":60},\n" +
	"\t\t{\"id\":\"b2\",\"type\":\"text\",\"text\":\"World\",\"x\":300,\"y\":0,\"width\":250,\"height\":60}\n" +
	"\t],\n" +
	"\t\"edges\":[\n" +
	"\t\t{\"id\":\"e1\",\"fromNode\":\"a1\",\"fromSide\":\"right\",\"toNode\":\"b2\",\"toSide\":\"left\"}\n" +
	"\t]\n" +
	"}"

// canvasGuest joins a canvas room and collects the canvas messages it gets.
type canvasGuest struct {
	*protocol.Client
	doc *crdt.Doc
	aw  *awareness.Awareness

	mu       sync.Mutex
	messages []protocol.CanvasMessage
}

func joinCanvas(t *testing.T, relay *prototest.Relay, shareURL string) *canvasGuest {
	t.Helper()
	u, _ := url.Parse(shareURL)
	key, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	g := &canvasGuest{doc: crdt.New()}
	g.aw = awareness.New(uint64(g.doc.ClientID()))
	g.aw.SetLocalState(map[string]any{})
	g.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL: "ws://guest", Key: key, Doc: g.doc, Awareness: g.aw, Dial: relay.Dial,
		OnCanvas: func(m protocol.CanvasMessage) {
			g.mu.Lock()
			g.messages = append(g.messages, m)
			g.mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Destroy)
	g.Connect()
	prototest.WaitFor(t, wait, func() bool { return len(g.canvas().Nodes) > 0 }, "guest to get the canvas")
	return g
}

// canvas reads the guest's doc under the client's lock, as remote updates
// change it concurrently.
func (g *canvasGuest) canvas() canvas.Canvas {
	var c canvas.Canvas
	g.Do(func() { c = canvas.Read(g.doc) })
	return c
}

// change edits the node with id in the guest's doc.
func (g *canvasGuest) change(t *testing.T, id string, fn func(txn *crdt.Transaction, m *crdt.YMap)) {
	t.Helper()
	g.Do(func() {
		nodes := g.doc.GetArray(canvas.NodesKey)
		for i := 0; i < nodes.Len(); i++ {
			m := nodes.Get(i).(*crdt.YMap)
			if v, _ := m.Get("id"); v == id {
				g.doc.Transact(func(txn *crdt.Transaction) { fn(txn, m) })
				return
			}
		}
		t.Errorf("no node %q", id)
	})
}

func (g *canvasGuest) text(id string) string {
	for _, n := range g.canvas().Nodes {
		if n["id"] == id {
			s, _ := n[canvas.TextKey].(string)
			return s
		}
	}
	return ""
}

func (g *canvasGuest) reply(id string) (protocol.CanvasMessage, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, m := range g.messages {
		if m.ID == id {
			return m, true
		}
	}
	return protocol.CanvasMessage{}, false
}

func TestInvalidCanvasFailsBeforeARoomIsMade(t *testing.T) {
	file := filepath.Join(t.TempDir(), "board.canvas")
	if err := os.WriteFile(file, []byte("{\"nodes\":[\n{\"id\":\"a\",\"type\":\"text\",\"x\":0,\"y\":0,\"width\":1}]}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	t.Cleanup(server.Close)
	_, err := Start(context.Background(), Options{File: file, Server: server.URL})
	if err == nil {
		t.Fatal("Start accepted an invalid canvas")
	}
	for _, want := range []string{
		"board.canvas is not a valid JSON Canvas",
		`board.canvas:2:1: nodes[0] (id "a"): has no "height"`,
		`board.canvas:2:1: nodes[0] (id "a"): has no "text"`,
		"Fix the file and run ima again.",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q:\n%v", want, err)
		}
	}
	if requests != 0 {
		t.Errorf("%d requests reached the server", requests)
	}
}

func TestCanvasIsSharedAsNodesAndEdges(t *testing.T) {
	f := setup(t, board, setupOpts{name: "board.canvas"})
	if f.session.Text != nil {
		t.Error("a canvas room has shared text")
	}
	g := joinCanvas(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool {
		for _, st := range g.aw.GetStates() {
			if st.State["format"] == "canvas" {
				return true
			}
		}
		return false
	}, "the host to say the room is a canvas")

	// A guest moves a node: the file changes there and nowhere else.
	g.change(t, "b2", func(txn *crdt.Transaction, m *crdt.YMap) { m.Set(txn, "x", int64(320)) })
	want := strings.Replace(board, `"x":300`, `"x":320`, 1)
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == want }, "the move to be saved")
}

func TestCanvasTakesInEditsToTheFile(t *testing.T) {
	var mu sync.Mutex
	var errs []error
	f := setup(t, board, setupOpts{name: "board.canvas", watch: true, onError: func(err error) {
		mu.Lock()
		errs = append(errs, err)
		mu.Unlock()
	}})
	g := joinCanvas(t, f.relay, f.session.URL)

	edited := strings.Replace(board, `"text":"Hello"`, `"text":"Hello there"`, 1)
	if err := os.WriteFile(f.file, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.text("a1") == "Hello there" }, "the guest to see the edit")

	// Saved half-way: ima waits instead of saving over it, and says why once.
	broken := edited[:len(edited)-3]
	if err := os.WriteFile(f.file, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	g.change(t, "b2", func(txn *crdt.Transaction, m *crdt.YMap) { m.Set(txn, "color", "1") })
	prototest.WaitFor(t, wait, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(errs) > 0
	}, "the invalid file to be reported")
	if got := readFile(t, f.file); got != broken {
		t.Fatalf("the file was saved over while invalid:\n%s", got)
	}
	mu.Lock()
	if len(errs) != 1 || !strings.Contains(errs[0].Error(), "board.canvas changed outside ima") || !strings.Contains(errs[0].Error(), "ends too early") {
		t.Errorf("errors = %v", errs)
	}
	mu.Unlock()

	// Fixed: the guest's change is saved on top of it.
	if err := os.WriteFile(f.file, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(edited, `"height":60}`+"\n", `"height":60,"color":"1"}`+"\n", 1)
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == want }, "the guest's change to be saved")
}

func TestCanvasAppliesJSONEditedInTheBrowser(t *testing.T) {
	f := setup(t, board, setupOpts{name: "board.canvas"})
	g := joinCanvas(t, f.relay, f.session.URL)

	next := strings.Replace(board, `"text":"World"`, `"text":"Everyone"`, 1)
	if err := g.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e1", Base: board, Next: next}); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { _, ok := g.reply("e1"); return ok }, "a reply")
	if m, _ := g.reply("e1"); m.Kind != protocol.CanvasApplied {
		t.Fatalf("reply = %+v", m)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == next }, "the edit to be saved")

	bad := strings.Replace(next, `"x":300`, `"x":"300"`, 1)
	if err := g.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e2", Base: next, Next: bad}); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { _, ok := g.reply("e2"); return ok }, "a reply")
	m, _ := g.reply("e2")
	if m.Kind != protocol.CanvasRejected || !strings.Contains(m.Reason, `board.canvas:4:`) || !strings.Contains(m.Reason, `"x" must be a number, not a string`) {
		t.Fatalf("reply = %+v", m)
	}
	if got := readFile(t, f.file); got != next {
		t.Errorf("a rejected edit changed the file:\n%s", got)
	}
}
