package coordinator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestLANReceiptRequiresFreshOwnedActiveRevisionAndVerifiesCryptographically(t *testing.T) {
	first := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, first)
	second, _, _ := joinedLAN(t, "two", first)
	requireOK(t, nodeCommand(t, second, taskRequest(proposal("receipt-task", "run"))))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	receipt, result := second.IssueTaskReceipt(ctx, "receipt-task", 1)
	requireOK(t, result)
	payload, err := base64.RawURLEncoding.DecodeString(receipt.Payload)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(receipt.Signature)
	if err != nil {
		t.Fatal(err)
	}
	var decoded taskReceiptPayload
	if decodeStrict(payload, &decoded) != nil || decoded.Version != 1 || decoded.WorkspaceID != "test-workspace" || decoded.IssuerDeviceID != "two" || decoded.Task.ID != "receipt-task" || decoded.Task.Revision != 1 || decoded.CommitIndex == 0 {
		t.Fatal("incorrect receipt payload")
	}
	block, _ := pem.Decode([]byte(receipt.CertPEM))
	if block == nil {
		t.Fatal("missing signing certificate")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := parseCA(second.lan.public.CACertPEM, "test-workspace", "two")
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: logicalName("test-workspace", "two"), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(leaf.PublicKey.(ed25519.PublicKey), payload, signature) {
		t.Fatal("receipt signature failed standard verification")
	}
	altered := append([]byte{}, payload...)
	altered[0] ^= 1
	if ed25519.Verify(leaf.PublicKey.(ed25519.PublicKey), altered, signature) {
		t.Fatal("modified receipt signature verified")
	}
	if bytes.Contains(payload, []byte("PRIVATE KEY")) || bytes.Contains(payload, []byte(testLANPassword)) {
		t.Fatal("receipt leaked a credential")
	}
	_, result = first.IssueTaskReceipt(ctx, "receipt-task", 1)
	requireCode(t, result, "DEVICE_NOT_AUTHORIZED")
	_, result = second.IssueTaskReceipt(ctx, "receipt-task", 2)
	requireCode(t, result, "REVISION_MISMATCH")
	api, err := StartAPI(second, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.Close(context.Background()) })
	for _, query := range []string{"taskId=receipt-task&revision=1", "taskId=receipt-task&revision=01", "taskId=receipt-task&revision=1&revision=1", "taskId=receipt-task&revision=0"} {
		request, _ := http.NewRequest(http.MethodGet, api.Ready.URL+"/v1/task-receipt?"+query, nil)
		request.Header.Set("Authorization", "Bearer "+api.Ready.Token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if query == "taskId=receipt-task&revision=1" && response.StatusCode != http.StatusOK {
			t.Fatal("valid receipt HTTP request rejected")
		}
		if query != "taskId=receipt-task&revision=1" && response.StatusCode == http.StatusOK {
			t.Fatal("ambiguous receipt query accepted")
		}
	}
	requireOK(t, nodeCommand(t, first, taskRequest(proposal("conflict-receipt", "run"))))
	_, result = second.IssueTaskReceipt(context.Background(), "receipt-task", 2)
	requireCode(t, result, "TASK_NOT_ACTIVE")
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	_, result = second.IssueTaskReceipt(context.Background(), "receipt-task", 1)
	requireCode(t, result, "NO_AUTHORITY")
	// Earlier receipts stay cryptographically intact; their offline use and
	// reconnect invalidation are the agent gate's responsibility, not renewal.
	if !ed25519.Verify(leaf.PublicKey.(ed25519.PublicKey), payload, signature) {
		t.Fatal("prior receipt mutated")
	}
}

func TestLocalHarnessCannotIssueLANExecutionReceipts(t *testing.T) {
	node := startNode(t, "local", t.TempDir(), true)
	waitLeader(t, node)
	_, result := node.IssueTaskReceipt(context.Background(), "task", 1)
	requireCode(t, result, "LAN_REQUIRED")
}

func TestLANReceiptRejectsStopAcknowledgedLegacyActiveState(t *testing.T) {
	node := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, node)
	requireOK(t, nodeCommand(t, node, taskRequest(proposal("stopped-state", "run"))))
	// Inject a legacy/corrupt combination that normal commands cannot produce.
	// Receipt issuance must independently reject the explicit stop flag.
	node.FSM.mu.Lock()
	node.FSM.data.State.Tasks["stopped-state"].StopAcknowledged = true
	node.FSM.mu.Unlock()
	_, result := node.IssueTaskReceipt(context.Background(), "stopped-state", 1)
	requireCode(t, result, "TASK_NOT_ACTIVE")
}
