package protocol_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/piconic-ai/ima/internal/protocol"
)

// blobVectors pins the attachment crypto so the TypeScript side
// (packages/protocol/test/blob.test.ts) can check it computes the same.
// Regenerate with IMA_UPDATE_VECTORS=1 go test ./internal/protocol/.
const blobVectorsFile = "testdata/blob-vectors.json"

type blobVectors struct {
	Key   string       `json:"key"`
	Cases []blobVector `json:"cases"`
}

type blobVector struct {
	Plaintext string `json:"plaintext"` // hex
	Hash      string `json:"hash"`
	BlobID    string `json:"blobId"`
	Blob      string `json:"blob"` // base64url of iv || ciphertext
}

func vectorKey() string {
	raw := make([]byte, protocol.KeyBytes)
	for i := range raw {
		raw[i] = byte(i)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func blobKeys(t *testing.T, key string) *protocol.BlobKeys {
	t.Helper()
	raw, err := protocol.DecodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func TestBlobVectors(t *testing.T) {
	if os.Getenv("IMA_UPDATE_VECTORS") != "" {
		writeBlobVectors(t)
	}
	data, err := os.ReadFile(blobVectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var v blobVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	keys := blobKeys(t, v.Key)
	for _, c := range v.Cases {
		plaintext, _ := hex.DecodeString(c.Plaintext)
		if got := protocol.ContentHash(plaintext); got != c.Hash {
			t.Errorf("ContentHash(%s) = %s, want %s", c.Plaintext, got, c.Hash)
		}
		if got, err := keys.BlobID(c.Hash); err != nil || got != c.BlobID {
			t.Errorf("BlobID(%s) = %s, %v, want %s", c.Hash, got, err, c.BlobID)
		}
		blob, _ := base64.RawURLEncoding.DecodeString(c.Blob)
		if got, err := keys.Decrypt(blob, c.Hash); err != nil || !bytes.Equal(got, plaintext) {
			t.Errorf("Decrypt(%s) = %x, %v", c.Blob, got, err)
		}
	}
}

func writeBlobVectors(t *testing.T) {
	key := vectorKey()
	keys := blobKeys(t, key)
	v := blobVectors{Key: key}
	for _, p := range [][]byte{{}, []byte("hello, ima"), []byte("\x89PNG\r\n\x1a\n居間🌏")} {
		hash := protocol.ContentHash(p)
		id, err := keys.BlobID(hash)
		if err != nil {
			t.Fatal(err)
		}
		v.Cases = append(v.Cases, blobVector{
			Plaintext: hex.EncodeToString(p),
			Hash:      hash,
			BlobID:    id,
			Blob:      base64.RawURLEncoding.EncodeToString(keys.Encrypt(p)),
		})
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blobVectorsFile, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBlobKeys(t *testing.T) {
	key := protocol.GenerateKey()
	keys := blobKeys(t, key)
	content := []byte("an image")
	hash := protocol.ContentHash(content)

	t.Run("names content by hash", func(t *testing.T) {
		if !protocol.ValidHash(hash) {
			t.Fatalf("hash = %q", hash)
		}
		if protocol.ContentHash([]byte("another")) == hash {
			t.Fatal("hashes should differ")
		}
	})

	t.Run("derives blob ids per room", func(t *testing.T) {
		id, err := keys.BlobID(hash)
		if err != nil || !protocol.ValidBlobID(id) {
			t.Fatalf("BlobID = %q, %v", id, err)
		}
		again, _ := blobKeys(t, key).BlobID(hash)
		other, _ := blobKeys(t, protocol.GenerateKey()).BlobID(hash)
		if again != id || other == id {
			t.Fatalf("id=%s again=%s other=%s", id, again, other)
		}
		if _, err := keys.BlobID("not a hash"); err == nil {
			t.Fatal("expected an error for an invalid hash")
		}
	})

	t.Run("round-trips and checks the hash", func(t *testing.T) {
		blob := keys.Encrypt(content)
		got, err := keys.Decrypt(blob, hash)
		if err != nil || !bytes.Equal(got, content) {
			t.Fatalf("Decrypt = %q, %v", got, err)
		}
		if _, err := keys.Decrypt(blob, protocol.ContentHash([]byte("another"))); err == nil {
			t.Fatal("expected an error for a mismatched hash")
		}
		blob[len(blob)-1] ^= 1
		if _, err := keys.Decrypt(blob, hash); err == nil {
			t.Fatal("expected an error for tampered data")
		}
	})

	t.Run("keeps blobs and frames apart", func(t *testing.T) {
		raw, _ := protocol.DecodeKey(key)
		frames, _ := protocol.NewCipher(raw)
		if _, err := frames.Decrypt(keys.Encrypt(content)); err == nil {
			t.Fatal("a blob should not decrypt as a frame")
		}
		if _, err := keys.Decrypt(frames.Encrypt(content), hash); err == nil {
			t.Fatal("a frame should not decrypt as a blob")
		}
	})

	t.Run("rejects short keys", func(t *testing.T) {
		if _, err := protocol.DeriveBlobKeys([]byte("short")); err == nil {
			t.Fatal("expected an error")
		}
	})
}
