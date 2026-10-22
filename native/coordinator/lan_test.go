package coordinator

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

const testLANPassword = "test-workspace-password"

func lanConfig(t *testing.T, id string) LANConfig {
	t.Helper()
	identity, err := GenerateLANIdentity("test-workspace", id)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewPasswordVerifier(testLANPassword)
	if err != nil {
		t.Fatal(err)
	}
	return LANConfig{Version: 1, WorkspaceID: "test-workspace", Identity: identity, PasswordVerifier: verifier, ListenHost: "127.0.0.1", PeerHints: []PeerHint{}}
}

func openLAN(t *testing.T, id, directory string, config LANConfig, bootstrap bool) *Node {
	t.Helper()
	node, err := OpenNode(Options{ID: id, DataDir: directory, LAN: &config, BootstrapIfNew: bootstrap, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Close() })
	return node
}

func waitActive(t *testing.T, node *Node) {
	t.Helper()
	eventually(t, "LAN member did not complete enrollment: "+node.id, func() bool { return node.lan.active(node.id) })
	eventually(t, "fixture repository binding not committed", func() bool {
		return nodeCommand(t, node, CommandRequest{RequestID: "bind-fixture-" + node.id, Command: Command{Type: "bind_repository", Repository: &Repository{Owner: "example", Repo: "project"}}}).OK
	})
}

func joinedLAN(t *testing.T, id string, inviter *Node) (*Node, LANConfig, string) {
	t.Helper()
	config := lanConfig(t, id)
	config.Join = &JoinInvitation{ControlURL: inviter.lan.public.ControlURL, DeviceID: inviter.id, TrustedCACertPEM: inviter.lan.public.CACertPEM, Password: testLANPassword, RequestID: "join-" + id}
	directory := t.TempDir()
	node := openLAN(t, id, directory, config, false)
	waitActive(t, node)
	return node, config, directory
}

func TestLANIdentityPasswordAndPossessionValidation(t *testing.T) {
	config := lanConfig(t, "one")
	pair, ca, err := validateIdentity(config.Identity, config.WorkspaceID, "one")
	if err != nil || caFingerprint(ca) == "" {
		t.Fatal("generated identity invalid", err)
	}
	if !config.PasswordVerifier.matches(testLANPassword) || config.PasswordVerifier.matches("wrong-password") {
		t.Fatal("password verifier boundary failed")
	}
	wrong := config.Identity
	wrong.KeyPEM = config.Identity.CAKeyPEM
	if _, _, err := validateIdentity(wrong, config.WorkspaceID, "one"); err == nil {
		t.Fatal("mismatched private key accepted")
	}
	if _, _, err := validateIdentity(config.Identity, "other-workspace", "one"); err == nil {
		t.Fatal("cross-workspace identity accepted")
	}
	request := joinRequest{WorkspaceID: config.WorkspaceID, RequestID: "join-one", DeviceID: "one", CACertPEM: config.Identity.CACertPEM, CertPEM: config.Identity.CertPEM, ControlURL: "https://127.0.0.1:1234", RaftEndpoint: "127.0.0.1:1235", Password: testLANPassword}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{SerialNumber: request.RequestID}, DNSNames: []string{logicalName(config.WorkspaceID, "one")}}, pair.PrivateKey.(crypto.Signer))
	if err != nil {
		t.Fatal(err)
	}
	request.CSRPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))
	if err := validateJoin(request, config.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	request.RequestID = "different-request"
	if validateJoin(request, config.WorkspaceID) == nil {
		t.Fatal("proof replay with changed enrollment request accepted")
	}
	for _, endpoint := range []string{"https://example.com:1234", "http://127.0.0.1:1234", "https://127.0.0.1:1234/path", "https://127.0.0.1:1234?password=secret", "https://user:pass@127.0.0.1:1234", "https://0.0.0.0:1234"} {
		if validateHint(PeerHint{DeviceID: "one", ControlURL: endpoint, RaftEndpoint: "127.0.0.1:1235"}) == nil {
			t.Fatalf("unsafe peer endpoint accepted: %s", endpoint)
		}
	}
}

func TestLANFSMDeviceBoundOwnershipNonvoterAndRestore(t *testing.T) {
	fsm := NewFSM()
	fsm.requireLAN = true
	applyOp := func(op lanOperation) CommandResult {
		encoded, _ := json.Marshal(lanEnvelope{Protocol: "agent-lan-v1", Operation: &op})
		return fsm.Apply(&raft.Log{Index: fsm.data.LastIndex + 1, Data: encoded}).(CommandResult)
	}
	applyActor := func(actor string, request CommandRequest) CommandResult {
		encoded, _ := json.Marshal(lanEnvelope{Protocol: "agent-lan-command-v1", Actor: actor, Request: &request})
		return fsm.Apply(&raft.Log{Index: fsm.data.LastIndex + 1, Data: encoded}).(CommandResult)
	}
	one := lanConfig(t, "one")
	two := lanConfig(t, "two")
	member := LANMember{DeviceID: "one", CACertPEM: one.Identity.CACertPEM, Stage: "active", JoinRequestID: "bootstrap-one"}
	requireOK(t, applyOp(lanOperation{Type: "initialize", WorkspaceID: one.WorkspaceID, Member: &member}))
	member = LANMember{DeviceID: "two", CACertPEM: two.Identity.CACertPEM, Stage: "pending", JoinRequestID: "join-two"}
	requireOK(t, applyOp(lanOperation{Type: "enroll", WorkspaceID: one.WorkspaceID, Member: &member}))
	request := taskRequest(proposal("owned", "run"))
	requireCode(t, applyActor("two", request), "DEVICE_NOT_AUTHORIZED")
	requireCode(t, applyRequest(t, fsm, request), "DEVICE_NOT_AUTHORIZED")
	requireCode(t, applyActor("one", request), "REPOSITORY_REQUIRED")
	requireOK(t, applyActor("one", CommandRequest{RequestID: "bind-repository", Command: Command{Type: "bind_repository", Repository: &Repository{Owner: "example", Repo: "project"}}}))
	requireOK(t, applyActor("one", request))
	requireOK(t, applyOp(lanOperation{Type: "nonvoter", WorkspaceID: one.WorkspaceID, DeviceID: "two"}))
	requireCode(t, applyActor("two", taskRequest(proposal("pending", "stop"))), "DEVICE_NOT_AUTHORIZED")
	requireOK(t, applyOp(lanOperation{Type: "activate", WorkspaceID: one.WorkspaceID, DeviceID: "two"}))
	requireCode(t, applyActor("two", request), "REQUEST_ID_REUSED")
	stop := CommandRequest{RequestID: "spoof-owner", Command: Command{Type: "acknowledge_stop", TaskID: "owned", OwnerID: "owner-owned", ExpectedRevision: revision(1)}}
	requireCode(t, applyActor("two", stop), "DEVICE_NOT_AUTHORIZED")
	before := fsm.State()
	for _, id := range []string{"three", "four", "five", "six", "seven", "eight", "nine", "ten"} {
		config := lanConfig(t, id)
		member := LANMember{DeviceID: id, CACertPEM: config.Identity.CACertPEM, Stage: "pending", JoinRequestID: "join-" + id}
		requireOK(t, applyOp(lanOperation{Type: "enroll", WorkspaceID: one.WorkspaceID, Member: &member}))
	}
	extra := lanConfig(t, "eleven")
	member = LANMember{DeviceID: "eleven", CACertPEM: extra.Identity.CACertPEM, Stage: "pending", JoinRequestID: "join-eleven"}
	requireCode(t, applyOp(lanOperation{Type: "enroll", WorkspaceID: one.WorkspaceID, Member: &member}), "MEMBER_LIMIT")
	if !reflect.DeepEqual(before, fsm.State()) {
		t.Fatal("membership changed task history")
	}
	encoded, _ := json.Marshal(fsm.data)
	if bytes.Contains(encoded, []byte("PRIVATE KEY")) || bytes.Contains(encoded, []byte(testLANPassword)) || bytes.Contains(encoded, []byte(one.PasswordVerifier.Key)) {
		t.Fatal("replicated state contains LAN credentials")
	}
	restored := NewFSM()
	if err := restored.Restore(io.NopCloser(bytes.NewReader(encoded))); err != nil {
		t.Fatal(err)
	}
	state, _ := restored.LANState()
	if state.TaskDevices["owned"] != "one" || len(state.Members) != 10 {
		t.Fatal("LAN state or task ownership lost on restore")
	}
	state.Members["one"] = LANMember{}
	state2, _ := restored.LANState()
	if state2.Members["one"].DeviceID != "one" {
		t.Fatal("mutable roster leaked")
	}
}

func TestRealTLSLANJoinForwardOwnershipFailoverAndChangedEndpoints(t *testing.T) {
	firstConfig := lanConfig(t, "one")
	firstDir := t.TempDir()
	first := openLAN(t, "one", firstDir, firstConfig, true)
	waitActive(t, first)
	second, _, _ := joinedLAN(t, "two", first)
	third, _, _ := joinedLAN(t, "three", second) // First contact is a follower.
	for _, node := range []*Node{first, second, third} {
		eventually(t, "roster not replicated", func() bool {
			state, _ := node.FSM.LANState()
			return len(state.Members) == 3 && state.Members["three"].Stage == "active"
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	snapshot := second.Snapshot(ctx)
	if !snapshot.HasAuthority || snapshot.AuthoritySource != "forwarded" {
		t.Fatalf("follower did not forward authoritative query: %+v", snapshot)
	}
	requireOK(t, nodeCommand(t, second, taskRequest(proposal("second-owned", "run"))))
	stop := CommandRequest{RequestID: "spoofed-stop", Command: Command{Type: "acknowledge_stop", TaskID: "second-owned", OwnerID: "owner-second-owned", ExpectedRevision: revision(1)}}
	requireCode(t, nodeCommand(t, third, stop), "DEVICE_NOT_AUTHORIZED")
	var wg sync.WaitGroup
	results := make(chan CommandResult, 2)
	for _, pair := range []struct {
		node *Node
		id   string
	}{{second, "left"}, {third, "right"}} {
		wg.Add(1)
		go func(node *Node, id string) {
			defer wg.Done()
			results <- nodeCommand(t, node, taskRequest(proposal(id, "overlap")))
		}(pair.node, pair.id)
	}
	wg.Wait()
	close(results)
	for result := range results {
		requireOK(t, result)
	}
	eventually(t, "simultaneous conflict did not block both", func() bool {
		state := third.FSM.State()
		return state.Tasks["left"] != nil && state.Tasks["right"] != nil && state.Tasks["left"].Status == "blocked" && state.Tasks["right"].Status == "blocked"
	})
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	leader := waitLeader(t, second, third)
	requireOK(t, nodeCommand(t, leader, taskRequest(proposal("after-failover", "different"))))
	if len(leader.Snapshot(ctx).Members) != 3 {
		t.Fatal("leader loss shrank voting membership")
	}
	// Restart the original member on new physical ports; committed addresses
	// remain device IDs and discovery updates only untrusted endpoint hints.
	for _, peer := range []*Node{second, third} {
		firstConfig.PeerHints = append(firstConfig.PeerHints, PeerHint{DeviceID: peer.id, ControlURL: peer.lan.public.ControlURL, RaftEndpoint: peer.lan.public.RaftEndpoint})
	}
	restarted := openLAN(t, "one", firstDir, firstConfig, true)
	for _, peer := range []*Node{second, third} {
		if err := peer.lan.updateHints([]PeerHint{{DeviceID: "one", ControlURL: restarted.lan.public.ControlURL, RaftEndpoint: restarted.lan.public.RaftEndpoint}}); err != nil {
			t.Fatal(err)
		}
	}
	eventually(t, "rejoined replica did not catch up", func() bool { return restarted.FSM.State().Tasks["after-failover"] != nil })
	for _, member := range restarted.Snapshot(context.Background()).Members {
		if member.Address != member.ID {
			t.Fatal("physical IP persisted in voting configuration")
		}
	}
	if restarted.FSM.State().Tasks["second-owned"] == nil {
		t.Fatal("offline reservations lost across host failover")
	}
}

func TestLANPinRequiredBeforePasswordAndTwoPeerQuorumRetained(t *testing.T) {
	first := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, first)
	second, config, directory := joinedLAN(t, "two", first)
	// A different root under the same logical device name must fail in TLS,
	// before the HTTP handler can inspect a password-bearing body.
	impostor := lanConfig(t, "one")
	pinned := LANMember{DeviceID: "one", CACertPEM: impostor.Identity.CACertPEM, Stage: "active"}
	var output joinGrant
	if err := second.lan.peerCall(context.Background(), "one", http.MethodPost, "/lan/v1/join", map[string]string{"password": "must-not-arrive"}, &output, &pinned, first.lan.public.ControlURL); err == nil {
		t.Fatal("untrusted first-contact CA accepted")
	}
	clientTLS, err := second.lan.clientTLS("one", nil, "http/1.1", false)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: clientTLS}, Timeout: time.Second}
	response, err := client.Get(first.lan.public.ControlURL + "/lan/v1/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("unauthenticated peer query accepted", response.StatusCode)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "two-peer survivor kept authority", func() bool { return !authority(first) })
	requireCode(t, nodeCommand(t, first, taskRequest(proposal("no-quorum", "work"))), "NO_AUTHORITY")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snapshot := first.Snapshot(ctx)
	if snapshot.HasAuthority || len(snapshot.Members) != 2 {
		t.Fatal("two-peer survivor invented a single-node quorum")
	}
	config.Join = nil
	config.PeerHints = []PeerHint{{DeviceID: first.id, ControlURL: first.lan.public.ControlURL, RaftEndpoint: first.lan.public.RaftEndpoint}}
	restarted := openLAN(t, "two", directory, config, false)
	_ = first.lan.updateHints([]PeerHint{{DeviceID: restarted.id, ControlURL: restarted.lan.public.ControlURL, RaftEndpoint: restarted.lan.public.RaftEndpoint}})
	leader := waitLeader(t, first, restarted)
	requireOK(t, nodeCommand(t, leader, taskRequest(proposal("restored-quorum", "work"))))
	if _, err := OpenNode(Options{ID: "two", DataDir: directory, TestTimers: true}); err == nil || !strings.Contains(err.Error(), "durable store") {
		t.Fatal("open active same-data directory should fail lock")
	}
}
