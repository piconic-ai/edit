// Package interop checks the Go host against the web client's JavaScript RoomClient.
package interop

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/piconic-ai/ima/internal/protocol/prototest"
	"github.com/piconic-ai/ima/internal/session"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const roomID = "AAAAAAAAAAAAAAAAAAAAAA"

// newServer stands in for the Worker: it creates rooms, relays frames between
// sockets and keeps blobs.
func newServer(t *testing.T) *httptest.Server {
	var mu sync.Mutex
	conns := map[*websocket.Conn]bool{}
	blobs := map[string][]byte{}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/rooms/{id}/blobs/{blob}", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if _, ok := blobs[r.URL.Path]; ok {
			return
		}
		blobs[r.URL.Path] = body
		w.WriteHeader(http.StatusCreated)
	})
	mux.HandleFunc("GET /api/rooms/{id}/blobs/{blob}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		body, ok := blobs[r.URL.Path]
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	})
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": roomID, "hostToken": "host-token"})
	})
	mux.HandleFunc("GET /api/rooms/{id}/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1)
		mu.Lock()
		conns[c] = true
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(conns, c)
			mu.Unlock()
		}()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			mu.Lock()
			for peer := range conns {
				if peer != c {
					_ = peer.Write(context.Background(), typ, data)
				}
			}
			mu.Unlock()
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// protocolDir returns packages/protocol, or skips the test when its
// dependencies or Node.js are missing (unless IMA_INTEROP requires it).
func protocolDir(t *testing.T) string {
	dir, err := filepath.Abs("../../packages/protocol")
	if err != nil {
		t.Fatal(err)
	}
	_, nodeErr := exec.LookPath("node")
	_, depsErr := os.Stat(filepath.Join(dir, "node_modules", "yjs"))
	if nodeErr != nil || depsErr != nil {
		if os.Getenv("IMA_INTEROP") != "" {
			t.Fatalf("node or packages/protocol dependencies missing (run pnpm install)")
		}
		t.Skip("needs node and pnpm install")
	}
	return dir
}

func TestGoHostWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("こんにちは🌏 world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{
		File:       file,
		Server:     server.URL,
		WriteDelay: 20 * time.Millisecond,
		Watch:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	guest := startGuest(t, "testdata/guest.mjs", dir, wsURL(server), share.Fragment)

	read := func() string {
		b, _ := os.ReadFile(file)
		return string(b)
	}
	const edited = "こにちは🌏[X] world\n"
	prototest.WaitFor(t, 10*time.Second, func() bool { return read() == edited }, "the guest's edit on disk")

	const final = edited + "from file 🐹\n"
	if err := os.WriteFile(file, []byte(final), 0o644); err != nil {
		t.Fatal(err)
	}
	var got string
	if line := guest.next("the final text"); json.Unmarshal([]byte(line), &got) != nil || got != final {
		t.Fatalf("guest ended with %q\n%s", line, guest.stderr.String())
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the host to leave"); line != "host left" {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
	if read() != final {
		t.Fatalf("file = %q", read())
	}
}

func TestAttachmentsWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	key := protocol.GenerateKey()
	raw, _ := protocol.DecodeKey(key)
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	attachments := make(chan protocol.Attachment, 1)
	host, err := protocol.NewClient(protocol.ClientOptions{
		URL:          wsURL(server),
		Key:          raw,
		Doc:          doc,
		Awareness:    awareness.New(uint64(doc.ClientID())),
		OnAttachment: func(a protocol.Attachment) { attachments <- a },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Destroy)
	host.Connect()
	prototest.WaitFor(t, 5*time.Second, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")

	guest := startGuest(t, "testdata/attachment.mjs", dir, wsURL(server), key)
	var uploaded struct{ Hash, BlobID, Blob string }
	if line := guest.next("the upload"); json.Unmarshal([]byte(line), &uploaded) != nil {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	// The guest encrypted and named the blob the way the host does.
	const content = "\x89PNG\r\n\x1a\nima 居間"
	if uploaded.Hash != protocol.ContentHash([]byte(content)) {
		t.Fatalf("hash = %s", uploaded.Hash)
	}
	if id, _ := keys.BlobID(uploaded.Hash); uploaded.BlobID != id {
		t.Fatalf("blob id = %s, want %s", uploaded.BlobID, id)
	}
	blob, _ := base64.RawURLEncoding.DecodeString(uploaded.Blob)
	if got, err := keys.Decrypt(blob, uploaded.Hash); err != nil || string(got) != content {
		t.Fatalf("Decrypt = %q, %v", got, err)
	}

	select {
	case a := <-attachments:
		want := protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: uploaded.Hash, Mime: "image/png"}
		if !reflect.DeepEqual(a, want) {
			t.Fatalf("host got %+v", a)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no announcement\n%s", guest.stderr.String())
	}
	path := "assets/" + uploaded.Hash + ".png"
	if err := host.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: uploaded.Hash, Path: path}); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the stored reply"); line != "stored "+path {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
}

func TestGoHostSavesImagesFromJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("# notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// An image saved in an earlier session, which a guest will ask for.
	earlier := []byte("\x89PNG\r\n\x1a\nearlier")
	assets := filepath.Join(filepath.Dir(file), "assets")
	_ = os.Mkdir(assets, 0o755)
	if err := os.WriteFile(filepath.Join(assets, protocol.ContentHash(earlier)+".png"), earlier, 0o644); err != nil {
		t.Fatal(err)
	}
	var saved []string
	var mu sync.Mutex
	s, err := session.Start(context.Background(), session.Options{
		File:    file,
		Server:  server.URL,
		OnSaved: func(path string) { mu.Lock(); saved = append(saved, path); mu.Unlock() },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	guest := startGuest(t, "testdata/upload.mjs", dir, server.URL, roomID, share.Fragment, protocol.ContentHash(earlier))

	// The guest pasted an image: the host saved it.
	pasted := []byte("\x89PNG\r\n\x1a\nima 居間")
	path := "assets/" + protocol.ContentHash(pasted) + ".png"
	if line := guest.next("the stored reply"); line != "stored "+path {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	if got, err := os.ReadFile(filepath.Join(filepath.Dir(file), filepath.FromSlash(path))); err != nil || string(got) != string(pasted) {
		t.Fatalf("saved %q, %v", got, err)
	}
	mu.Lock()
	if !reflect.DeepEqual(saved, []string{path}) {
		t.Fatalf("OnSaved got %v", saved)
	}
	mu.Unlock()

	// The guest wanted the earlier image: the host uploaded it from disk.
	if line := guest.next("the wanted image"); line != "wanted "+hex.EncodeToString(earlier) {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
}

func wsURL(server *httptest.Server) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/api/rooms/" + roomID + "/ws"
}

// guest is a Node.js script under testdata that reports by printing lines.
type guest struct {
	t      *testing.T
	cmd    *exec.Cmd
	ctx    context.Context
	lines  chan string
	stderr *syncBuffer
}

func startGuest(t *testing.T, script string, args ...string) *guest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	g := &guest{
		t:      t,
		cmd:    exec.CommandContext(ctx, "node", append([]string{script}, args...)...),
		ctx:    ctx,
		lines:  make(chan string),
		stderr: &syncBuffer{},
	}
	g.cmd.Stderr = g.stderr
	stdout, err := g.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := g.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(g.lines)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			g.lines <- scanner.Text()
		}
	}()
	return g
}

func (g *guest) next(what string) string {
	g.t.Helper()
	select {
	case line, ok := <-g.lines:
		if !ok {
			g.t.Fatalf("guest exited before %s: %v\n%s", what, g.cmd.Wait(), g.stderr.String())
		}
		return line
	case <-g.ctx.Done():
		g.t.Fatalf("timed out waiting for %s\n%s", what, g.stderr.String())
		return ""
	}
}

func (g *guest) wait() {
	g.t.Helper()
	if err := g.cmd.Wait(); err != nil {
		g.t.Fatalf("guest failed: %v\n%s", err, g.stderr.String())
	}
}

// syncBuffer collects a guest's stderr, which the test may read while the
// guest is still writing to it.
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
