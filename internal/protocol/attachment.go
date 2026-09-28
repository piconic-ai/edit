package protocol

import (
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/reearth/ygo/encoding"
)

// AttachmentKind says what an attachment message is about.
type AttachmentKind uint64

// Attachment messages coordinate images whose bytes travel through the
// server's blob store, never through the relay.
const (
	// AttachmentAnnounce: someone uploaded the attachment with this content hash.
	AttachmentAnnounce AttachmentKind = 0
	// AttachmentWant: someone needs these attachments and could not fetch them.
	AttachmentWant AttachmentKind = 1
	// AttachmentStored: the host wrote the attachment to Path, relative to the shared file.
	AttachmentStored AttachmentKind = 2
	// AttachmentRejected: the host refused it, for Reason.
	AttachmentRejected AttachmentKind = 3
)

// MaxWantHashes caps the hashes in one Want message.
const MaxWantHashes = 256

// Limits in UTF-8 bytes, the same as the web client's.
const (
	maxMime   = 100
	maxPath   = 1024
	maxReason = 64
)

// Attachment is one attachment message. Which fields are set depends on Kind:
// Announce has Hash and Mime, Want has Hashes, Stored has Hash and Path,
// Rejected has Hash and Reason.
type Attachment struct {
	Kind   AttachmentKind
	Hash   string
	Mime   string
	Path   string
	Reason string
	Hashes []string
}

var errTruncated = errors.New("truncated attachment message")

// ErrUnknownAttachmentKind marks an attachment kind this version does not
// know, from a newer peer. Clients skip such messages instead of reporting them.
var ErrUnknownAttachmentKind = errors.New("unknown attachment kind")

func EncodeAttachment(a Attachment) ([]byte, error) {
	if err := a.validate(); err != nil {
		return nil, err
	}
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(a.Kind))
	writeString := func(s string) { enc.WriteVarBytes([]byte(s)) }
	switch a.Kind {
	case AttachmentAnnounce:
		writeString(a.Hash)
		writeString(a.Mime)
	case AttachmentWant:
		enc.WriteVarUint(uint64(len(a.Hashes)))
		for _, h := range a.Hashes {
			writeString(h)
		}
	case AttachmentStored:
		writeString(a.Hash)
		writeString(a.Path)
	case AttachmentRejected:
		writeString(a.Hash)
		writeString(a.Reason)
	}
	return enc.Bytes(), nil
}

// DecodeAttachment fails on malformed payloads, and with ErrUnknownAttachmentKind
// on kinds this version does not know.
func DecodeAttachment(payload []byte) (Attachment, error) {
	dec := encoding.NewDecoder(payload)
	var err error
	readUint := func() uint64 {
		if err != nil {
			return 0
		}
		var v uint64
		if v, err = dec.ReadVarUint(); err != nil {
			err = errTruncated
		}
		return v
	}
	readString := func() string {
		if err != nil {
			return ""
		}
		var b []byte
		if b, err = dec.ReadVarBytes(); err != nil {
			err = errTruncated
			return ""
		}
		return string(b) // validate checks UTF-8
	}

	a := Attachment{Kind: AttachmentKind(readUint())}
	if err != nil {
		return Attachment{}, err
	}
	switch a.Kind {
	case AttachmentAnnounce:
		a.Hash, a.Mime = readString(), readString()
	case AttachmentWant:
		n := readUint()
		if err == nil && n > MaxWantHashes {
			return Attachment{}, errors.New("too many hashes")
		}
		for i := uint64(0); i < n && err == nil; i++ {
			a.Hashes = append(a.Hashes, readString())
		}
	case AttachmentStored:
		a.Hash, a.Path = readString(), readString()
	case AttachmentRejected:
		a.Hash, a.Reason = readString(), readString()
	default:
		return Attachment{}, fmt.Errorf("%w: %d", ErrUnknownAttachmentKind, a.Kind)
	}
	if err != nil {
		return Attachment{}, err
	}
	if dec.HasContent() {
		return Attachment{}, errors.New("trailing bytes in attachment message")
	}
	if err := a.validate(); err != nil {
		return Attachment{}, err
	}
	return a, nil
}

func (a Attachment) validate() error {
	hash := func(h string) error {
		if !ValidHash(h) {
			return fmt.Errorf("invalid content hash: %q", h)
		}
		return nil
	}
	text := func(s string, limit int, what string) error {
		// Go strings can hold invalid UTF-8 (a path from a file name, say):
		// fail here rather than on every receiver.
		if len(s) == 0 || len(s) > limit || !utf8.ValidString(s) {
			return fmt.Errorf("invalid %s", what)
		}
		return nil
	}
	switch a.Kind {
	case AttachmentAnnounce:
		return errors.Join(hash(a.Hash), text(a.Mime, maxMime, "mime type"))
	case AttachmentWant:
		if len(a.Hashes) == 0 || len(a.Hashes) > MaxWantHashes {
			return errors.New("invalid hash count")
		}
		for _, h := range a.Hashes {
			if err := hash(h); err != nil {
				return err
			}
		}
		return nil
	case AttachmentStored:
		return errors.Join(hash(a.Hash), text(a.Path, maxPath, "path"))
	case AttachmentRejected:
		return errors.Join(hash(a.Hash), text(a.Reason, maxReason, "reason"))
	}
	return fmt.Errorf("unknown attachment kind: %d", a.Kind)
}
