package coordinator

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"testing"
)

func linkRequest(requestID string, task *Task, number uint64) CommandRequest {
	return CommandRequest{RequestID: requestID, Command: Command{Type: "link_pull_request", TaskID: task.ID, OwnerID: task.OwnerID, ExpectedRevision: revision(task.Revision), Number: revision(number)}}
}

func TestPullRequestLinkIsOwnedVersionedAndReplacementRequiresStoppedWork(t *testing.T) {
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("work", "run")))
	requireCode(t, applyRequest(t, fsm, CommandRequest{RequestID: "wrong-owner", Command: Command{Type: "link_pull_request", TaskID: "work", OwnerID: "other-owner", ExpectedRevision: revision(1), Number: revision(42)}}), "OWNER_MISMATCH")
	requireOK(t, applyRequest(t, fsm, linkRequest("link-42", fsm.State().Tasks["work"], 42)))
	state := fsm.State()
	if state.Tasks["work"].Revision != 2 || state.Tasks["work"].PullRequest.Number != 42 || state.Tasks["work"].Status != "active" {
		t.Fatal("first link changed execution status or omitted revision")
	}
	beforeEvents := len(state.Events)
	requireOK(t, applyRequest(t, fsm, linkRequest("same-link", state.Tasks["work"], 42)))
	if len(fsm.State().Events) != beforeEvents || fsm.State().Tasks["work"].Revision != 2 {
		t.Fatal("same PR link was not idempotent")
	}
	requireCode(t, applyRequest(t, fsm, linkRequest("replace-active", fsm.State().Tasks["work"], 43)), "STOP_REQUIRED")
	requireOK(t, applyRequest(t, fsm, CommandRequest{RequestID: "merge-42", Command: Command{Type: "mark_pr_merged", TaskID: "work", ExpectedRevision: revision(2)}}))
	if fsm.State().Tasks["work"].Status != "active" || !fsm.State().Tasks["work"].PRMerged {
		t.Fatal("merge alone released an active reservation")
	}
	requireOK(t, owned(t, fsm, "acknowledge_stop", "work"))
	requireOK(t, applyRequest(t, fsm, linkRequest("replace-stopped", fsm.State().Tasks["work"], 43)))
	task := fsm.State().Tasks["work"]
	if task.PullRequest.Number != 43 || task.PRMerged || !task.StopAcknowledged || task.Status != "blocked" {
		t.Fatal("replacement retained old merge evidence or resumed execution")
	}
	encoded, _ := json.Marshal(fsm.data)
	restored := NewFSM()
	if err := restored.Restore(io.NopCloser(bytes.NewReader(encoded))); err != nil {
		t.Fatal(err)
	}
	view := restored.State()
	view.Tasks["work"].PullRequest.Number = 999
	if restored.State().Tasks["work"].PullRequest.Number != 43 {
		t.Fatal("mutable PR link escaped snapshot")
	}
	proposal := proposal("work", "different")
	requireOK(t, applyRequest(t, restored, CommandRequest{RequestID: "revise-clears-link", Command: Command{Type: "revise_task", TaskID: "work", OwnerID: proposal.OwnerID, ExpectedRevision: revision(task.Revision), Task: &proposal}}))
	if restored.State().Tasks["work"].PullRequest != nil || restored.State().Tasks["work"].PRMerged {
		t.Fatal("scope revision retained prior PR/merge evidence")
	}
}

func TestLANMergeRequiresLinkedPRAndReceiptsBindItsCurrentNumber(t *testing.T) {
	node := openLAN(t, "one", t.TempDir(), lanConfig(t, "one"), true)
	waitActive(t, node)
	requireOK(t, nodeCommand(t, node, taskRequest(proposal("work", "run"))))
	requireCode(t, nodeCommand(t, node, CommandRequest{RequestID: "unlinked-merge", Command: Command{Type: "mark_pr_merged", TaskID: "work", ExpectedRevision: revision(1)}}), "PULL_REQUEST_REQUIRED")
	requireOK(t, nodeCommand(t, node, linkRequest("link-work", node.FSM.State().Tasks["work"], 42)))
	_, result := node.IssueTaskReceipt(context.Background(), "work", 1)
	requireCode(t, result, "REVISION_MISMATCH")
	receipt, result := node.IssueTaskReceipt(context.Background(), "work", 2)
	requireOK(t, result)
	data, _ := base64.RawURLEncoding.DecodeString(receipt.Payload)
	var payload taskReceiptPayload
	if json.Unmarshal(data, &payload) != nil || payload.Task.PullRequest == nil || payload.Task.PullRequest.Number != 42 {
		t.Fatal("receipt omitted task's current PR link")
	}
	requireOK(t, nodeCommand(t, node, CommandRequest{RequestID: "linked-merge", Command: Command{Type: "mark_pr_merged", TaskID: "work", ExpectedRevision: revision(2)}}))
	if node.FSM.State().Tasks["work"].Status != "active" {
		t.Fatal("linked merge released offline active work")
	}
}

func TestPullRequestSchemaRejectsInvalidNumbersAndSnapshotLinks(t *testing.T) {
	for _, number := range []uint64{0, maxSafeInteger + 1} {
		data, _ := json.Marshal(CommandRequest{RequestID: "invalid-pr", Command: Command{Type: "link_pull_request", TaskID: "work", OwnerID: "owner-work", ExpectedRevision: revision(1), Number: revision(number)}})
		if _, err := DecodeRequest(data); err == nil {
			t.Fatal("invalid PR number accepted")
		}
	}
	for _, data := range []string{`{"requestId":"link","command":{"type":"link_pull_request","taskId":"work","ownerId":"owner-work","expectedRevision":1,"number":1.5}}`, `{"requestId":"link","command":{"type":"link_pull_request","taskId":"work","ownerId":"owner-work","expectedRevision":1,"number":-1}}`, `{"requestId":"link","command":{"type":"link_pull_request","taskId":"work","ownerId":"owner-work","expectedRevision":1,"number":null}}`} {
		if _, err := DecodeRequest([]byte(data)); err == nil {
			t.Fatal("invalid PR schema accepted")
		}
	}
	fsm := NewFSM()
	requireOK(t, registerTask(t, fsm, proposal("work", "run")))
	fsm.data.State.Tasks["work"].PullRequest = &PullRequest{Number: 0}
	data, _ := json.Marshal(fsm.data)
	if err := NewFSM().Restore(io.NopCloser(bytes.NewReader(data))); err == nil {
		t.Fatal("invalid persisted PR link accepted")
	}
}
