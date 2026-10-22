package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

func startNode(t *testing.T, id, directory string, bootstrap bool) *Node {
	t.Helper()
	node, err := OpenNode(Options{ID: id, DataDir: directory, Bootstrap: bootstrap, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Close() })
	return node
}

func eventually(t *testing.T, message string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(message)
}

func authority(node *Node) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	return node.HasAuthority(ctx)
}

func waitLeader(t *testing.T, nodes ...*Node) *Node {
	t.Helper()
	var found *Node
	eventually(t, "no node established quorum-backed leadership", func() bool {
		for _, node := range nodes {
			if authority(node) {
				found = node
				return true
			}
		}
		return false
	})
	return found
}

func join(t *testing.T, leader, follower *Node) {
	t.Helper()
	if err := leader.Raft.AddVoter(raft.ServerID(follower.id), follower.Transport.LocalAddr(), 0, time.Second).Error(); err != nil {
		t.Fatal(err)
	}
	if !authority(leader) {
		t.Fatal("leader lost quorum after committed membership change")
	}
}

func nodeCommand(t *testing.T, node *Node, request CommandRequest) CommandResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return node.Command(ctx, request)
}

func taskRequest(task TaskProposal) CommandRequest {
	return CommandRequest{RequestID: "register-" + task.ID, Command: Command{Type: "register_task", Task: &task}}
}

func TestTwoVotingNodesLoseApprovalAuthorityWithoutShrinkingMembership(t *testing.T) {
	first := startNode(t, "one", t.TempDir(), true)
	waitLeader(t, first)
	second := startNode(t, "two", t.TempDir(), false)
	join(t, first, second)
	requireOK(t, nodeCommand(t, first, taskRequest(proposal("existing", "run"))))
	before := first.FSM.State()
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if authority(first) {
		t.Fatal("a single reachable member of two cannot verify leadership")
	}
	requireCode(t, nodeCommand(t, first, taskRequest(proposal("new", "different"))), "NO_AUTHORITY")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snapshot := first.Snapshot(ctx)
	if snapshot.HasAuthority || len(snapshot.Members) != 2 || !reflect.DeepEqual(before, snapshot.WorkspaceState) {
		t.Fatal("lost peers must not shrink the voter roster or alter retained task state")
	}
}

func TestThreeNodeLeaderLossKeepsCommittedReservationsAndCatchesUpReturningPeer(t *testing.T) {
	directories := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	first := startNode(t, "one", directories[0], true)
	waitLeader(t, first)
	second := startNode(t, "two", directories[1], false)
	third := startNode(t, "three", directories[2], false)
	join(t, first, second)
	join(t, first, third)
	results := make(chan CommandResult, 2)
	var wait sync.WaitGroup
	for _, id := range []string{"alpha", "beta"} {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			results <- first.Command(ctx, taskRequest(proposal(id, "sameFunction")))
		}(id)
	}
	wait.Wait()
	close(results)
	initialActive := 0
	for result := range results {
		requireOK(t, result)
		if result.State.Tasks[result.TaskID].Status == "active" {
			initialActive++
		}
	}
	if initialActive != 1 {
		t.Fatal("one serialized registration may be accepted before the overlap arrives")
	}
	state := first.FSM.State()
	if state.Tasks["alpha"].Status != "blocked" || state.Tasks["beta"].Status != "blocked" {
		t.Fatal("after both commits both overlapping tasks must be blocked")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	leader := waitLeader(t, second, third)
	if leader.FSM.State().Tasks["alpha"].Status != "blocked" || leader.FSM.State().Tasks["beta"].Status != "blocked" {
		t.Fatal("new leader lost committed reservations")
	}
	requireOK(t, nodeCommand(t, leader, taskRequest(proposal("after-loss", "otherFunction"))))
	returning := startNode(t, "one", directories[0], false)
	eventually(t, "returning peer did not catch up with committed work", func() bool {
		return returning.FSM.State().Tasks["after-loss"] != nil
	})
	if authority(returning) {
		t.Fatal("returning former leader cannot claim authority from its cached state")
	}
}

func TestNormalRestartRestoresCommittedViewAndReusesEphemeralRaftAddress(t *testing.T) {
	directory := t.TempDir()
	first := startNode(t, "one", directory, true)
	waitLeader(t, first)
	request := taskRequest(proposal("persisted", "run"))
	requireOK(t, nodeCommand(t, first, request))
	savedAddress := first.Transport.LocalAddr()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := startNode(t, "one", directory, false)
	if restarted.Transport.LocalAddr() != savedAddress || restarted.FSM.State().Tasks["persisted"] == nil {
		t.Fatal("restart must immediately restore cached committed history and the persisted transport address")
	}
	waitLeader(t, restarted)
	requireOK(t, nodeCommand(t, restarted, request))
	if len(restarted.FSM.State().Events) != 1 {
		t.Fatal("Raft replay or retry duplicated persisted work")
	}
	current := restarted.FSM.State().Tasks["persisted"]
	requireOK(t, nodeCommand(t, restarted, CommandRequest{RequestID: "stop", Command: Command{Type: "acknowledge_stop", TaskID: current.ID, OwnerID: current.OwnerID, ExpectedRevision: revision(current.Revision)}}))
	current = restarted.FSM.State().Tasks["persisted"]
	requireOK(t, nodeCommand(t, restarted, CommandRequest{RequestID: "cancel", Command: Command{Type: "cancel_task", TaskID: current.ID, OwnerID: current.OwnerID, ExpectedRevision: revision(current.Revision)}}))
	if err := restarted.Raft.Snapshot().Error(); err != nil {
		t.Fatal(err)
	}
	_ = restarted.Close()
	if _, err := OpenNode(Options{ID: "one", DataDir: directory, Bootstrap: true, TestTimers: true}); err == nil {
		t.Fatal("existing state must never be bootstrapped again")
	}
	final := startNode(t, "one", directory, false)
	waitLeader(t, final)
	requireCode(t, nodeCommand(t, final, request), "STALE_RETRY")
	if final.FSM.State().Tasks["persisted"].Status != "cancelled" {
		t.Fatal("snapshot restoration revived a cancelled task")
	}
}

func TestHTTPBoundaryRequiresTokenAndRejectsBrowserOriginsAndInvalidWrites(t *testing.T) {
	node := startNode(t, "one", t.TempDir(), true)
	waitLeader(t, node)
	api, err := StartAPI(node, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.Close(context.Background()) })
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	for _, example := range []struct {
		method, path, token, origin, body string
		status                            int
	}{
		{http.MethodGet, "/v1/snapshot", "", "", "", http.StatusUnauthorized},
		{http.MethodGet, "/v1/snapshot", "wrong", "", "", http.StatusUnauthorized},
		{http.MethodGet, "/v1/snapshot", api.Ready.Token, "https://example.com", "", http.StatusForbidden},
		{http.MethodOptions, "/v1/snapshot", api.Ready.Token, "", "", http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/snapshot/", api.Ready.Token, "", "", http.StatusNotFound},
		{http.MethodPost, "/v1/commands", api.Ready.Token, "", `{}`, http.StatusBadRequest},
		{http.MethodPost, "/v1/commands", api.Ready.Token, "", strings.Repeat("x", maxRequestBytes+1), http.StatusBadRequest},
	} {
		request, _ := http.NewRequest(example.method, api.Ready.URL+example.path, strings.NewReader(example.body))
		if example.token != "" {
			request.Header.Set("Authorization", "Bearer "+example.token)
		}
		request.Header.Set("Origin", example.origin)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != example.status || response.Header.Get("Access-Control-Allow-Origin") != "" || response.Header.Get("Location") != "" {
			t.Fatalf("unexpected boundary result for %s: %d, %s", example.path, response.StatusCode, body)
		}
		if bytes.Contains(body, []byte(api.Ready.Token)) {
			t.Fatal("API responses must not include the bearer credential")
		}
	}
	if len(node.FSM.State().Events) != 0 {
		t.Fatal("rejected HTTP requests mutated domain state")
	}
	encoded, _ := json.Marshal(taskRequest(proposal("api", "run")))
	request, _ := http.NewRequest(http.MethodPost, api.Ready.URL+"/v1/commands", bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer "+api.Ready.Token)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result CommandResult
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil || response.StatusCode != http.StatusOK {
		t.Fatal("authenticated command did not return the shared contract")
	}
	requireOK(t, result)
}

func TestHelperRefusesNonLoopbackListenersAndDifferentPersistedIdentity(t *testing.T) {
	for _, address := range []string{"0.0.0.0:1234", "192.168.1.2:1234", "localhost:1234", ":1234"} {
		if err := requireLoopback(address); err == nil {
			t.Fatalf("unsafe bind accepted: %s", address)
		}
	}
	directory := t.TempDir()
	node := startNode(t, "original", directory, true)
	waitLeader(t, node)
	_ = node.Close()
	other, err := OpenNode(Options{ID: "different", DataDir: directory})
	if err == nil {
		_ = other.Close()
		t.Fatal("a data directory must remain bound to its persisted node identity")
	}
}

func TestBootstrapIfNewCreatesOnceAndNeverShrinksAnExistingTwoVoterRoster(t *testing.T) {
	directory := t.TempDir()
	first, err := OpenNode(Options{ID: "one", DataDir: directory, BootstrapIfNew: true, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	waitLeader(t, first)
	second := startNode(t, "two", t.TempDir(), false)
	join(t, first, second)
	requireOK(t, nodeCommand(t, first, taskRequest(proposal("saved", "run"))))
	_ = first.Close()
	_ = second.Close()
	restarted, err := OpenNode(Options{ID: "one", DataDir: directory, BootstrapIfNew: true, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	if restarted.FSM.State().Tasks["saved"] == nil {
		t.Fatal("if-new restart lost cached history")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snapshot := restarted.Snapshot(ctx)
	if snapshot.HasAuthority || len(snapshot.Members) != 2 {
		t.Fatal("if-new must preserve existing voter membership and refuse lone-survivor authority")
	}
	requireCode(t, nodeCommand(t, restarted, taskRequest(proposal("unsafe", "other"))), "NO_AUTHORITY")
}

func ExampleCommandRequest() {
	encoded, _ := json.Marshal(CommandRequest{RequestID: "read-plan-first", Command: Command{Type: "set_plan", ExpectedRevision: revision(0), Markdown: "# Shared plan"}})
	fmt.Println(string(encoded))
	// Output: {"requestId":"read-plan-first","command":{"expectedRevision":0,"markdown":"# Shared plan","type":"set_plan"}}
}
