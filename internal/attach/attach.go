// Package attach saves images pasted into the shared document next to the
// host's file, and uploads them again for peers who could not fetch them.
//
// Image bytes travel through the server's blob store, encrypted; the room only
// carries small attachment messages. The host is the one peer that writes to
// disk, and it trusts nothing a peer claims: it checks every image against its
// content hash, and picks the file type from the bytes themselves.
package attach

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/piconic-ai/edit/internal/protocol"
)

const (
	// Dir is where attachments go, beside the shared file. Links in the
	// document point into it.
	Dir = "assets"
	// MaxBytes caps one attachment.
	MaxBytes = 10 << 20
	// MaxTotalBytes and MaxCount cap what one session writes to disk, like
	// the server caps what a room stores.
	MaxTotalBytes = 100 << 20
	MaxCount      = 500

	// AES-GCM adds an IV and a tag to every blob.
	blobOverhead = 12 + 16
	queueSize    = 64
	// resendInterval is how long a re-upload for one hash is good for: peers
	// asking again sooner get nothing, since the blob is already there.
	resendInterval = 5 * time.Second
	// requestTimeout bounds one blob request, body included, so a stalled one
	// cannot hold up every message after it. It leaves room for 10 MiB on a
	// slow uplink.
	requestTimeout = 2 * time.Minute
)

// Reasons sent in Rejected messages.
const (
	ReasonTooLarge    = "too_large"
	ReasonType        = "type"
	ReasonQuota       = "quota"
	ReasonInvalid     = "invalid"
	ReasonUnavailable = "unavailable"
)

// extensions lists the accepted types. SVG is not one: it can carry scripts.
var extensions = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

var (
	errTooLarge = errors.New("attachment too large")
	errInvalid  = errors.New("attachment does not match its hash")
	errClosed   = errors.New("the room is closed")
	errOutside  = errors.New(Dir + " leads outside the shared file's directory")
)

type Options struct {
	// File is the shared file; attachments go to Dir beside it.
	File string
	// InitialDocument is the host's local file before peers can edit the room.
	InitialDocument string
	// Server is the base URL of the piconic edit server, and Room the room id.
	Server string
	Room   string
	// Header is sent with every request to the server, such as the Cloudflare
	// Access token. It must not hold the host token.
	Header     http.Header
	HTTPClient *http.Client
	Keys       *protocol.BlobKeys
	// Send sends an attachment message to the room.
	Send func(protocol.Attachment) error
	// OnSaved is called with the path, relative to File, of each image
	// written to disk.
	OnSaved func(path string)
	OnError func(error)
}

// Attachments handles the attachment messages of one session, one at a time
// in the background, so the room's read loop never waits on the network or
// the disk.
type Attachments struct {
	opts      Options
	queue     chan protocol.Attachment
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	allowedMu sync.RWMutex
	allowed   map[string]struct{} // locally authorized image hashes

	// Touched only by the worker goroutine.
	total   int64
	count   int
	stored  map[string]string // hash → path
	served  map[string]time.Time
	now     func() time.Time
	timeout time.Duration
}

func New(opts Options) *Attachments {
	if opts.HTTPClient == nil {
		opts.HTTPClient = http.DefaultClient
	}
	if opts.OnError == nil {
		opts.OnError = func(error) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &Attachments{
		opts:    opts,
		queue:   make(chan protocol.Attachment, queueSize),
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		allowed: map[string]struct{}{},
		stored:  map[string]string{},
		served:  map[string]time.Time{},
		now:     time.Now,
		timeout: requestTimeout,
	}
	a.AllowLocalDocument(opts.InitialDocument)
	go a.run()
	return a
}

var assetReference = regexp.MustCompile(`(?:^|[^[:alnum:]_])assets/([0-9a-f]{32})\.(?:png|jpg|gif|webp)(?:$|[^[:alnum:]_.])`)

func documentHashes(document string) map[string]struct{} {
	hashes := map[string]struct{}{}
	for _, match := range assetReference.FindAllStringSubmatch(document, -1) {
		hashes[match[1]] = struct{}{}
	}
	return hashes
}

// AllowLocalDocument authorizes references in a file read from the host's
// disk. Callers must not pass the peer-editable live document here.
func (a *Attachments) AllowLocalDocument(document string) {
	a.allowedMu.Lock()
	defer a.allowedMu.Unlock()
	for hash := range documentHashes(document) {
		a.allowed[hash] = struct{}{}
	}
}

// AllowLocalChanges authorizes only references introduced by the local edit.
// References already persisted from peer edits do not gain permission merely
// because the host edits another part of the file.
func (a *Attachments) AllowLocalChanges(base, next string) {
	previous := documentHashes(base)
	a.allowedMu.Lock()
	defer a.allowedMu.Unlock()
	for hash := range documentHashes(next) {
		if _, existed := previous[hash]; !existed {
			a.allowed[hash] = struct{}{}
		}
	}
}

func (a *Attachments) allowedHash(hash string) bool {
	a.allowedMu.RLock()
	defer a.allowedMu.RUnlock()
	_, ok := a.allowed[hash]
	return ok
}

// Handle queues an attachment message from the room. It never blocks.
func (a *Attachments) Handle(m protocol.Attachment) {
	if m.Kind != protocol.AttachmentAnnounce && m.Kind != protocol.AttachmentWant {
		return
	}
	select {
	case a.queue <- m:
	default:
		a.opts.OnError(errors.New("too many attachment messages; dropped one"))
	}
}

// Close stops handling messages, abandoning any in flight.
func (a *Attachments) Close() {
	a.cancel()
	<-a.done
}

func (a *Attachments) run() {
	defer close(a.done)
	for {
		select {
		case m := <-a.queue:
			if m.Kind == protocol.AttachmentAnnounce {
				a.announced(m.Hash, m.Mime)
			} else {
				a.wanted(m.Hashes)
			}
		case <-a.ctx.Done():
			return
		}
	}
}

// announced saves an image someone uploaded, and tells the room where it is.
func (a *Attachments) announced(hash, mime string) {
	if _, ok := extensions[mime]; !ok {
		a.reject(hash, ReasonType)
		return
	}
	if path, ok := a.stored[hash]; ok {
		// Unless someone moved the file away meanwhile.
		if info, err := os.Stat(filepath.Join(filepath.Dir(a.opts.File), filepath.FromSlash(path))); err == nil && info.Mode().IsRegular() {
			a.send(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: hash, Path: path})
			return
		}
		delete(a.stored, hash)
	}
	content, err := a.fetch(hash)
	switch {
	case errors.Is(err, errTooLarge):
		a.reject(hash, ReasonTooLarge)
		return
	case errors.Is(err, errInvalid):
		a.reject(hash, ReasonInvalid)
		return
	case err != nil:
		// Nobody can act on a network failure; the uploader times out.
		if a.ctx.Err() == nil {
			a.opts.OnError(err)
		}
		return
	}
	ext, ok := extensions[http.DetectContentType(content)]
	if !ok {
		a.reject(hash, ReasonType)
		return
	}
	if a.count+1 > MaxCount || a.total+int64(len(content)) > MaxTotalBytes {
		a.reject(hash, ReasonQuota)
		return
	}
	path, written, err := a.save(hash, ext, content)
	if err != nil {
		a.opts.OnError(err)
		a.reject(hash, ReasonUnavailable)
		return
	}
	a.stored[hash] = path
	a.allowedMu.Lock()
	a.allowed[hash] = struct{}{}
	a.allowedMu.Unlock()
	if written {
		a.count++
		a.total += int64(len(content))
		if a.opts.OnSaved != nil {
			a.opts.OnSaved(path)
		}
	}
	a.send(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: hash, Path: path})
}

// wanted uploads images from disk that peers could not fetch.
func (a *Attachments) wanted(hashes []string) {
	for _, hash := range hashes {
		if a.ctx.Err() != nil {
			return
		}
		if !a.allowedHash(hash) {
			continue
		}
		if last, ok := a.served[hash]; ok && a.now().Sub(last) < resendInterval {
			continue
		}
		content, mime, ok := a.load(hash)
		if !ok {
			continue
		}
		err := a.upload(hash, content)
		if errors.Is(err, errClosed) {
			return
		}
		if err != nil {
			a.opts.OnError(err)
			continue
		}
		a.served[hash] = a.now()
		a.send(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: mime})
	}
}

func (a *Attachments) reject(hash, reason string) {
	a.send(protocol.Attachment{Kind: protocol.AttachmentRejected, Hash: hash, Reason: reason})
}

func (a *Attachments) send(m protocol.Attachment) {
	if err := a.opts.Send(m); err != nil {
		a.opts.OnError(err)
	}
}

func (a *Attachments) blobURL(hash string) (string, error) {
	id, err := a.opts.Keys.BlobID(hash)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(a.opts.Server, "/") + "/api/rooms/" + a.opts.Room + "/blobs/" + id, nil
}

// request sends a blob request bounded by ctx, which must also cover reading
// the response body.
func (a *Attachments) request(ctx context.Context, method, hash string, body []byte) (*http.Response, error) {
	url, err := a.blobURL(hash)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range a.opts.Header {
		req.Header[k] = v
	}
	req.Header.Set(protocol.AdmissionHeader, a.opts.Keys.Admission)
	// Never forward the room capability to a redirect destination.
	client := *a.opts.HTTPClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client.Do(req)
}

// fetch downloads and decrypts an attachment, checking it against its hash.
func (a *Attachments) fetch(hash string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(a.ctx, a.timeout)
	defer cancel()
	res, err := a.request(ctx, http.MethodGet, hash, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch an attachment: %w", err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		// Announced, but not there: nothing to save.
		return nil, errInvalid
	case res.StatusCode == http.StatusGone:
		return nil, errClosed
	case res.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("failed to fetch an attachment: %s", res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxBytes+blobOverhead+1))
	if err != nil {
		return nil, fmt.Errorf("failed to fetch an attachment: %w", err)
	}
	if len(data) > MaxBytes+blobOverhead {
		return nil, errTooLarge
	}
	content, err := a.opts.Keys.Decrypt(data, hash)
	if err != nil {
		return nil, errInvalid
	}
	return content, nil
}

// upload encrypts an attachment and stores it in the room.
func (a *Attachments) upload(hash string, content []byte) error {
	ctx, cancel := context.WithTimeout(a.ctx, a.timeout)
	defer cancel()
	res, err := a.request(ctx, http.MethodPut, hash, a.opts.Keys.Encrypt(content))
	if err != nil {
		return fmt.Errorf("failed to upload an attachment: %w", err)
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK, http.StatusCreated:
		return nil
	case http.StatusGone:
		return errClosed
	}
	return fmt.Errorf("failed to upload an attachment: %s", res.Status)
}

// save writes an attachment beside the shared file, unless it is already
// there. It returns the path relative to the file, with forward slashes as
// in a Markdown link, and whether it wrote anything.
func (a *Attachments) save(hash, ext string, content []byte) (string, bool, error) {
	dir, err := a.dir(true)
	if err != nil {
		return "", false, err
	}
	name := hash + ext
	rel := Dir + "/" + name
	path := filepath.Join(dir, name)
	if info, err := os.Lstat(path); err == nil {
		if _, ok := readAttachment(path, info, hash); ok {
			return rel, false, nil
		}
		return "", false, fmt.Errorf("%s is in the way of an attachment", path)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", false, err
	}

	tmp, err := os.CreateTemp(dir, ".pedit-*.tmp")
	if err != nil {
		return "", false, err
	}
	_, err = tmp.Write(content)
	// Keep CreateTemp's private permissions, including the caller's umask.
	err = errors.Join(err, tmp.Close())
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return "", false, err
	}
	return rel, true, nil
}

// load reads an attachment saved in Dir, if it is there and intact.
func (a *Attachments) load(hash string) ([]byte, string, bool) {
	if !protocol.ValidHash(hash) {
		return nil, "", false
	}
	dir, err := a.dir(false)
	if err != nil {
		return nil, "", false
	}
	for mime, ext := range extensions {
		path := filepath.Join(dir, hash+ext)
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}
		content, ok := readAttachment(path, info, hash)
		if ok && http.DetectContentType(content) == mime {
			return content, mime, true
		}
	}
	return nil, "", false
}

// readAttachment reads a regular file (never a symlink) of up to MaxBytes
// whose content matches hash.
func readAttachment(path string, info fs.FileInfo, hash string) ([]byte, bool) {
	if !info.Mode().IsRegular() || info.Size() > MaxBytes {
		return nil, false
	}
	content, err := os.ReadFile(path)
	if err != nil || protocol.ContentHash(content) != hash {
		return nil, false
	}
	return content, true
}

// dir returns Dir beside the shared file, creating it if asked. It refuses a
// Dir that is not a directory, or that leads outside the file's directory.
func (a *Attachments) dir(create bool) (string, error) {
	base := filepath.Dir(a.opts.File)
	dir := filepath.Join(base, Dir)
	if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
		if !create {
			return "", err
		}
		if err := os.Mkdir(dir, 0o755); err != nil {
			return "", err
		}
		return dir, nil
	} else if err != nil {
		return "", err
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(realBase, realDir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errOutside
	}
	if info, err := os.Stat(realDir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", dir)
	}
	return dir, nil
}
