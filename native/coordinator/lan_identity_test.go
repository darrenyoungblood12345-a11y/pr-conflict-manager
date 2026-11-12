package coordinator

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLANLeafRenewalReissuesAnExpiredLeafUnderTheSameAuthorityAndKey(t *testing.T) {
	now := time.Now()
	stored, err := generateLANIdentity("test-workspace", "one", now.AddDate(-2, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := validateIdentity(stored, "test-workspace", "one"); err == nil {
		t.Fatal("an expired leaf passed startup validation")
	}
	renewed, err := renewLANIdentity(stored, "test-workspace", "one", now)
	if err != nil {
		t.Fatal(err)
	}
	if renewed.CACertPEM != stored.CACertPEM || renewed.CAKeyPEM != stored.CAKeyPEM || renewed.KeyPEM != stored.KeyPEM {
		t.Fatal("renewal changed the device authority or the leaf key")
	}
	if renewed.CertPEM == stored.CertPEM {
		t.Fatal("expired leaf was not reissued")
	}
	pair, ca, err := validateIdentity(renewed, "test-workspace", "one")
	if err != nil {
		t.Fatal("renewed identity failed unchanged startup validation: ", err)
	}
	previous, err := parseCA(stored.CACertPEM, "test-workspace", "one")
	if err != nil || caFingerprint(ca) != caFingerprint(previous) {
		t.Fatal("renewal changed the pinned authority fingerprint")
	}
	if remaining := pair.Leaf.NotAfter.Sub(now); remaining < 364*24*time.Hour || remaining > 367*24*time.Hour {
		t.Fatalf("renewed leaf lifetime is %s", remaining)
	}
	again, err := renewLANIdentity(renewed, "test-workspace", "one", now)
	if err != nil || again != renewed {
		t.Fatal("a freshly renewed identity was reissued again")
	}
}

func TestLANLeafRenewalOnlyNearOrAfterExpiry(t *testing.T) {
	now := time.Now()
	for _, test := range []struct {
		ageDays int
		renewed bool
	}{{0, false}, {300, false}, {334, false}, {340, true}, {364, true}, {366, true}, {900, true}} {
		stored, err := generateLANIdentity("test-workspace", "one", now.AddDate(0, 0, -test.ageDays))
		if err != nil {
			t.Fatal(err)
		}
		result, err := renewLANIdentity(stored, "test-workspace", "one", now)
		if err != nil {
			t.Fatalf("%d-day-old identity: %v", test.ageDays, err)
		}
		if (result != stored) != test.renewed {
			t.Fatalf("%d-day-old identity: renewed=%t", test.ageDays, result != stored)
		}
		if result.CACertPEM != stored.CACertPEM || result.CAKeyPEM != stored.CAKeyPEM || result.KeyPEM != stored.KeyPEM {
			t.Fatalf("%d-day-old identity: authority or key changed", test.ageDays)
		}
	}
}

func TestLANLeafRenewalRefusesIdentitiesItCannotVouchFor(t *testing.T) {
	now := time.Now()
	issued := now.AddDate(-2, 0, 0)
	stored, err := generateLANIdentity("test-workspace", "one", issued)
	if err != nil {
		t.Fatal(err)
	}
	other, err := generateLANIdentity("test-workspace", "one", issued)
	if err != nil {
		t.Fatal(err)
	}
	foreignAuthorityKey, foreignLeaf, foreignLeafKey, foreignAuthority := stored, stored, stored, stored
	foreignAuthorityKey.CAKeyPEM = other.CAKeyPEM
	foreignLeaf.CertPEM, foreignLeaf.KeyPEM = other.CertPEM, other.KeyPEM
	foreignLeafKey.KeyPEM = other.KeyPEM
	foreignAuthority.CACertPEM, foreignAuthority.CAKeyPEM = other.CACertPEM, other.CAKeyPEM
	for name, identity := range map[string]LANIdentity{
		"authority key of another device":  foreignAuthorityKey,
		"leaf issued by another authority": foreignLeaf,
		"leaf key of another device":       foreignLeafKey,
		"authority of another device":      foreignAuthority,
	} {
		if _, err := renewLANIdentity(identity, "test-workspace", "one", now); err == nil {
			t.Fatalf("renewed an identity with the %s", name)
		}
	}
	if _, err := renewLANIdentity(stored, "other-workspace", "one", now); err == nil {
		t.Fatal("renewed a cross-workspace identity")
	}
	if _, err := renewLANIdentity(stored, "test-workspace", "two", now); err == nil {
		t.Fatal("renewed another device's identity")
	}
	ancient, err := generateLANIdentity("test-workspace", "one", now.AddDate(-11, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := renewLANIdentity(ancient, "test-workspace", "one", now); err == nil {
		t.Fatal("issued a leaf from an expired device authority")
	}
}

func TestLANSavedWorkspaceReopensWithARenewedLeafThatItsPeerStillTrusts(t *testing.T) {
	first := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, first)
	second, config, directory := joinedLAN(t, "two", first)
	fingerprint := second.lan.public.Fingerprint
	requireOK(t, nodeCommand(t, second, taskRequest(proposal("before-expiry", "run"))))
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	// The saved profile as it is found after its leaf's year has passed: the same
	// authority and keys, with a leaf that expired a year ago.
	stored, err := reissueLANLeaf(config.Identity, config.WorkspaceID, "two", time.Now().AddDate(-2, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	config.Join = nil
	config.Identity = stored
	config.PeerHints = []PeerHint{{DeviceID: "one", ControlURL: first.lan.public.ControlURL, RaftEndpoint: first.lan.public.RaftEndpoint}}
	if _, err := OpenNode(Options{ID: "two", DataDir: directory, LAN: &config, TestTimers: true}); err == nil {
		t.Fatal("a saved workspace opened with an expired leaf")
	}
	renewed, err := RenewLANIdentity(stored, config.WorkspaceID, "two")
	if err != nil {
		t.Fatal(err)
	}
	if renewed.CertPEM == stored.CertPEM || renewed.CACertPEM != stored.CACertPEM || renewed.CAKeyPEM != stored.CAKeyPEM || renewed.KeyPEM != stored.KeyPEM {
		t.Fatal("renewal did not reissue only the leaf")
	}
	config.Identity = renewed
	reopened := openLAN(t, "two", directory, config, false)
	if reopened.lan.public.Fingerprint != fingerprint {
		t.Fatal("reopened workspace presents a different device authority")
	}
	if err := first.lan.updateHints([]PeerHint{{DeviceID: "two", ControlURL: reopened.lan.public.ControlURL, RaftEndpoint: reopened.lan.public.RaftEndpoint}}); err != nil {
		t.Fatal(err)
	}
	// Two voters need each other: a commit proves mutual TLS with the renewed leaf.
	eventually(t, "peer did not accept the renewed leaf", func() bool {
		return nodeCommand(t, reopened, taskRequest(proposal("after-renewal", "different"))).OK
	})
	eventually(t, "renewed member's command did not replicate", func() bool { return first.FSM.State().Tasks["after-renewal"] != nil })
	if first.FSM.State().Tasks["before-expiry"] == nil || reopened.FSM.State().Tasks["before-expiry"] == nil {
		t.Fatal("reservations were lost across the leaf renewal")
	}
}

func TestLANCLIRenewsAnExpiredIdentityFromItsPrivatePipe(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "coordinator")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-trimpath", "-o", binary, "./cmd/coordinator")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("could not build LAN CLI fixture: %s", output)
	}
	stored, err := generateLANIdentity("test-workspace", "cli-device", time.Now().AddDate(-2, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	renew := func(identity LANIdentity, arguments ...string) (LANIdentity, string, error) {
		input, _ := json.Marshal(identity)
		command := exec.Command(binary, append([]string{"--renew-lan-identity"}, arguments...)...)
		command.Stdin = bytes.NewReader(append(input, '\n'))
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			return LANIdentity{}, string(output) + stderr.String(), err
		}
		var result LANIdentity
		if decodeStrict(output, &result) != nil {
			t.Fatal("invalid identity renewal output")
		}
		return result, stderr.String(), nil
	}
	renewed, _, err := renew(stored, "--workspace-id", "test-workspace", "--id", "cli-device")
	if err != nil {
		t.Fatal("identity renewal CLI failed")
	}
	if renewed.CertPEM == stored.CertPEM || renewed.CACertPEM != stored.CACertPEM || renewed.CAKeyPEM != stored.CAKeyPEM || renewed.KeyPEM != stored.KeyPEM {
		t.Fatal("renewal CLI did not reissue only the leaf")
	}
	if _, _, err := validateIdentity(renewed, "test-workspace", "cli-device"); err != nil {
		t.Fatal(err)
	}
	unchanged, _, err := renew(renewed, "--workspace-id", "test-workspace", "--id", "cli-device")
	if err != nil || unchanged != renewed {
		t.Fatal("renewal CLI reissued a current leaf")
	}
	if _, output, err := renew(stored, "--workspace-id", "other-workspace", "--id", "cli-device"); err == nil || bytes.Contains([]byte(output), []byte("PRIVATE KEY")) {
		t.Fatal("renewal CLI accepted a cross-workspace identity or echoed its keys")
	}
	if _, _, err := renew(stored, "--workspace-id", "test-workspace", "--id", "cli-device", "--lan-config-stdin"); err == nil {
		t.Fatal("renewal was combined with LAN startup")
	}
}
