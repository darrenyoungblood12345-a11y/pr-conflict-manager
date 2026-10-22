package coordinator

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

type scalePeer struct {
	id        string
	directory string
	config    LANConfig
	node      *Node
}

func scaleWait(t *testing.T, message string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal(message)
}

func scaleSnapshot(node *Node) Snapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return node.Snapshot(ctx)
}

func scaleCommand(node *Node, request CommandRequest) CommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return node.Command(ctx, request)
}

func scaleHints(peers []*scalePeer) []PeerHint {
	hints := []PeerHint{}
	for _, peer := range peers {
		if peer.node != nil {
			hints = append(hints, PeerHint{DeviceID: peer.id, ControlURL: peer.node.lan.public.ControlURL, RaftEndpoint: peer.node.lan.public.RaftEndpoint})
		}
	}
	return hints
}

func scaleRefreshHints(t *testing.T, peers []*scalePeer) {
	t.Helper()
	hints := scaleHints(peers)
	for _, peer := range peers {
		if peer.node != nil && peer.node.lan.updateHints(hints) != nil {
			t.Fatal("scale fixture could not persist current endpoint hints")
		}
	}
}

func scaleOpen(t *testing.T, peer *scalePeer, bootstrap bool) {
	t.Helper()
	// Production timers avoid a stress-only election storm obscuring protocol
	// behavior under the race detector. Every node uses real durable stores,
	// socket TLS transport, membership enrollment, and leader verification.
	node, err := OpenNode(Options{ID: peer.id, DataDir: peer.directory, LAN: &peer.config, Bootstrap: bootstrap})
	if err != nil {
		t.Fatal("scale fixture could not open a persisted TLS peer")
	}
	peer.node = node
	peer.config.Join = nil
}

func scaleStop(t *testing.T, peer *scalePeer) {
	t.Helper()
	if peer.node != nil {
		if peer.node.Close() != nil {
			t.Fatal("scale fixture could not close its selected peer")
		}
		peer.node = nil
	}
}

func scaleVoterRoster(node *Node) bool {
	configuration := node.Raft.GetConfiguration()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if waitFuture(ctx, configuration) != nil || len(configuration.Configuration().Servers) != 10 {
		return false
	}
	for _, member := range configuration.Configuration().Servers {
		if member.Suffrage != raft.Voter || member.Address != raft.ServerAddress(member.ID) {
			return false
		}
	}
	return true
}

func scaleFindLeader(t *testing.T, peers []*scalePeer) *scalePeer {
	t.Helper()
	var leader *scalePeer
	scaleWait(t, "ten-voter pool did not establish majority-backed leadership", func() bool {
		for _, peer := range peers {
			if peer.node == nil || peer.node.Raft.State() != raft.Leader {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			verified := peer.node.HasAuthority(ctx)
			cancel()
			if verified {
				leader = peer
				return true
			}
		}
		return false
	})
	return leader
}

func TestLANTenVotersForwardFailoverBlockWithoutQuorumAndRecoverPersistedState(t *testing.T) {
	directory := t.TempDir()
	peers := make([]*scalePeer, 10)
	for index := range peers {
		id := fmt.Sprintf("scale-%02d", index)
		peers[index] = &scalePeer{id: id, directory: filepath.Join(directory, id), config: lanConfig(t, id)}
	}
	t.Cleanup(func() {
		for _, peer := range peers {
			if peer.node != nil {
				_ = peer.node.Close()
			}
		}
	})

	scaleOpen(t, peers[0], true)
	scaleWait(t, "scale creator did not initialize its committed identity", func() bool { return peers[0].node.lan.active(peers[0].id) })
	bound := scaleCommand(peers[0].node, repositoryRequest("scale-bind", "example", "project"))
	if !bound.OK {
		t.Fatal("scale fixture repository binding was not committed")
	}
	for index := 1; index < len(peers); index++ {
		inviter := peers[index-1]
		peer := peers[index]
		peer.config.PeerHints = scaleHints(peers)
		peer.config.Join = &JoinInvitation{ControlURL: inviter.node.lan.public.ControlURL, DeviceID: inviter.id, TrustedCACertPEM: inviter.config.Identity.CACertPEM, Password: testLANPassword, RequestID: "scale-join-" + peer.id}
		scaleOpen(t, peer, false)
		scaleWait(t, "scale enrollment did not activate its next admitted peer", func() bool { return peer.node.lan.active(peer.id) })
	}
	scaleRefreshHints(t, peers)
	scaleWait(t, "ten active voters were not replicated to every admitted peer", func() bool {
		for _, peer := range peers {
			state, _ := peer.node.FSM.LANState()
			if state == nil || len(state.Members) != 10 || !scaleVoterRoster(peer.node) {
				return false
			}
			for _, member := range state.Members {
				if member.Stage != "active" {
					return false
				}
			}
		}
		return true
	})
	t.Log("ten TLS peers admitted as committed voters")

	leader := scaleFindLeader(t, peers)
	forwarded := 0
	for index, peer := range peers {
		snapshot := scaleSnapshot(peer.node)
		if !snapshot.HasAuthority || snapshot.NodeID != peer.id || len(snapshot.Members) != 10 {
			t.Fatal("a scale peer could not obtain authoritative full-roster state")
		}
		if snapshot.LeaderID != peer.id {
			if snapshot.AuthoritySource != "forwarded" {
				t.Fatal("scale follower read did not use authenticated leader forwarding")
			}
			forwarded++
		} else if snapshot.AuthoritySource != "local" {
			t.Fatal("scale leader did not report local verified authority")
		}
		task := proposal(fmt.Sprintf("scale-task-%02d", index), fmt.Sprintf("Scale.function%02d", index))
		if !scaleCommand(peer.node, taskRequest(task)).OK {
			t.Fatal("owned per-peer scale registration was not committed")
		}
	}
	if forwarded == 0 {
		t.Fatal("scale fixture never exercised follower forwarding")
	}
	scaleWait(t, "per-peer task ownership did not converge across all ten voters", func() bool {
		for _, peer := range peers {
			state := peer.node.FSM.State()
			lan, _ := peer.node.FSM.LANState()
			for index, owner := range peers {
				id := fmt.Sprintf("scale-task-%02d", index)
				if state.Tasks[id] == nil || state.Tasks[id].Status != "active" || lan.TaskDevices[id] != owner.id {
					return false
				}
			}
		}
		return true
	})
	spoof := CommandRequest{RequestID: "scale-spoof", Command: Command{Type: "acknowledge_stop", TaskID: "scale-task-01", OwnerID: "owner-scale-task-01", ExpectedRevision: revision(1)}}
	denied := scaleCommand(peers[0].node, spoof)
	if denied.OK || denied.Error == nil || denied.Error.Code != "DEVICE_NOT_AUTHORIZED" {
		t.Fatal("scale peer could impersonate another admitted task device")
	}

	// A real snapshot and the durable projection coexist with the saved Raft
	// configuration; reopening later must preserve all ten original voters.
	snapshotContext, cancelSnapshot := context.WithTimeout(context.Background(), 3*time.Second)
	if waitFuture(snapshotContext, leader.node.Raft.Snapshot()) != nil {
		cancelSnapshot()
		t.Fatal("scale leader could not persist its real FSM snapshot")
	}
	cancelSnapshot()
	previousLeader := leader
	scaleStop(t, previousLeader)
	leader = scaleFindLeader(t, peers)
	if leader.id == previousLeader.id {
		t.Fatal("scale replacement was not a remaining majority member")
	}
	if !scaleCommand(leader.node, taskRequest(proposal("scale-after-loss", "Scale.afterLoss"))).OK {
		t.Fatal("remaining majority did not commit work after leader replacement")
	}
	if !scaleVoterRoster(leader.node) {
		t.Fatal("leader replacement changed the original ten-voter roster")
	}
	t.Log("remaining majority replaced the lost leader without changing membership")

	proposers := []*scalePeer{}
	for _, peer := range peers {
		if peer.node != nil && peer != leader {
			proposers = append(proposers, peer)
		}
	}
	start := make(chan struct{})
	results := make(chan CommandResult, 2)
	monitorStop := make(chan struct{})
	monitorDone := make(chan struct{})
	invalidIntermediate := make(chan struct{}, 1)
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-monitorStop:
				return
			case <-ticker.C:
				state := leader.node.FSM.State()
				left, right := state.Tasks["scale-left"], state.Tasks["scale-right"]
				// One earlier registration may legitimately be active until the
				// second commits. Once both exist, blocking must be atomic.
				if left != nil && right != nil && (left.Status != "blocked" || right.Status != "blocked") {
					invalidIntermediate <- struct{}{}
					return
				}
			}
		}
	}()
	var registrations sync.WaitGroup
	for index, id := range []string{"scale-left", "scale-right"} {
		registrations.Add(1)
		go func(peer *scalePeer, id string) {
			defer registrations.Done()
			<-start
			results <- scaleCommand(peer.node, taskRequest(proposal(id, "Scale.shared")))
		}(proposers[index], id)
	}
	close(start)
	registrations.Wait()
	close(results)
	close(monitorStop)
	<-monitorDone
	for result := range results {
		if !result.OK {
			t.Fatal("simultaneous scale conflict proposal was not recorded")
		}
	}
	select {
	case <-invalidIntermediate:
		t.Fatal("committed scale state exposed both overlapping tasks without atomic blocking")
	default:
	}
	scaleWait(t, "simultaneous conflict did not block both tasks across surviving peers", func() bool {
		for _, peer := range peers {
			if peer.node == nil {
				continue
			}
			state := peer.node.FSM.State()
			left, right := state.Tasks["scale-left"], state.Tasks["scale-right"]
			if left == nil || right == nil || left.Status != "blocked" || right.Status != "blocked" || len(left.Conflicts) != 1 || len(right.Conflicts) != 1 || left.Conflicts[0] != right.ID || right.Conflicts[0] != left.ID {
				return false
			}
		}
		return true
	})

	// Keep exactly five, including the latest leader, so this exercises loss of
	// its majority rather than only querying followers after a clean handoff.
	survivors := []*scalePeer{leader}
	for _, peer := range peers {
		if peer.node != nil && peer != leader && len(survivors) < 5 {
			survivors = append(survivors, peer)
		}
	}
	for _, peer := range peers {
		keep := false
		for _, survivor := range survivors {
			if survivor == peer {
				keep = true
			}
		}
		if !keep {
			scaleStop(t, peer)
		}
	}
	for _, peer := range survivors {
		snapshot := scaleSnapshot(peer.node)
		if snapshot.HasAuthority || len(snapshot.Members) != 10 || !scaleVoterRoster(peer.node) {
			t.Fatal("five of ten peers invented authority or shrank their voter roster")
		}
		request := taskRequest(proposal("scale-no-quorum-"+peer.id, "Scale.unapproved"))
		result := scaleCommand(peer.node, request)
		if result.OK || result.Error == nil || (result.Error.Code != "NO_AUTHORITY" && result.Error.Code != "OUTCOME_UNKNOWN") {
			t.Fatal("a minority peer granted new work without six of ten voters")
		}
	}
	t.Log("five of ten voters refused new work and retained membership")

	previousLeader.config.PeerHints = scaleHints(peers)
	scaleOpen(t, previousLeader, false)
	if previousLeader.node.FSM.State().Tasks["scale-task-00"] == nil {
		t.Fatal("reopened scale peer lost its persisted task projection")
	}
	scaleRefreshHints(t, peers)
	leader = scaleFindLeader(t, peers)
	if !scaleCommand(leader.node, taskRequest(proposal("scale-recovered", "Scale.recovered"))).OK {
		t.Fatal("restored six-of-ten quorum could not commit new work")
	}
	for _, peer := range peers {
		if peer.node != nil {
			continue
		}
		peer.config.PeerHints = scaleHints(peers)
		scaleOpen(t, peer, false)
		scaleRefreshHints(t, peers)
	}
	final := leader.node.FSM.State()
	scaleWait(t, "reopened ten-peer pool did not converge to its retained committed tasks", func() bool {
		for _, peer := range peers {
			if !scaleVoterRoster(peer.node) || !reflect.DeepEqual(peer.node.FSM.State(), final) {
				return false
			}
			lan, _ := peer.node.FSM.LANState()
			if lan == nil || len(lan.Members) != 10 {
				return false
			}
			for index, owner := range peers {
				if lan.TaskDevices[fmt.Sprintf("scale-task-%02d", index)] != owner.id {
					return false
				}
			}
		}
		return true
	})
	for _, peer := range peers {
		if final.Tasks["scale-no-quorum-"+peer.id] != nil {
			t.Fatal("recovery exposed work that a minority should never have admitted")
		}
	}
	if final.Tasks["scale-left"].Status != "blocked" || final.Tasks["scale-right"].Status != "blocked" || final.Tasks["scale-after-loss"] == nil || final.Tasks["scale-recovered"] == nil {
		t.Fatal("recovery changed conflict or majority-approved task history")
	}
	for index := range peers {
		if final.Tasks[fmt.Sprintf("scale-task-%02d", index)].Status != "active" {
			t.Fatal("offline scope reservation was released during quorum loss")
		}
	}
	t.Log("saved peer identities restored quorum and all ten durable replicas converged")
}
