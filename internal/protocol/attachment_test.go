package protocol_test

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/piconic-ai/edit/internal/protocol"
)

const (
	hashA = "0123456789abcdef0123456789abcdef"
	hashB = "fedcba9876543210fedcba9876543210"
)

func TestAttachmentRoundTrip(t *testing.T) {
	for _, a := range []protocol.Attachment{
		{Kind: protocol.AttachmentAnnounce, Hash: hashA, Mime: "image/png"},
		{Kind: protocol.AttachmentWant, Hashes: []string{hashA, hashB}},
		{Kind: protocol.AttachmentStored, Hash: hashA, Path: "assets/居間.png"},
		{Kind: protocol.AttachmentRejected, Hash: hashA, Reason: "too_large"},
	} {
		data, err := protocol.EncodeAttachment(a)
		if err != nil {
			t.Fatalf("EncodeAttachment(%+v): %v", a, err)
		}
		got, err := protocol.DecodeAttachment(data)
		if err != nil || !reflect.DeepEqual(got, a) {
			t.Fatalf("DecodeAttachment = %+v, %v, want %+v", got, err, a)
		}
	}
}

// Pins the layout, which packages/protocol/test/attachment.test.ts pins too.
func TestAttachmentLayout(t *testing.T) {
	data, err := protocol.EncodeAttachment(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: hashA, Path: "a.png"})
	if err != nil {
		t.Fatal(err)
	}
	want := append(append([]byte{2, 32}, hashA...), append([]byte{5}, "a.png"...)...)
	if !bytes.Equal(data, want) {
		t.Fatalf("EncodeAttachment = %v, want %v", data, want)
	}
}

func TestAttachmentRejectsInvalid(t *testing.T) {
	for _, a := range []protocol.Attachment{
		{Kind: protocol.AttachmentAnnounce, Hash: "ABC", Mime: "image/png"},
		{Kind: protocol.AttachmentAnnounce, Hash: hashA},
		{Kind: protocol.AttachmentWant},
		{Kind: protocol.AttachmentWant, Hashes: []string{hashA, "nope"}},
		{Kind: protocol.AttachmentWant, Hashes: make([]string, protocol.MaxWantHashes+1)},
		{Kind: protocol.AttachmentStored, Hash: hashA, Path: strings.Repeat("a", 1025)},
		{Kind: protocol.AttachmentRejected, Hash: hashA},
		{Kind: protocol.AttachmentStored, Hash: hashA, Path: "assets/\xff.png"},
		{Kind: 9, Hash: hashA},
	} {
		if _, err := protocol.EncodeAttachment(a); err == nil {
			t.Errorf("EncodeAttachment(%+v) should fail", a)
		}
	}

	valid, _ := protocol.EncodeAttachment(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hashA, Mime: "image/png"})
	if _, err := protocol.DecodeAttachment([]byte{9}); !errors.Is(err, protocol.ErrUnknownAttachmentKind) {
		t.Errorf("DecodeAttachment(unknown kind) = %v, want ErrUnknownAttachmentKind", err)
	}
	for name, data := range map[string][]byte{
		"empty":         {},
		"truncated":     valid[:len(valid)-1],
		"trailing":      append(append([]byte{}, valid...), 0),
		"too many":      {1, 0x81, 0x02}, // 257 hashes
		"invalid utf-8": append(append([]byte{3, 32}, hashA...), 2, 0xff, 0xfe),
	} {
		if _, err := protocol.DecodeAttachment(data); err == nil || errors.Is(err, protocol.ErrUnknownAttachmentKind) {
			t.Errorf("DecodeAttachment(%s) = %v, want a malformed error", name, err)
		}
	}
}
