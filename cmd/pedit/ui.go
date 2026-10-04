package main

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/piconic-ai/edit/internal/protocol"
)

// ui is what the person sharing the file reads. They are not necessarily an
// engineer, so it avoids jargon, puts the link to send first, and says what
// to do next. Everything is indented by two spaces and grouped by blank lines.
//
// The last line shows who is here and is rewritten in place on a terminal.
type ui struct {
	out   io.Writer
	tty   bool
	color bool

	mu       sync.Mutex
	live     bool
	status   protocol.Status
	people   []string
	lastLine string
	// signingIn is set while the sign-in block is on the alternate screen.
	signingIn bool
}

func newUI(out io.Writer, tty, noColor bool) *ui {
	return &ui{out: out, tty: tty, color: tty && !noColor, status: protocol.StatusConnecting}
}

func (u *ui) paint(code, s string) string {
	if !u.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (u *ui) bold(s string) string   { return u.paint("1", s) }
func (u *ui) dim(s string) string    { return u.paint("2", s) }
func (u *ui) green(s string) string  { return u.paint("32", s) }
func (u *ui) yellow(s string) string { return u.paint("33", s) }
func (u *ui) link(s string) string   { return u.paint("36;4", s) }

func (u *ui) print(lines ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, line := range lines {
		if line == "" {
			fmt.Fprintln(u.out)
		} else {
			fmt.Fprintln(u.out, "  "+line)
		}
	}
}

// signIn is shown while the browser is open to sign in. On a terminal it
// goes on the alternate screen, like less or vim, so that endSignIn brings
// back the screen as it was: nothing to count or erase, whatever the user
// types or however they resize the window meanwhile.
func (u *ui) signIn(host, url string) {
	u.mu.Lock()
	if u.tty && !u.signingIn {
		fmt.Fprint(u.out, "\x1b[?1049h\x1b[H")
		u.signingIn = true
	}
	u.mu.Unlock()
	u.print(
		"",
		u.bold("Sign in to "+host),
		"Your browser opened. Sign in there, then come back here.",
		"",
		u.dim("If it did not open, use this link:"),
		u.dim(url),
		"",
		"Clicked Deny, or changed your mind? Press Ctrl+C to stop.",
	)
}

// signInCancelled is shown when the user stopped signing in with Ctrl+C.
func (u *ui) signInCancelled() {
	u.print("", "Sign-in cancelled. Nothing was shared.", "")
}

// signInTimedOut is shown when signing in took longer than limit.
func (u *ui) signInTimedOut(limit time.Duration) {
	u.print("", u.yellow("Sign-in did not finish in "+minutes(limit)+".")+" Run pedit again to try again.", "")
}

func minutes(d time.Duration) string {
	if m := int(d.Minutes()); m != 1 {
		return fmt.Sprintf("%d minutes", m)
	}
	return "1 minute"
}

// endSignIn leaves the alternate screen, if signIn went there. Call it
// whether or not signing in worked, before printing anything else.
func (u *ui) endSignIn() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.signingIn {
		fmt.Fprint(u.out, "\x1b[?1049l")
		u.signingIn = false
	}
}

func (u *ui) signedIn(email string) {
	if email != "" {
		u.print("", u.green("✓")+" Signed in as "+email)
	}
}

// sharing shows the link to send, then starts the live line.
// With scratch set, it also says how to come back to the new file.
func (u *ui) sharing(file, url string, copied, scratch bool) {
	lines := []string{
		"",
		u.bold(file + " is ready to write together."),
		"",
		"Send this link to the people you want to invite:",
		"  " + u.link(url),
	}
	if copied {
		lines = append(lines, "  "+u.dim("Copied to your clipboard."))
	}
	lines = append(lines, "", u.dim("Press Ctrl+C when you are done. Everything is saved to "+file+"."), "")
	if scratch {
		lines = append(lines, u.resume(file), "")
	}
	u.print(lines...)

	u.mu.Lock()
	defer u.mu.Unlock()
	u.live = true
	u.render()
}

// joined says where the room's file is mirrored, and what happens to the copy
// on leaving: a temporary one is removed, one placed with -d stays.
func (u *ui) joined(file string, temporary, copied bool) {
	lines := []string{
		"",
		u.bold("Joined. Your copy of the shared file:"),
		"  " + u.link(file),
	}
	if copied {
		lines = append(lines, "  "+u.dim("Copied to your clipboard."))
	}
	lines = append(lines, "", "Edit it with any editor; changes sync both ways while you are in the room.")
	if temporary {
		lines = append(lines, u.dim("Press Ctrl+C to leave. The copy is temporary and removed then; -d <dir> keeps one."))
	} else {
		lines = append(lines, u.dim("Press Ctrl+C to leave. Your copy stays in "+file+"."))
	}
	lines = append(lines, "")
	u.print(lines...)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.live = true
	u.render()
}

// hostLeft explains why the session ends on its own.
func (u *ui) hostLeft() {
	u.print("", u.yellow("The host closed the room."))
}

// left confirms the copy is saved after leaving a room.
func (u *ui) left(file string) {
	u.print(u.green("✓")+" Saved "+file+". It no longer syncs with the room.", "")
}

// leftTemporary confirms nothing is left behind after leaving a room.
func (u *ui) leftTemporary() {
	u.print("", u.green("✓")+" Left the room. The temporary copy was removed.", "")
}

func (u *ui) setStatus(s protocol.Status) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status = s
	u.render()
}

func (u *ui) setPeople(names []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.people = names
	u.render()
}

// imageSaved says that an image someone pasted was written to the host's
// disk. On a terminal it goes above the live line, which is drawn again.
func (u *ui) imageSaved(path string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.live && u.tty {
		fmt.Fprint(u.out, "\r\x1b[2K")
		u.lastLine = ""
	}
	fmt.Fprintln(u.out, "  "+u.dim("Saved an image to "+path))
	u.render()
}

// stopLive ends the live line, leaving its last state on screen.
func (u *ui) stopLive() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.live && u.tty {
		fmt.Fprintln(u.out)
	}
	u.live = false
}

func (u *ui) saving(file string) {
	u.print("", "Saving "+file+"…")
}

func (u *ui) saved(file string) {
	u.print(u.green("✓")+" Saved "+file+". The link no longer works.", "")
}

// scratch names the scratch file pedit created and how to open it again.
func (u *ui) scratch(file string) {
	u.print("Saved to "+file, u.resume(file), "")
}

func (u *ui) resume(file string) string {
	return "Resume with: " + u.bold("pedit "+file)
}

// render redraws the live line. Callers hold u.mu.
func (u *ui) render() {
	if !u.live {
		return
	}
	line := u.liveLine()
	if line == u.lastLine {
		return
	}
	u.lastLine = line
	if u.tty {
		fmt.Fprint(u.out, "\r\x1b[2K  "+line)
	} else {
		fmt.Fprintln(u.out, "  "+line)
	}
}

func (u *ui) liveLine() string {
	switch u.status {
	case protocol.StatusConnected:
		return u.green("●") + " " + whoIsHere(u.people)
	case protocol.StatusDisconnected:
		return u.yellow("○") + " Offline. Reconnecting…"
	case protocol.StatusClosed:
		return u.yellow("○") + " Closed."
	default:
		return u.yellow("○") + " Connecting…"
	}
}

// whoIsHere names up to three people and counts the rest, so the line stays short.
func whoIsHere(names []string) string {
	switch n := len(names); {
	case n == 0:
		return "Just you so far"
	case n == 1:
		return names[0] + " is here"
	case n == 2:
		return names[0] + " and " + names[1] + " are here"
	case n == 3:
		return names[0] + ", " + names[1] + " and " + names[2] + " are here"
	default:
		return fmt.Sprintf("%s, %s and %d others are here", names[0], names[1], n-2)
	}
}

// hostOf is the server as people know it: its host name.
func hostOf(server string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
	return strings.TrimRight(s, "/")
}
