package main

import (
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestUIWithoutTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.setStatus(protocol.StatusConnected) // not shown before sharing
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=abc")
	u.signedIn("k@example.com")
	u.sharing("notes.md", "https://pedit.example.com/r/AAAA#key", true, false)
	u.setPeople([]string{"Alice"})
	u.setPeople([]string{"Alice"}) // unchanged
	u.setStatus(protocol.StatusDisconnected)
	u.setStatus(protocol.StatusConnected)
	u.setPeople([]string{"Alice", "Bob"})
	u.stopLive()
	u.setPeople(nil) // not shown after stopping
	u.saving("notes.md")
	u.saved("notes.md")

	want := `
  Sign in to pedit.example.com
  Your browser opened. Sign in there, then come back here.

  If it did not open, use this link:
  https://pedit.example.com/cdn-cgi/access/cli?token=abc

  Clicked Deny, or changed your mind? Press Ctrl+C to stop.

  ✓ Signed in as k@example.com

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://pedit.example.com/r/AAAA#key
    Copied to your clipboard.

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Just you so far
  ● Alice is here
  ○ Offline. Reconnecting…
  ● Alice is here
  ● Alice and Bob are here

  Saving notes.md…
  ✓ Saved notes.md. The link no longer works.

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatal("escape codes outside a terminal")
	}
}

func TestUIOnTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.sharing("notes.md", "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.stopLive()
	got := out.String()
	for _, want := range []string{
		"\x1b[1mnotes.md is ready to write together.\x1b[0m",
		"    \x1b[36;4mhttps://pedit.example.com/r/AAAA#key\x1b[0m\n",
		// The live line is rewritten in place.
		"\r\x1b[2K  \x1b[33m○\x1b[0m Connecting…",
		"\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "clipboard") {
		t.Error("claims the link was copied")
	}
}

func TestUIImageSaved(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.sharing("notes.md", "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.imageSaved("assets/0123.png")
	if !strings.HasSuffix(out.String(), "  ● Just you so far\n  Saved an image to assets/0123.png\n") {
		t.Fatalf("got %q", out.String())
	}

	// On a terminal it goes above the live line, which comes back.
	out.Reset()
	u = newUI(&out, true, false)
	u.sharing("notes.md", "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.imageSaved("assets/0123.png")
	want := "\r\x1b[2K  \x1b[2mSaved an image to assets/0123.png\x1b[0m\n\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far"
	if !strings.HasSuffix(out.String(), want) {
		t.Fatalf("got %q", out.String())
	}
}

func TestUIWithoutColor(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, true) // NO_COLOR
	u.sharing("notes.md", "https://pedit.example.com/r/AAAA#key", true, false)
	u.saved("notes.md")
	if got := out.String(); strings.Contains(got, "\x1b[1m") || strings.Contains(got, "\x1b[3") {
		t.Fatalf("colors despite NO_COLOR: %q", got)
	}
}

func TestUIScratch(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.sharing("pedit-2026-09-26-143012.md", "https://pedit.example.com/r/AAAA#key", false, true)
	u.stopLive()
	u.saved("pedit-2026-09-26-143012.md")
	u.scratch("pedit-2026-09-26-143012.md")
	want := `
  pedit-2026-09-26-143012.md is ready to write together.

  Send this link to the people you want to invite:
    https://pedit.example.com/r/AAAA#key

  Press Ctrl+C when you are done. Everything is saved to pedit-2026-09-26-143012.md.

  Resume with: pedit pedit-2026-09-26-143012.md

  ○ Connecting…
  ✓ Saved pedit-2026-09-26-143012.md. The link no longer works.

  Saved to pedit-2026-09-26-143012.md
  Resume with: pedit pedit-2026-09-26-143012.md

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestUISignsInOnAlternateScreen(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=abc")
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=def") // stays put
	u.endSignIn()
	u.endSignIn() // no-op
	u.signedIn("k@example.com")
	got := out.String()
	if strings.Count(got, "\x1b[?1049h") != 1 || strings.Count(got, "\x1b[?1049l") != 1 {
		t.Fatalf("enters or leaves the alternate screen more than once: %q", got)
	}
	enter, sign, leave, done := strings.Index(got, "\x1b[?1049h"), strings.Index(got, "Sign in to"), strings.Index(got, "\x1b[?1049l"), strings.Index(got, "Signed in as")
	if !(enter < sign && sign < leave && leave < done) {
		t.Fatalf("sign-in block is not on the alternate screen: %q", got)
	}
}

func TestUILeavesAlternateScreenWhenSignInFails(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli")
	u.endSignIn()
	if got := out.String(); !strings.HasSuffix(got, "\x1b[?1049l") {
		t.Fatalf("got %q", got)
	}
}

func TestUIKeepsSignInWithoutTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli")
	u.endSignIn()
	u.signedIn("")
	if got := out.String(); strings.Contains(got, "\x1b[") || !strings.Contains(got, "Sign in to pedit.example.com") {
		t.Fatalf("got %q", got)
	}
}

func TestUIWhenSignInStops(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.signInCancelled()
	u.signInTimedOut(5 * time.Minute)
	want := `
  Sign-in cancelled. Nothing was shared.


  Sign-in did not finish in 5 minutes. Run pedit again to try again.

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestMinutes(t *testing.T) {
	for d, want := range map[time.Duration]string{time.Minute: "1 minute", 5 * time.Minute: "5 minutes"} {
		if got := minutes(d); got != want {
			t.Errorf("minutes(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestWhoIsHere(t *testing.T) {
	tests := []struct {
		names []string
		want  string
	}{
		{nil, "Just you so far"},
		{[]string{"Alice"}, "Alice is here"},
		{[]string{"Alice", "Bob"}, "Alice and Bob are here"},
		{[]string{"Alice", "Bob", "Carol"}, "Alice, Bob and Carol are here"},
		{[]string{"Alice", "Bob", "Carol", "Dave"}, "Alice, Bob and 2 others are here"},
	}
	for _, tt := range tests {
		if got := whoIsHere(tt.names); got != tt.want {
			t.Errorf("whoIsHere(%q) = %q, want %q", tt.names, got, tt.want)
		}
	}
}

func TestHostOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://edit-lab.piconic.ai":  "edit-lab.piconic.ai",
		"https://edit-lab.piconic.ai/": "edit-lab.piconic.ai",
		"http://localhost:8787":        "localhost:8787",
	} {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q", in, got)
		}
	}
}
