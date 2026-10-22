package coordinator

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/hashicorp/raft"
)

func proposal(id, symbol string) TaskProposal {
	return TaskProposal{ID: id, OwnerID: "owner-" + id, SessionID: "session-" + id, Agent: "codex", Branch: "work/" + id, BaseCommit: "abcdef0123456789", Description: "Implement " + symbol, Scopes: []Scope{{Path: "src/app.ts", Kind: "symbol", Symbol: symbol}}}
}

func revision(value uint64) *uint64 { return &value }

func applyRequest(t *testing.T, fsm *FSM, request CommandRequest) CommandResult {
	t.Helper()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return fsm.Apply(&raft.Log{Index: fsm.data.LastIndex + 1, Type: raft.LogCommand, Data: data}).(CommandResult)
}

func registerTask(t *testing.T, fsm *FSM, task TaskProposal) CommandResult {
	t.Helper()
	return applyRequest(t, fsm, CommandRequest{RequestID: "register-" + task.ID, Command: Command{Type: "register_task", Task: &task}})
}

func owned(t *testing.T, fsm *FSM, commandType, id string) CommandResult {
	t.Helper()
	task := fsm.State().Tasks[id]
	return applyRequest(t, fsm, CommandRequest{RequestID: commandType + "-" + id + "-" + string(rune('a'+task.Revision)), Command: Command{Type: commandType, TaskID: id, OwnerID: task.OwnerID, ExpectedRevision: revision(task.Revision)}})
}

func requireOK(t *testing.T, result CommandResult) {
	t.Helper()
	if !result.OK {
		t.Fatalf("expected success, got %+v", result.Error)
	}
}

func requireCode(t *testing.T, result CommandResult, code string) {
	t.Helper()
	if result.OK || result.Error == nil || result.Error.Code != code {
		t.Fatalf("expected %s, got %+v", code, result)
	}
}

func TestRegistrationsReserveDifferentFunctionsAndAtomicallyBlockConflicts(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("one", "App.start")))
	requireOK(t, registerTask(t, fsm, proposal("two", "App.stop")))
	if fsm.State().Tasks["one"].Status != "active" || fsm.State().Tasks["two"].Status != "active" {
		t.Fatal("independent functions should be active together")
	}
	third := proposal("three", "App.start")
	third.Scopes[0].Path = "SRC/APP.TS"
	requireOK(t, registerTask(t, fsm, third))
	state := fsm.State()
	if state.Tasks["one"].Status != "blocked" || state.Tasks["three"].Status != "blocked" || state.Tasks["two"].Status != "active" {
		t.Fatal("the conflict must block both affected holders only")
	}
	if state.Tasks["one"].Revision != 2 || state.Tasks["one"].StopAcknowledged || !reflect.DeepEqual(state.Tasks["one"].Conflicts, []string{"three"}) {
		t.Fatal("blocked holders need a fresh revision, stop acknowledgement, and conflict link")
	}
	if state.Tasks["three"].Scopes[0].Path != "src/app.ts" {
		t.Fatal("paths were not case-normalized")
	}
}

func TestWholeFileAndNestedSymbolsConflictWhileCaseSensitiveSymbolsStayDistinct(t *testing.T) {
	for _, scopes := range [][2]Scope{
		{{Path: "a.ts", Kind: "file"}, {Path: "a.ts", Kind: "symbol", Symbol: "run"}},
		{{Path: "a.ts", Kind: "symbol", Symbol: "App.run"}, {Path: "a.ts", Kind: "symbol", Symbol: "App.run.child"}},
		{{Path: "a.cc", Kind: "symbol", Symbol: "app::run"}, {Path: "a.cc", Kind: "symbol", Symbol: "app::run::nested"}},
	} {
		if !scopesOverlap(scopes[0], scopes[1]) || !scopesOverlap(scopes[1], scopes[0]) {
			t.Fatalf("expected symmetric overlap for %+v", scopes)
		}
	}
	if scopesOverlap(Scope{Path: "a", Kind: "symbol", Symbol: "Run"}, Scope{Path: "a", Kind: "symbol", Symbol: "run"}) {
		t.Fatal("symbol case is language-sensitive even on a case-insensitive filesystem")
	}
}

func TestInvalidCommandsAndForeignOwnersNeverMutateDomainState(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("one", "run")))
	before := fsm.State()
	badOwner := CommandRequest{RequestID: "bad-owner", Command: Command{Type: "acknowledge_stop", TaskID: "one", OwnerID: "somebody-else", ExpectedRevision: revision(1)}}
	requireCode(t, applyRequest(t, fsm, badOwner), "OWNER_MISMATCH")
	badRevision := CommandRequest{RequestID: "bad-revision", Command: Command{Type: "cancel_task", TaskID: "one", OwnerID: "owner-one", ExpectedRevision: revision(0)}}
	requireCode(t, applyRequest(t, fsm, badRevision), "REVISION_MISMATCH")
	requireCode(t, owned(t, fsm, "cancel_task", "one"), "STOP_REQUIRED")
	for _, raw := range []string{
		`{"requestId":"bad","command":{"type":"register_task","task":null}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":0,"markdown":"ok","ownerId":"extra"}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":-1,"markdown":"ok"}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":0.5,"markdown":"ok"}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":9007199254740992,"markdown":"ok"}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":0,"expectedRevision":1,"markdown":"ok"}}`,
		`{"requestId":"bad","command":{"type":"set_plan","expectedRevision":0,"markdown":"ok"}} {}`,
	} {
		if _, err := DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("expected payload rejection: %s", raw)
		}
		result := fsm.Apply(&raft.Log{Index: fsm.data.LastIndex + 1, Data: []byte(raw)}).(CommandResult)
		requireCode(t, result, "INVALID_COMMAND")
	}
	if !reflect.DeepEqual(before, fsm.State()) {
		t.Fatal("rejected commands changed domain state")
	}
}

func TestPathsRejectTraversalAndNormalizeCanonicalUnicodeAliases(t *testing.T) {
	for _, value := range []string{"../secret", "a/../b", "/etc/passwd", "a//b", "a/./b", "C:\\file", "a\\b", "a/ b", "a/b ", ".", "~/.ssh", "a/\x00b"} {
		if _, err := normalizeRepoPath(value); err == nil {
			t.Fatalf("expected unsafe path rejection: %q", value)
		}
	}
	first, err := normalizeRepoPath("SRC/Caf\u00e9.ts")
	if err != nil {
		t.Fatal(err)
	}
	second, err := normalizeRepoPath("src/cafe\u0301.ts")
	if err != nil || first != second {
		t.Fatal("case/canonical Unicode aliases must share a reservation")
	}
	invalid := proposal("bad", "run")
	invalid.Scopes[0].Symbol = ""
	if _, err := normalizeProposal(invalid); err == nil {
		t.Fatal("a missing symbol cannot silently grant an underscoped reservation")
	}
	invalid.Scopes = []Scope{{Path: "src/app.ts", Kind: "file"}}
	if _, err := normalizeProposal(invalid); err != nil {
		t.Fatal("explicit whole-file parser fallback should be accepted")
	}
}

func TestPlanAndTaskRevisionsRequireCurrentStateAndStoppedOldWrites(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, applyRequest(t, fsm, CommandRequest{RequestID: "plan", Command: Command{Type: "set_plan", ExpectedRevision: revision(0), Markdown: "# Shared plan"}}))
	task := proposal("one", "run")
	requireCode(t, registerTask(t, fsm, task), "PLAN_CHANGED")
	task.PlanRevision = 1
	requireOK(t, registerTask(t, fsm, task))
	updated := task
	updated.Scopes = []Scope{{Path: "src/new.ts", Kind: "symbol", Symbol: "newRun"}}
	revise := CommandRequest{RequestID: "revise", Command: Command{Type: "revise_task", TaskID: task.ID, OwnerID: task.OwnerID, ExpectedRevision: revision(1), Task: &updated}}
	requireCode(t, applyRequest(t, fsm, revise), "STOP_REQUIRED")
	requireOK(t, owned(t, fsm, "acknowledge_stop", task.ID))
	revise.Command.ExpectedRevision = revision(2)
	requireOK(t, applyRequest(t, fsm, revise))
	current := fsm.State().Tasks[task.ID]
	if current.Revision != 3 || current.Status != "active" || current.StopAcknowledged || current.PRMerged || current.Scopes[0].Path != "src/new.ts" {
		t.Fatal("a revised scope must have a new active revision and clear prior execution receipts")
	}
	other := proposal("two", "run")
	other.PlanRevision = 1
	requireOK(t, registerTask(t, fsm, other))
	if fsm.State().Tasks["two"].Status != "active" {
		t.Fatal("revised task should no longer reserve its stopped old scope")
	}
}

func TestMergedOfflineTaskRetainsScopeUntilStopAndCompletion(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("one", "run")))
	requireOK(t, applyRequest(t, fsm, CommandRequest{RequestID: "merge", Command: Command{Type: "mark_pr_merged", TaskID: "one", ExpectedRevision: revision(1)}}))
	if !holdsReservation(fsm.State().Tasks["one"]) || fsm.State().Tasks["one"].Status != "active" {
		t.Fatal("a PR merge cannot stop or release an offline active task")
	}
	requireOK(t, registerTask(t, fsm, proposal("two", "run")))
	if fsm.State().Tasks["two"].Status != "blocked" {
		t.Fatal("merged but unacknowledged work must still block overlap")
	}
	requireOK(t, owned(t, fsm, "report_completion", "one"))
	if fsm.State().Tasks["one"].Status != "awaiting-merge" {
		t.Fatal("completion without stop acknowledgement must retain scope")
	}
	requireOK(t, owned(t, fsm, "acknowledge_stop", "one"))
	state := fsm.State()
	if state.Tasks["one"].Status != "completed" || len(state.Tasks["two"].Conflicts) != 0 || state.Tasks["two"].Status != "blocked" {
		t.Fatal("release must clear conflict links without silently restarting another task")
	}
}

func TestCancellationNeedsOwnerStopAndNeverRevivesAnOldAcceptance(t *testing.T) {
	fsm := NewFSM()
	task := proposal("one", "run")
	requireOK(t, registerTask(t, fsm, task))
	original := CommandRequest{RequestID: "register-one", Command: Command{Type: "register_task", Task: &task}}
	requireOK(t, applyRequest(t, fsm, original))
	if len(fsm.State().Events) != 1 {
		t.Fatal("idempotent retry duplicated activity")
	}
	requireOK(t, owned(t, fsm, "acknowledge_stop", "one"))
	requireOK(t, owned(t, fsm, "cancel_task", "one"))
	requireCode(t, applyRequest(t, fsm, original), "STALE_RETRY")
	original.Command.Task.Description = "Different payload"
	requireCode(t, applyRequest(t, fsm, original), "REQUEST_ID_REUSED")
	requireCode(t, owned(t, fsm, "acknowledge_stop", "one"), "TASK_TERMINAL")
	if fsm.State().Tasks["one"].Status != "cancelled" {
		t.Fatal("old requests must never resume cancelled work")
	}
}

type memorySink struct {
	bytes.Buffer
	closed, cancelled bool
}

func (sink *memorySink) ID() string    { return "test" }
func (sink *memorySink) Close() error  { sink.closed = true; return nil }
func (sink *memorySink) Cancel() error { sink.cancelled = true; return nil }

func TestSnapshotsAreImmutableAndRestoreIdempotencyAndReservations(t *testing.T) {
	fsm := NewFSM()
	task := proposal("one", "run")
	requireOK(t, registerTask(t, fsm, task))
	snapshot, err := fsm.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	before := fsm.State()
	requireOK(t, registerTask(t, fsm, proposal("two", "run")))
	sink := &memorySink{}
	if err := snapshot.Persist(sink); err != nil || !sink.closed || sink.cancelled {
		t.Fatal("snapshot must close a successfully persisted sink")
	}
	restored := NewFSM()
	if err := restored.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, restored.State()) {
		t.Fatal("snapshot changed after later FSM mutations")
	}
	requireOK(t, registerTask(t, restored, task))
	if len(restored.State().Events) != 1 {
		t.Fatal("restoring a snapshot lost idempotency records")
	}
	view := restored.State()
	view.Tasks["one"].Scopes[0].Path = "changed"
	view.Tasks["one"].Conflicts = append(view.Tasks["one"].Conflicts, "mutated")
	if restored.State().Tasks["one"].Scopes[0].Path == "changed" || len(restored.State().Tasks["one"].Conflicts) > 0 {
		t.Fatal("a caller mutated authoritative state through its snapshot copy")
	}
	if err := restored.Restore(io.NopCloser(strings.NewReader(`{"version":1}`))); err == nil || !reflect.DeepEqual(before, restored.State()) {
		t.Fatal("invalid snapshot restore must not mutate existing state")
	}
}

func TestEmptyPlanRoundTripsThroughCommandContract(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, applyRequest(t, fsm, CommandRequest{RequestID: "empty-plan", Command: Command{Type: "set_plan", ExpectedRevision: revision(0), Markdown: ""}}))
}

func TestCumulativeStateBoundIncludesActivityAndDeduplicationWithoutPartialMutation(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("bounded", "run")))
	before := fsm.State()
	encoded, err := json.Marshal(fsm.data)
	if err != nil {
		t.Fatal(err)
	}
	// Reserve only a little room beyond the already-accepted fixture. This
	// tests the actual cumulative boundary without allocating a 64 MiB state.
	fsm.stateByteLimit = len(encoded) + 64
	seenBefore := len(fsm.data.Requests)
	largePlan := CommandRequest{RequestID: "too-large-plan", Command: Command{Type: "set_plan", ExpectedRevision: revision(0), Markdown: strings.Repeat("x", 512)}}
	requireCode(t, applyRequest(t, fsm, largePlan), "STATE_LIMIT")
	// Even a small task mutation must account for its activity and replay
	// record; accepting only the task payload would exceed the restore bound.
	requireCode(t, owned(t, fsm, "acknowledge_stop", "bounded"), "STATE_LIMIT")
	if !reflect.DeepEqual(before, fsm.State()) || len(fsm.data.Requests) != seenBefore {
		t.Fatal("size rejection partially mutated the plan, reservation, events, or request ledger")
	}
	snapshot, err := fsm.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	sink := &memorySink{}
	if err := snapshot.Persist(sink); err != nil || len(sink.Bytes()) > fsm.stateByteLimit {
		t.Fatal("an accepted state produced an oversized snapshot")
	}
	restored := NewFSM()
	restored.stateByteLimit = fsm.stateByteLimit
	if err := restored.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil || !reflect.DeepEqual(before, restored.State()) {
		t.Fatal("accepted bounded state could not be restored")
	}
}

func TestCommittedStateIsRetainedAndAuthorityHealthFailsAfterProjectionWriteFailure(t *testing.T) {
	fsm := NewFSM()
	fsm.persist = func([]byte) error { return errors.New("injected disk write failure") }
	requireCode(t, registerTask(t, fsm, proposal("committed", "run")), "STORAGE_FAILURE")
	if fsm.Healthy() || fsm.State().Tasks["committed"] == nil {
		t.Fatal("a committed command cannot be rolled back when local projection persistence fails")
	}
}

func TestUnicodePathFixturesMatchFullFoldingAndCanonicalNormalization(t *testing.T) {
	for _, fixture := range []struct{ input, expected string }{
		{"src/Straße.ts", "src/strasse.ts"},
		{"src/Σ.ts", "src/σ.ts"},
		{"src/ς.ts", "src/σ.ts"},
		{"src/ﬃ.ts", "src/ffi.ts"},
		{"src/Café.ts", "src/café.ts"},
		{"src/Cafe\u0301.ts", "src/café.ts"},
		{"src/İ.ts", "src/i\u0307.ts"},
	} {
		actual, err := normalizeRepoPath(fixture.input)
		if err != nil || actual != fixture.expected {
			t.Fatalf("normalization mismatch for %q: got %q, want %q", fixture.input, actual, fixture.expected)
		}
	}
}

func TestUnstableUnicodeIdentitiesCannotCreateAliasedReservations(t *testing.T) {
	for _, file := range []string{"src/Ꭰ.ts", "src/ꭰ.ts", "src/Ᏸ.ts", "src/ᏸ.ts", "src/" + strings.Repeat("İ", 400) + ".ts"} {
		if _, err := normalizeRepoPath(file); err == nil {
			t.Fatalf("unqualified or expanding path %q was accepted", file)
		}
		fsm := NewFSM()
		task := proposal("unqualified", "run")
		task.Scopes[0].Path = file
		result := registerTask(t, fsm, task)
		if result.OK || len(fsm.State().Tasks) != 0 {
			t.Fatal("an unqualified path created an authoritative reservation")
		}
	}
}
