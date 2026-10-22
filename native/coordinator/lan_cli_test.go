package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLANCLIPrivateStartupIdentityAndSupervisedShutdown(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "coordinator")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-trimpath", "-o", binary, "./cmd/coordinator")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("could not build LAN CLI fixture: %s", output)
	}
	generated, err := exec.Command(binary, "--generate-lan-identity", "--workspace-id", "test-workspace", "--id", "cli-device").Output()
	if err != nil {
		t.Fatal("identity generation CLI failed")
	}
	var identity LANIdentity
	if decodeStrict(generated, &identity) != nil {
		t.Fatal("invalid identity generator output")
	}
	if _, _, err := validateIdentity(identity, "test-workspace", "cli-device"); err != nil {
		t.Fatal(err)
	}
	config := lanConfig(t, "cli-device")
	config.Identity = identity
	child := exec.Command(binary, "--id", "cli-device", "--data-dir", filepath.Join(directory, "workspace"), "--bootstrap-if-new", "--lan-config-stdin", "--exit-on-stdin-close")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = child.Process.Kill() })
	if err := json.NewEncoder(input).Encode(config); err != nil {
		t.Fatal(err)
	}
	ready := readReady(t, output)
	if ready.LAN == nil || ready.LAN.DeviceID != "cli-device" || ready.LAN.Fingerprint == "" || ready.LAN.ControlURL == "" {
		t.Fatal("missing public LAN readiness")
	}
	readyJSON, _ := json.Marshal(ready)
	for _, secret := range []string{"PRIVATE KEY", testLANPassword, config.PasswordVerifier.Key, config.PasswordVerifier.Salt} {
		if bytes.Contains(readyJSON, []byte(secret)) {
			t.Fatal("readiness leaked LAN credentials")
		}
	}
	eventually(t, "LAN CLI did not initialize committed active membership", func() bool {
		snapshot, err := cliSnapshot(ready)
		return err == nil && snapshot.HasAuthority && snapshot.AuthoritySource == "local"
	})
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("supervised LAN helper did not exit gracefully")
		}
	case <-time.After(6 * time.Second):
		t.Fatal("LAN helper ignored parent EOF")
	}
	remaining, _ := io.ReadAll(output)
	if len(bytes.TrimSpace(remaining)) != 0 {
		t.Fatal("unexpected extra stdout after readiness")
	}
	for _, secret := range []string{"PRIVATE KEY", testLANPassword, config.PasswordVerifier.Key} {
		if strings.Contains(stderr.String(), secret) {
			t.Fatal("stderr leaked a LAN credential")
		}
	}
}

func TestLANFailedJoinClearsPasswordAndCannotBootstrapOnReopen(t *testing.T) {
	first := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, first)
	config := lanConfig(t, "two")
	untrusted := lanConfig(t, "one")
	config.Join = &JoinInvitation{ControlURL: first.lan.public.ControlURL, DeviceID: "one", TrustedCACertPEM: untrusted.Identity.CACertPEM, Password: testLANPassword, RequestID: "stable-enrollment-request"}
	directory := t.TempDir()
	joining := openLAN(t, "two", directory, config, false)
	eventually(t, "failed join did not report pending/error", func() bool { status := joining.lan.status(context.Background()); return status.JoinError != nil })
	// status/roster reads synchronize the worker's completed first attempt;
	// close joins it before directly inspecting secret lifetime below.
	if err := joining.Close(); err != nil {
		t.Fatal(err)
	}
	if joining.lan.config.Join != nil {
		t.Fatal("password-bearing join retained after one failed attempt")
	}
	config.Join = nil
	if _, err := OpenNode(Options{ID: "two", DataDir: directory, LAN: &config, BootstrapIfNew: true, TestTimers: true}); err == nil {
		t.Fatal("saved joining directory bootstrapped after failure")
	}
	pending := openLAN(t, "two", directory, config, false)
	if pending.Snapshot(context.Background()).HasAuthority {
		t.Fatal("reopened pending workspace invented approval authority")
	}
	if err := pending.Close(); err != nil {
		t.Fatal(err)
	}
	config.Join = &JoinInvitation{ControlURL: first.lan.public.ControlURL, DeviceID: "one", TrustedCACertPEM: first.lan.public.CACertPEM, Password: testLANPassword, RequestID: "stable-enrollment-request"}
	retried := openLAN(t, "two", directory, config, false)
	waitActive(t, retried)
	state, _ := retried.FSM.LANState()
	if state.Members["two"].JoinRequestID != "stable-enrollment-request" {
		t.Fatal("explicit retry changed enrollment identity")
	}
	eventually(t, "verified enrollment status missing", func() bool { return retried.lan.status(context.Background()).JoinAttempt == "verified" })
	if err := retried.Close(); err != nil {
		t.Fatal(err)
	}
	// Retrying against restored active state must still check the newly entered
	// password. A failed retry must not rotate the prior shared verifier.
	config.Join = &JoinInvitation{ControlURL: first.lan.public.ControlURL, DeviceID: "one", TrustedCACertPEM: first.lan.public.CACertPEM, Password: "incorrect-new-password", RequestID: "stable-enrollment-request"}
	wrongRetry := openLAN(t, "two", directory, config, false)
	_ = first.lan.updateHints([]PeerHint{{DeviceID: "two", ControlURL: wrongRetry.lan.public.ControlURL, RaftEndpoint: wrongRetry.lan.public.RaftEndpoint}})
	eventually(t, "active retry did not report failure", func() bool { return wrongRetry.lan.status(context.Background()).JoinAttempt == "failed" })
	wrongRetry.lan.mu.RLock()
	verifier := wrongRetry.lan.verifier
	wrongRetry.lan.mu.RUnlock()
	if !verifier.matches(testLANPassword) || verifier.matches("incorrect-new-password") {
		t.Fatal("failed retry changed the password verifier")
	}
	secure, err := first.lan.clientTLS("two", nil, "http/1.1", true)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: secure}, Timeout: time.Second}
	response, err := client.Post(wrongRetry.lan.public.ControlURL+"/lan/v1/join", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var rejected CommandResult
	if json.NewDecoder(response.Body).Decode(&rejected) != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatal("unverified retry served enrollment")
	}
	requireCode(t, rejected, "ENROLLMENT_NOT_VERIFIED")
}
