package protocol_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

func TestDialDoesNotForwardAdmissionToRedirect(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	header := http.Header{"Sec-WebSocket-Protocol": {protocol.SocketProtocol + ", " + protocol.AdmissionProtocolPrefix + strings.Repeat("A", 43)}}
	conn, err := protocol.DialWebSocket(context.Background(), origin.URL, header)
	if conn != nil {
		conn.Close()
	}
	if err == nil || hits.Load() != 0 {
		t.Fatal("followed a credential-bearing redirect")
	}
}

// Independently computed HKDF-SHA256 vector, also checked by TypeScript.
func TestAdmissionToken(t *testing.T) {
	key := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	raw, _ := protocol.DecodeKey(key)
	token, err := protocol.AdmissionToken(raw)
	if err != nil {
		t.Fatal(err)
	}
	if token != "yLmGLPEIKTlJRTyTeaGzls7vTRq2eymHCb_TJWm55EI" {
		t.Fatalf("token = %q", token)
	}
	if _, err := protocol.AdmissionToken(raw[:31]); err == nil {
		t.Fatal("accepted invalid key")
	}
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil || keys.Admission != token {
		t.Fatalf("blob admission mismatch: %v", err)
	}
	relay := prototest.NewRelay(false)
	header := http.Header{"Cf-Access-Token": {"access-token"}}
	join(t, relay, key, joinOpts{header: header})
	prototest.WaitFor(t, wait, func() bool { return len(relay.Headers()) > 0 }, "handshake")
	got := relay.Headers()[0]
	if got.Get("Sec-WebSocket-Protocol") != protocol.SocketProtocol+", "+protocol.AdmissionProtocolPrefix+token {
		t.Fatal("admission missing from handshake")
	}
	if got.Get("Cf-Access-Token") != "access-token" || header.Get("Sec-WebSocket-Protocol") != "" {
		t.Fatal("Access header lost or caller header mutated")
	}
	if strings.Contains(got.Get("Sec-WebSocket-Protocol"), key) || strings.Contains(strings.Join(relay.URLs(), ""), token) {
		t.Fatal("secret in wrong transport")
	}
}
