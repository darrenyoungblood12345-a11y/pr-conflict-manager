package coordinator

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"sync"
	"testing"
)

func repositoryRequest(requestID, owner, repo string) CommandRequest {
	return CommandRequest{RequestID: requestID, Command: Command{Type: "bind_repository", Repository: &Repository{Owner: owner, Repo: repo}}}
}

func TestRepositoryBindingCanonicalImmutableIdempotentAndDurable(t *testing.T) {
	fsm := NewFSM()
	request := repositoryRequest("bind-once", "Example", "Project")
	requireOK(t, applyRequest(t, fsm, request))
	if *fsm.State().Repository != (Repository{Owner: "example", Repo: "project"}) {
		t.Fatal("repository not canonicalized")
	}
	if len(fsm.State().Events) != 1 {
		t.Fatal("first binding event missing")
	}
	requireOK(t, applyRequest(t, fsm, repositoryRequest("bind-again", "EXAMPLE", "PROJECT")))
	before := fsm.State()
	requireCode(t, applyRequest(t, fsm, repositoryRequest("wrong-repo", "example", "other")), "REPOSITORY_MISMATCH")
	if !reflect.DeepEqual(before, fsm.State()) {
		t.Fatal("rejected rebind mutated workspace")
	}
	requireOK(t, applyRequest(t, fsm, CommandRequest{RequestID: "plan-after-bind", Command: Command{Type: "set_plan", ExpectedRevision: revision(0), Markdown: "Plan"}}))
	requireOK(t, applyRequest(t, fsm, request)) // A plan update does not stale an immutable identity binding.
	state := fsm.State()
	state.Repository.Repo = "tampered"
	if fsm.State().Repository.Repo != "project" {
		t.Fatal("mutable repository escaped snapshot")
	}
	encoded, _ := json.Marshal(fsm.data)
	restored := NewFSM()
	if err := restored.Restore(io.NopCloser(bytes.NewReader(encoded))); err != nil {
		t.Fatal(err)
	}
	requireCode(t, applyRequest(t, restored, repositoryRequest("still-immutable", "another", "repository")), "REPOSITORY_MISMATCH")
	if restored.State().Repository.Repo != "project" {
		t.Fatal("restore lost repository binding")
	}
	var corrupted persistedFSM
	_ = json.Unmarshal(encoded, &corrupted)
	corrupted.State.Repository.Owner = "EXAMPLE"
	bad, _ := json.Marshal(corrupted)
	if err := NewFSM().Restore(io.NopCloser(bytes.NewReader(bad))); err == nil {
		t.Fatal("noncanonical persisted identity accepted")
	}
}

func TestRepositorySchemaRejectsAmbiguousIdentityAndBoundedMutation(t *testing.T) {
	for _, identity := range []Repository{{Owner: "-example", Repo: "project"}, {Owner: "example-", Repo: "project"}, {Owner: "example/other", Repo: "project"}, {Owner: "example", Repo: ".."}, {Owner: "example", Repo: "project.git/other"}, {Owner: "example", Repo: ""}} {
		data, _ := json.Marshal(CommandRequest{RequestID: "bad-bind", Command: Command{Type: "bind_repository", Repository: &identity}})
		if _, err := DecodeRequest(data); err == nil {
			t.Fatalf("invalid repository accepted: %+v", identity)
		}
	}
	for _, data := range []string{`{"requestId":"bind","command":{"type":"bind_repository","repository":null}}`, `{"requestId":"bind","command":{"type":"bind_repository","repository":{"owner":"example","repo":"project","url":"secret"}}}`, `{"requestId":"bind","command":{"type":"bind_repository","repository":{"owner":"example","owner":"other","repo":"project"}}}`} {
		if _, err := DecodeRequest([]byte(data)); err == nil {
			t.Fatal("ambiguous repository schema accepted")
		}
	}
	fsm := NewFSM()
	encoded, _ := json.Marshal(fsm.data)
	fsm.stateByteLimit = len(encoded) + 40
	requireCode(t, applyRequest(t, fsm, repositoryRequest("bounded-bind", "example", "project")), "STATE_LIMIT")
	if fsm.State().Repository != nil || len(fsm.State().Events) != 0 {
		t.Fatal("bounded rejection partially bound repository")
	}
}

func TestLANConcurrentRepositoryBindingCommitsOnlyOneIdentity(t *testing.T) {
	node := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	eventually(t, "LAN did not become active before repository fixture", func() bool { return node.lan.active(node.id) })
	var wg sync.WaitGroup
	results := make(chan CommandResult, 2)
	for _, repo := range []string{"left", "right"} {
		wg.Add(1)
		go func(repo string) {
			defer wg.Done()
			results <- nodeCommand(t, node, repositoryRequest("bind-"+repo, "example", repo))
		}(repo)
	}
	wg.Wait()
	close(results)
	accepted, rejected := 0, 0
	for result := range results {
		if result.OK {
			accepted++
		} else if result.Error != nil && result.Error.Code == "REPOSITORY_MISMATCH" {
			rejected++
		} else {
			t.Fatalf("unexpected bind result: %+v", result.Error)
		}
	}
	if accepted != 1 || rejected != 1 || node.FSM.State().Repository == nil || len(node.FSM.State().Events) != 1 {
		t.Fatal("concurrent first binds did not serialize to one permanent repository")
	}
}
