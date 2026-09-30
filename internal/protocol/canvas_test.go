package protocol_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/piconic-ai/edit/internal/protocol"
)

func TestCanvasRoundTrip(t *testing.T) {
	for _, m := range []protocol.CanvasMessage{
		{Kind: protocol.CanvasEdit, ID: "e1", Base: `{"nodes":[]}`, Next: `{"nodes":[{"id":"居間"}]}`},
		{Kind: protocol.CanvasEdit, ID: "e2", Base: "", Next: ""},
		{Kind: protocol.CanvasApplied, ID: "e1"},
		{Kind: protocol.CanvasRejected, ID: "e1", Reason: "board.canvas:1:2: nodes[0]: has no \"x\""},
	} {
		data, err := protocol.EncodeCanvas(m)
		if err != nil {
			t.Fatalf("EncodeCanvas(%+v): %v", m, err)
		}
		got, err := protocol.DecodeCanvas(data)
		if err != nil || !reflect.DeepEqual(got, m) {
			t.Errorf("DecodeCanvas = %+v, %v; want %+v", got, err, m)
		}
	}
}

func TestCanvasRefusesWhatDoesNotFit(t *testing.T) {
	big := strings.Repeat("x", protocol.MaxCanvasEditBytes/2+1)
	for name, m := range map[string]protocol.CanvasMessage{
		"no id":        {Kind: protocol.CanvasApplied},
		"long id":      {Kind: protocol.CanvasApplied, ID: strings.Repeat("i", 65)},
		"too large":    {Kind: protocol.CanvasEdit, ID: "e", Base: big, Next: big},
		"not UTF-8":    {Kind: protocol.CanvasEdit, ID: "e", Next: "\xff"},
		"no reason":    {Kind: protocol.CanvasRejected, ID: "e"},
		"unknown kind": {Kind: 9, ID: "e"},
	} {
		if _, err := protocol.EncodeCanvas(m); err == nil {
			t.Errorf("%s: EncodeCanvas accepted %+v", name, m)
		}
	}
}

func TestDecodeCanvasRejectsMalformed(t *testing.T) {
	valid, _ := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e", Base: "a", Next: "b"})
	for name, data := range map[string][]byte{
		"empty":     {},
		"truncated": valid[:len(valid)-1],
		"trailing":  append(append([]byte{}, valid...), 0),
		"bad UTF-8": {byte(protocol.CanvasApplied), 1, 0xff},
	} {
		if _, err := protocol.DecodeCanvas(data); err == nil {
			t.Errorf("%s: decoded", name)
		}
	}
	if _, err := protocol.DecodeCanvas([]byte{9, 1, 'e'}); !errors.Is(err, protocol.ErrUnknownCanvasKind) {
		t.Errorf("unknown kind: %v", err)
	}
}

// Pins the layout, which packages/protocol/test/canvas.test.ts pins too.
func TestCanvasLayout(t *testing.T) {
	data, err := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e", Base: "{}", Next: "x"})
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{0, 1, 'e', 2, '{', '}', 1, 'x'}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("EncodeCanvas = %v, want %v", data, want)
	}
}
