package coordinator

import (
	"context"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

func TestLANInterruptedNonvoterEnrollmentReopensWithoutForgingVoter(t *testing.T) {
	config := lanConfig(t, "one")
	directory := t.TempDir()
	first, err := OpenNode(Options{ID: "one", DataDir: directory, LAN: &config, BootstrapIfNew: true, TestTimers: true, TestPauseLANAt: "before-promotion"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	waitActive(t, first)
	secondConfig := lanConfig(t, "two")
	secondConfig.Join = &JoinInvitation{ControlURL: first.lan.public.ControlURL, DeviceID: "one", TrustedCACertPEM: first.lan.public.CACertPEM, Password: testLANPassword, RequestID: "join-two"}
	second := openLAN(t, "two", t.TempDir(), secondConfig, false)
	eventually(t, "nonvoter did not replicate committed roster", func() bool {
		state, _ := second.FSM.LANState()
		return state != nil && state.Members["two"].Stage == "nonvoter"
	})
	requireCode(t, nodeCommand(t, second, taskRequest(proposal("must-wait", "run"))), "DEVICE_NOT_AUTHORIZED")
	configuration := first.Raft.GetConfiguration()
	if err := configuration.Error(); err != nil {
		t.Fatal(err)
	}
	for _, member := range configuration.Configuration().Servers {
		if string(member.ID) == "two" && member.Suffrage != raft.Nonvoter {
			t.Fatal("joining Mac voted before promotion")
		}
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if authority(second) {
		t.Fatal("nonvoter elected itself after only voter disappeared")
	}
	config.PeerHints = []PeerHint{{DeviceID: "two", ControlURL: second.lan.public.ControlURL, RaftEndpoint: second.lan.public.RaftEndpoint}}
	restarted := openLAN(t, "one", directory, config, false)
	_ = second.lan.updateHints([]PeerHint{{DeviceID: "one", ControlURL: restarted.lan.public.ControlURL, RaftEndpoint: restarted.lan.public.RaftEndpoint}})
	waitActive(t, second)
	requireOK(t, nodeCommand(t, second, taskRequest(proposal("after-enrollment", "run"))))
}

func TestLANLeaderLossAfterCommittedPromotionResumesActivation(t *testing.T) {
	config := lanConfig(t, "one")
	first, err := OpenNode(Options{ID: "one", DataDir: t.TempDir(), LAN: &config, BootstrapIfNew: true, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	waitActive(t, first)
	second, _, _ := joinedLAN(t, "two", first)
	third, _, _ := joinedLAN(t, "three", first)
	// Set fault injection only while holding the membership lock, so the
	// worker cannot race the test between checking and committing promotion.
	first.lan.membership.Lock()
	first.lan.pauseAt.Store("after-promotion")
	first.lan.membership.Unlock()
	fourthConfig := lanConfig(t, "four")
	fourthConfig.Join = &JoinInvitation{ControlURL: first.lan.public.ControlURL, DeviceID: "one", TrustedCACertPEM: first.lan.public.CACertPEM, Password: testLANPassword, RequestID: "join-four"}
	fourth := openLAN(t, "four", t.TempDir(), fourthConfig, false)
	eventually(t, "voter promotion was not committed before activation", func() bool {
		state, _ := fourth.FSM.LANState()
		if state == nil || state.Members["four"].Stage != "nonvoter" {
			return false
		}
		future := first.Raft.GetConfiguration()
		if future.Error() != nil {
			return false
		}
		for _, member := range future.Configuration().Servers {
			if string(member.ID) == "four" && member.Suffrage == raft.Voter {
				return true
			}
		}
		return false
	})
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	leader := waitLeader(t, second, third, fourth)
	waitActive(t, fourth)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if len(leader.Snapshot(ctx).Members) != 4 {
		t.Fatal("interrupted promotion rewrote the voter roster")
	}
	requireOK(t, nodeCommand(t, fourth, taskRequest(proposal("promoted-after-loss", "run"))))
}

func TestLANMissingCreatorStateCannotBeReopenedAsNewWorkspace(t *testing.T) {
	config := lanConfig(t, "one")
	if node, err := OpenNode(Options{ID: "one", DataDir: t.TempDir(), LAN: &config, TestTimers: true}); err == nil {
		_ = node.Close()
		t.Fatal("empty LAN creator reopen silently accepted")
	}
}

func TestLANInterruptedCreatorIdentityInitializationResumesWithoutBootstrap(t *testing.T) {
	config := lanConfig(t, "one")
	directory := t.TempDir()
	first, err := OpenNode(Options{ID: "one", DataDir: directory, LAN: &config, BootstrapIfNew: true, TestTimers: true, TestPauseLANAt: "before-initialize"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	waitLeader(t, first)
	if state, _ := first.FSM.LANState(); state != nil {
		t.Fatal("fault fixture already initialized identity")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openLAN(t, "one", directory, config, false)
	waitActive(t, reopened)
	if state, _ := reopened.FSM.LANState(); state.Members["one"].Stage != "active" {
		t.Fatal("saved creator could not finish committed workspace initialization")
	}
}
