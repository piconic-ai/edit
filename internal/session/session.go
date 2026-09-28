// Package session shares a local file in an ima room.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/ima/internal/attach"
	"github.com/piconic-ai/ima/internal/filewriter"
	"github.com/piconic-ai/ima/internal/merge"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

type Options struct {
	File string
	// Server is the base URL of the ima server, e.g. https://ima.piconic.ai
	Server string
	Name   string
	// Avatar is the URL of the host's picture, shown to the others.
	Avatar     string
	WriteDelay time.Duration
	// Watch streams edits made to the file outside ima into the room.
	Watch bool
	// Header is sent with every request to the server, such as the Cloudflare
	// Access token of whoever signed in.
	Header     http.Header
	HTTPClient *http.Client
	Dial       protocol.Dialer
	OnStatus   func(protocol.Status)
	// OnPeople is called with the names of the other people in the room,
	// sorted, whenever someone joins, leaves or renames.
	OnPeople func([]string)
	// OnSaved is called with the path, relative to File, of each image
	// someone pasted that was saved beside the file.
	OnSaved func(path string)
	OnError func(error)
}

type Session struct {
	// URL is the share URL. Its fragment holds the key and must never be sent to the server.
	URL    string
	Doc    *crdt.Doc
	Text   *crdt.YText
	Client *protocol.Client
	Writer *filewriter.Writer

	file        string
	awareness   *awareness.Awareness
	attachments *attach.Attachments
	watcher     *fsnotify.Watcher
	watchDone   chan struct{}
	stopAlive   func()
	onError     func(error)

	mu        sync.Mutex
	readTimer *time.Timer
	stopped   bool
	stopOnce  sync.Once
	stopErr   error

	// syncing serializes syncs from disk, and lets Stop wait out one in flight.
	syncing sync.Mutex

	// Test seams, called during Stop.
	beforeDestroy    func()
	beforeFinalWrite func(attempt int)
}

// fileOrigin tags changes merged in from the file.
const fileOrigin = "file"

// Awareness timings of y-protocols: peers that stay silent for outdatedTimeout
// are dropped, so renew our state well before that.
const (
	outdatedTimeout = 30 * time.Second
	renewInterval   = outdatedTimeout / 2
)

func Start(ctx context.Context, opts Options) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	content, ok := filewriter.ReadFile(opts.File)
	if !ok {
		return nil, fmt.Errorf("cannot read %s", opts.File)
	}

	server := strings.TrimRight(opts.Server, "/")
	room, err := createRoom(ctx, opts.HTTPClient, server, opts.Header)
	if err != nil {
		return nil, err
	}
	key := protocol.GenerateKey()
	rawKey, err := protocol.DecodeKey(key)
	if err != nil {
		return nil, err
	}
	wsURL := "ws" + strings.TrimPrefix(server, "http") + "/api/rooms/" + room.ID + "/ws"

	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, content, nil) })
	aw := awareness.New(uint64(doc.ClientID()))
	name := opts.Name
	if name == "" {
		name = "host"
	}
	user := map[string]any{"name": name}
	if opts.Avatar != "" {
		user["avatar"] = opts.Avatar
	}
	aw.SetLocalState(map[string]any{
		"role": "host",
		"name": name,
		"user": user,
		"file": filepath.Base(opts.File),
		// Browsers let people paste images only when the host says it saves them.
		"attachments": map[string]any{"dir": attach.Dir, "maxBytes": attach.MaxBytes},
	})
	blobKeys, err := protocol.DeriveBlobKeys(rawKey)
	if err != nil {
		return nil, err
	}

	s := &Session{
		URL:       server + "/r/" + room.ID + "#" + key,
		Doc:       doc,
		Text:      text,
		file:      opts.File,
		awareness: aw,
		onError:   onError,
	}
	s.Writer = filewriter.New(opts.File, content, filewriter.Options{
		Delay:            opts.WriteDelay,
		OnError:          onError,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	header := opts.Header.Clone()
	if header == nil {
		header = http.Header{}
	}
	// Marks us as the host: the room closes for everyone once we leave.
	header.Set("Authorization", "Bearer "+room.HostToken)
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		Key:       rawKey,
		Doc:       doc,
		Awareness: aw,
		Header:    header,
		Dial:      opts.Dial,
		OnStatus:  opts.OnStatus,
		OnError:   onError,
		// Set below, before the client connects.
		OnAttachment: func(m protocol.Attachment) { s.attachments.Handle(m) },
	})
	if err != nil {
		return nil, err
	}
	s.attachments = attach.New(attach.Options{
		File:   opts.File,
		Server: server,
		Room:   room.ID,
		// Without the host token: blobs are for everyone in the room.
		Header:     opts.Header,
		HTTPClient: opts.HTTPClient,
		Keys:       blobKeys,
		Send:       s.Client.SendAttachment,
		OnSaved:    opts.OnSaved,
		OnError:    onError,
	})

	doc.OnUpdate(func(_ []byte, origin any) {
		if origin == s.Client {
			s.Writer.Schedule(s.Text.ToString())
		}
	})
	aw.OnChange(func(awareness.ChangeEvent) {
		if opts.OnPeople == nil {
			return
		}
		var names []string
		for id, st := range aw.GetStates() {
			if id != aw.ClientID() {
				names = append(names, displayName(st.State))
			}
		}
		sort.Strings(names)
		opts.OnPeople(names)
	})
	s.stopAlive = keepAlive(aw)
	s.Client.Connect()

	if opts.Watch {
		if err := s.watch(); err != nil {
			_ = s.Stop()
			return nil, err
		}
	}
	return s, nil
}

// displayName reads a peer's name the way the web editor does: from
// user.name (browsers) or name (older hosts).
func displayName(state map[string]any) string {
	user, _ := state["user"].(map[string]any)
	for _, v := range []any{user["name"], state["name"]} {
		name, _ := v.(string)
		if name = cleanName(name); name != "" {
			return name
		}
	}
	return "Someone"
}

// maxNameLength matches the web editor's limit on names.
const maxNameLength = 40

// cleanName makes a name safe to print. Names come from other people's
// browsers and end up on the host's terminal, so anything that could move
// the cursor, start an escape sequence or reorder the text is dropped.
func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > maxNameLength {
		name = strings.TrimSpace(string(r[:maxNameLength])) + "…"
	}
	return name
}

// ErrBehindAccess means Cloudflare Access sent us to its login page: we sent
// no credentials, or Access did not accept them.
var ErrBehindAccess = errors.New("Cloudflare Access sent us to its login page")

type room struct {
	ID        string `json:"id"`
	HostToken string `json:"hostToken"`
}

func createRoom(ctx context.Context, client *http.Client, server string, header http.Header) (*room, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/rooms", bytes.NewReader(nil))
	if err != nil {
		return nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to create a room: %w", err)
	}
	defer res.Body.Close()
	// Cloudflare Access answers requests it does not let through with its login page.
	if strings.HasPrefix(res.Request.URL.Path, "/cdn-cgi/access/") {
		return nil, fmt.Errorf("failed to create a room on %s: %w", server, ErrBehindAccess)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("failed to create a room on %s: %s", server, res.Status)
	}
	var r room
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil || r.ID == "" {
		return nil, fmt.Errorf("failed to create a room: %s did not answer like an ima server (check IMA_SERVER)", server)
	}
	if r.HostToken == "" {
		// Servers before host tokens cannot close a room when its host leaves.
		return nil, fmt.Errorf("failed to create a room: %s did not return a host token; the server is older than this ima and needs an update", server)
	}
	return &r, nil
}

// keepAlive renews our awareness state and drops peers that went silent, as the
// JavaScript Awareness does on its own.
func keepAlive(aw *awareness.Awareness) func() {
	stopExpiry := aw.StartAutoExpiry(outdatedTimeout)
	ticker := time.NewTicker(renewInterval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				aw.Heartbeat()
			case <-done:
				return
			}
		}
	}()
	return func() {
		ticker.Stop()
		close(done)
		stopExpiry()
	}
}

// Watch the directory rather than the file: editors often save by renaming a
// new file over the old one, which would orphan a watch on the file itself.
func (s *Session) watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Dir(s.file)); err != nil {
		_ = w.Close()
		return err
	}
	s.watcher = w
	s.watchDone = make(chan struct{})
	name := filepath.Base(s.file)
	go func() {
		defer close(s.watchDone)
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Base(ev.Name) == name {
					s.scheduleSyncFromDisk()
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.onError(err)
			}
		}
	}()
	return nil
}

func (s *Session) scheduleSyncFromDisk() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	if s.readTimer != nil {
		s.readTimer.Stop()
	}
	s.readTimer = time.AfterFunc(50*time.Millisecond, func() {
		s.syncing.Lock()
		defer s.syncing.Unlock()
		s.mu.Lock()
		stopped := s.stopped
		s.mu.Unlock()
		if !stopped {
			s.syncFromDisk()
		}
	})
}

// syncFromDisk merges the file's current content into the doc if it changed
// outside ima, against what we last wrote. The caller must hold s.syncing.
func (s *Session) syncFromDisk() {
	changed := false
	// Rebase drops any pending write, which predates the merge.
	s.Writer.Rebase(func(lastWritten string) string {
		onDisk, ok := readSettled(s.file)
		if !ok || onDisk == lastWritten {
			return lastWritten
		}
		s.Client.Do(func() {
			merge.ExternalEdit(s.Doc, s.Text, lastWritten, onDisk, fileOrigin)
		})
		changed = true
		return onDisk
	})
	if changed {
		// Remote edits made meanwhile are not on disk yet.
		s.Writer.Schedule(s.Text.ToString())
	}
}

// finalWriteAttempts bounds how often Stop retries when the file keeps changing
// outside ima while it tries to save.
const finalWriteAttempts = 3

// Stop leaves the room and writes the final state to the file. It reports an
// error when the final state could not be saved.
func (s *Session) Stop() error {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.stopped = true
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		s.mu.Unlock()
		if s.watcher != nil {
			_ = s.watcher.Close()
			<-s.watchDone
		}
		// Waits for a sync already started by the timer; none can start after this.
		s.syncing.Lock()
		defer s.syncing.Unlock()

		// Merge a last-second external edit while peers can still get it, and
		// save right away: leaving can take a while, and a second Ctrl+C exits.
		s.syncFromDisk()
		s.Writer.Schedule(s.Text.ToString())
		_ = s.Writer.Flush()

		if s.beforeDestroy != nil {
			s.beforeDestroy()
		}
		s.attachments.Close()
		s.Client.Destroy()

		// Save again: edits may have arrived while leaving, and none can arrive now.
		for attempt := 1; ; attempt++ {
			if s.beforeFinalWrite != nil {
				s.beforeFinalWrite(attempt)
			}
			s.Writer.Schedule(s.Text.ToString())
			s.stopErr = s.Writer.Flush()
			if !errors.Is(s.stopErr, filewriter.ErrExternalChange) || attempt == finalWriteAttempts {
				break
			}
			// Someone saved the file meanwhile: merge it in and try again.
			s.syncFromDisk()
		}
		s.stopAlive()
		s.awareness.Destroy()
	})
	return s.stopErr
}

// Saving is often truncate-then-write, so a read right after the change event can
// see a half-written file. Read until two consecutive reads agree; report !ok if
// they never do, so a half-written file is not taken for the new content.
func readSettled(path string) (string, bool) {
	return settle(func() (string, bool) { return filewriter.ReadFile(path) }, 30*time.Millisecond, 10)
}

func settle(read func() (string, bool), interval time.Duration, maxReads int) (string, bool) {
	previous, prevOK := read()
	for range maxReads - 1 {
		time.Sleep(interval)
		current, ok := read()
		if current == previous && ok == prevOK {
			return current, ok
		}
		previous, prevOK = current, ok
	}
	return "", false
}
