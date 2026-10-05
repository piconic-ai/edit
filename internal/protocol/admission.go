package protocol

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// AdmissionHeader carries a room capability, never the encryption key.
const AdmissionHeader = "X-Pedit-Admission"

const SocketProtocol = "pedit-v1"
const AdmissionProtocolPrefix = "pedit-admission."

// AdmissionToken derives a capability for relay access, domain-separated from
// all encryption keys. Knowing this token does not reveal document plaintext.
func AdmissionToken(key []byte) (string, error) {
	if len(key) != KeyBytes {
		return "", fmt.Errorf("key must be %d bytes", KeyBytes)
	}
	token, err := hkdf.Key(sha256.New, key, nil, "pedit admission v1", KeyBytes)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(token), nil
}
