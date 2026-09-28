// Command ima shares a local text file and co-edits it with others in their browser.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/piconic-ai/ima/internal/access"
	"github.com/piconic-ai/ima/internal/clipboard"
	"github.com/piconic-ai/ima/internal/session"
	"golang.org/x/term"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = ""

// getVersion falls back to the module version, which `go install ...@vX.Y.Z` records.
func getVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

const defaultServer = "https://ima.piconic.ai"

const usage = `Usage: ima [file]

Share a local text file and co-edit it with others in their browser.
Edits are written back to the file. Press Ctrl+C to finish.
Without a file, ima starts on a new empty ima-<time>.md in the current directory.

Environment:
  IMA_SERVER  ima server URL (default: ` + defaultServer + `)

A server behind Cloudflare Access signs you in with cloudflared.`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(stdout, usage)
		return 0
	}
	if len(args) == 1 && (args[0] == "-v" || args[0] == "--version") {
		fmt.Fprintln(stdout, getVersion())
		return 0
	}
	if len(args) > 1 || (len(args) == 1 && args[0] == "") {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	out := newUI(stdout, isTerminal(stdout), os.Getenv("NO_COLOR") != "")

	var arg string
	var shared bool
	scratch := len(args) == 0
	if scratch {
		name, err := createScratch(".", func() string { return time.Now().Format("2006-01-02-150405") })
		if err != nil {
			dir, _ := os.Getwd()
			fmt.Fprintf(stderr, "ima: could not create a scratch file in %s: %v\nRun ima <file> to share an existing file instead.\n", dir, err)
			return 1
		}
		arg = name
		// Say where the text is if ima ends before sharing it; finish
		// says so once it is shared.
		defer func() {
			if !shared {
				out.scratch(arg)
			}
		}()
	} else {
		arg = args[0]
	}
	file, err := filepath.Abs(arg)
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}
	if msg := checkFile(arg); msg != "" {
		fmt.Fprintln(stderr, msg)
		return 1
	}

	server := os.Getenv("IMA_SERVER")
	if server == "" {
		server = defaultServer
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-signals
		cancel()
	}()

	cloudflared := &access.Cloudflared{OnSignIn: func(url string) { out.signIn(hostOf(server), url) }}
	signIn := func(ctx context.Context, app string) (string, error) {
		token, err := withSignInLimit(ctx, signInLimit, app, cloudflared.Token)
		out.endSignIn()
		if err == nil {
			out.signedIn(access.Email(token))
		}
		return token, err
	}
	s, err := start(ctx, signIn, session.Options{
		File:     file,
		Server:   server,
		Name:     username(),
		Watch:    true,
		OnStatus: out.setStatus,
		OnPeople: out.setPeople,
		OnSaved: func(path string) {
			out.imageSaved(filepath.Join(filepath.Dir(arg), filepath.FromSlash(path)))
		},
		OnError: func(err error) {
			if os.Getenv("IMA_DEBUG") != "" {
				fmt.Fprintln(stderr, "\nima:", err)
			}
		},
	})
	switch {
	case errors.Is(err, errSignInCancelled):
		out.signInCancelled()
		return 130
	case errors.Is(err, errSignInTimedOut):
		out.signInTimedOut(signInLimit)
		return 1
	case err != nil:
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}

	out.sharing(arg, s.URL, clipboard.Copy(s.URL), scratch)
	shared = true

	<-ctx.Done()
	// A second signal gives up on saving.
	go func() {
		<-signals
		os.Exit(130)
	}()
	return finish(out, stderr, arg, scratch, s.Stop)
}

// finish saves the file and closes the room. It points to a scratch file
// only once it is saved, so a failed save never reads as a safe one.
func finish(out *ui, stderr io.Writer, arg string, scratch bool, stop func() error) int {
	out.stopLive()
	out.saving(arg)
	if err := stop(); err != nil {
		fmt.Fprintf(stderr, "ima: could not save %s: %v\n", arg, err)
		return 1
	}
	out.saved(arg)
	if scratch {
		out.scratch(arg)
	}
	return 0
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

func username() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return u.Username
}

// signInLimit is how long ima waits for the user to sign in. cloudflared
// cannot tell when the user clicks Deny, so without a limit ima would wait
// for as long as cloudflared does.
const signInLimit = 5 * time.Minute

var (
	errSignInCancelled = errors.New("sign-in cancelled")
	errSignInTimedOut  = errors.New("sign-in timed out")
)

// withSignInLimit gets a token, giving up after limit. It tells the user
// stopping (ctx cancelled) apart from running out of time.
func withSignInLimit(ctx context.Context, limit time.Duration, app string, token func(context.Context, string) (string, error)) (string, error) {
	limited, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	t, err := token(limited, app)
	switch {
	case err == nil:
		return t, nil
	case ctx.Err() != nil:
		return "", errSignInCancelled
	case errors.Is(err, context.DeadlineExceeded):
		return "", errSignInTimedOut
	default:
		return "", err
	}
}

// start shares the file, signing in with Cloudflare Access when the server is
// behind it.
func start(ctx context.Context, signIn func(context.Context, string) (string, error), opts session.Options) (*session.Session, error) {
	s, err := session.Start(ctx, opts)
	if !errors.Is(err, session.ErrBehindAccess) {
		return s, err
	}
	token, err := signIn(ctx, opts.Server)
	if errors.Is(err, access.ErrNoCloudflared) {
		return nil, fmt.Errorf("%s is behind Cloudflare Access. Install cloudflared to sign in (for example, brew install cloudflared) and run ima again", opts.Server)
	}
	if err != nil {
		return nil, err
	}
	opts.Header = http.Header{access.Header: {token}}
	if email := access.Email(token); email != "" {
		opts.Avatar = gravatarURL(email)
	}
	s, err = session.Start(ctx, opts)
	if errors.Is(err, session.ErrBehindAccess) {
		// Signed in, yet turned away: the session was revoked, or this
		// account is not allowed in. cloudflared keeps the token until it
		// expires, so it has to be removed to sign in again.
		return nil, fmt.Errorf("%s did not accept your sign-in. To sign in again, remove the saved sign-in (rm ~/.cloudflared/*-token) and run ima again. If it still fails, ask whoever runs the server to let you in", opts.Server)
	}
	return s, err
}

// gravatarURL matches the web editor's: 404 for unknown emails, so others see initials.
func gravatarURL(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return "https://gravatar.com/avatar/" + hex.EncodeToString(sum[:]) + "?s=64&d=404"
}
