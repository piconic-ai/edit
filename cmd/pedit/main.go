// Command pedit shares a local text file and co-edits it with others in their browser.
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

	"github.com/piconic-ai/edit/internal/access"
	"github.com/piconic-ai/edit/internal/clipboard"
	"github.com/piconic-ai/edit/internal/session"
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

const defaultServer = "https://edit.piconic.ai"

const usage = `Usage: pedit [file] [-t template] [-d directory]

Share an existing UTF-8 text file. Send the printed link to collaborators;
open it yourself to edit together in the browser. No install needed for guests.
Edits are written back to your local file as you work. Press Ctrl+C to save
the final state and close the room. Changes from your local editor sync too.
Without a file, pedit creates pedit-<time>.md in the configured output directory.

Examples:
  pedit notes.md       Share an existing Markdown file
  pedit                Create and share a new Markdown file
  pedit -t minutes.md  Create minutes-<time>.md from a template
  pedit -t minutes.md -d meetings  Create the file in meetings/
  pedit --csv          Create a table from default.csv
  pedit --canvas       Create a board from default.canvas
  pedit data.csv       Share a table (any UTF-8 text file works)

Markdown supports previews and pasted images, saved beside your file in assets/.
Anyone with the full link can read and edit while the session is open.

Options:
  -t, --template <name>  Use a template filename or type (csv, canvas, md)
  --<name>              Template shorthand (for example, --canvas)
  -d, --directory <dir>  Save a new file here (overrides config output)
  -h, --help             Show this help
  -v, --version          Show the version

Configuration:
  .pedit/config.yaml  Server and output. Templates live in .pedit/templates/.
  Created automatically on first use at a Git repository root.
  Default server: ` + defaultServer + `

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
	opts, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		fmt.Fprintln(stderr, usage)
		return 2
	}
	out := newUI(stdout, isTerminal(stdout), os.Getenv("NO_COLOR") != "")
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	cfg, err := loadConfig(cwd)
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	var shared bool
	scratch := opts.File == ""
	arg, created, err := prepareFile(cfg, opts.File, opts.Template, opts.Directory, func() string { return time.Now().Format("2006-01-02-150405") })
	if err != nil {
		if scratch {
			fmt.Fprintf(stderr, "pedit: could not create a scratch file in %s: %v\nRun pedit <file> to share an existing file instead.\n", outputDirectory(cfg, opts.Directory), err)
		} else {
			fmt.Fprintln(stderr, "pedit:", err)
		}
		return 1
	}
	scratch = created
	if scratch {
		defer func() {
			if !shared {
				out.scratch(arg)
			}
		}()
	}
	file, err := filepath.Abs(arg)
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	if msg := checkFile(arg); msg != "" {
		fmt.Fprintln(stderr, msg)
		return 1
	}

	server := cfg.Server

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
			if os.Getenv("PEDIT_DEBUG") != "" {
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
		fmt.Fprintln(stderr, "pedit:", err)
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
		fmt.Fprintf(stderr, "pedit: could not save %s: %v\n", arg, err)
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

// signInLimit is how long pedit waits for the user to sign in. cloudflared
// cannot tell when the user clicks Deny, so without a limit pedit would wait
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
		return nil, fmt.Errorf("%s is behind Cloudflare Access. Install cloudflared to sign in (for example, brew install cloudflared) and run pedit again", opts.Server)
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
		return nil, fmt.Errorf("%s did not accept your sign-in. To sign in again, remove the saved sign-in (rm ~/.cloudflared/*-token) and run pedit again. If it still fails, ask whoever runs the server to let you in", opts.Server)
	}
	return s, err
}

// gravatarURL matches the web editor's: 404 for unknown emails, so others see initials.
func gravatarURL(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return "https://gravatar.com/avatar/" + hex.EncodeToString(sum[:]) + "?s=64&d=404"
}
