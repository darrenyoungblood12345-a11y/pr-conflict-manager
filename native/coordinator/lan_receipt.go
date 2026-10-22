package coordinator

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"time"
)

const maxReceiptBytes = maxRequestBytes + 4096

type TaskReceipt struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	CertPEM   string `json:"certPEM"`
}

type taskReceiptPayload struct {
	Version        int         `json:"version"`
	WorkspaceID    string      `json:"workspaceId"`
	IssuerDeviceID string      `json:"issuerDeviceId"`
	Task           *Task       `json:"task"`
	CommitIndex    uint64      `json:"commitIndex"`
	Repository     *Repository `json:"repository"`
}

// IssueTaskReceipt never turns a cached reservation into a fresh approval. The
// local leaf signs only after a current quorum-backed state read; a follower
// obtains that read through the mutually authenticated leader connection.
func (node *Node) IssueTaskReceipt(ctx context.Context, taskID string, revision uint64) (*TaskReceipt, CommandResult) {
	if node.lan == nil {
		return nil, failure("LAN_REQUIRED", "offline receipts require an authenticated LAN workspace")
	}
	if !identifier.MatchString(taskID) || revision == 0 || revision > maxSafeInteger {
		return nil, failure("INVALID_RECEIPT_REQUEST", "an exact task identifier and positive revision are required")
	}
	if !node.FSM.Healthy() || !node.lan.active(node.id) {
		return nil, failure("DEVICE_NOT_AUTHORIZED", "this Mac is not ready to issue execution receipts")
	}
	snapshot := node.Snapshot(ctx)
	if !snapshot.HasAuthority {
		return nil, failure("NO_AUTHORITY", "a fresh authoritative task check is required before issuing a receipt")
	}
	if snapshot.Repository == nil {
		return nil, failure("REPOSITORY_REQUIRED", "bind the workspace repository before issuing an execution receipt")
	}
	task := snapshot.Tasks[taskID]
	if task == nil {
		return nil, failure("TASK_NOT_FOUND", "task does not exist")
	}
	if task.Revision != revision {
		return nil, failure("REVISION_MISMATCH", "the task changed; inspect its current revision")
	}
	if task.Status != "active" || task.StopAcknowledged || len(task.Conflicts) != 0 {
		return nil, failure("TASK_NOT_ACTIVE", "only an active task may receive an execution receipt")
	}
	state, _ := node.FSM.LANState()
	// A follower may receive the leader's committed registration response just
	// before its own FSM applies that entry. Wait briefly for the immutable
	// device binding; never guess an owner from caller-supplied task fields.
	deadline := time.NewTimer(500 * time.Millisecond)
	defer deadline.Stop()
	for state != nil && state.TaskDevices[taskID] == "" {
		select {
		case <-ctx.Done():
			return nil, failure("REPLICA_CATCHING_UP", "local task ownership has not caught up")
		case <-deadline.C:
			return nil, failure("REPLICA_CATCHING_UP", "local task ownership has not caught up")
		case <-time.After(10 * time.Millisecond):
		}
		state, _ = node.FSM.LANState()
	}
	if state == nil || state.TaskDevices[taskID] != node.id {
		return nil, failure("DEVICE_NOT_AUTHORIZED", "only this task's enrolled Mac may issue its receipt")
	}
	// Ownership catchup may have taken time. Recheck authority and the exact
	// active proposal after that wait instead of minting from the first read.
	fresh := node.Snapshot(ctx)
	if !fresh.HasAuthority {
		return nil, failure("NO_AUTHORITY", "authority was lost before receipt issuance")
	}
	current := fresh.Tasks[taskID]
	if current == nil || current.Revision != revision {
		return nil, failure("REVISION_MISMATCH", "task changed before receipt issuance")
	}
	if current.Status != "active" || current.StopAcknowledged || len(current.Conflicts) != 0 {
		return nil, failure("TASK_NOT_ACTIVE", "task stopped before receipt issuance")
	}
	if !reflect.DeepEqual(current, task) || fresh.Repository == nil || *fresh.Repository != *snapshot.Repository {
		return nil, failure("REVISION_MISMATCH", "task or repository changed before receipt issuance")
	}
	// Serialize signing with already-applied local stop/revision changes. A
	// later remote conflict can still arrive after any read; reconnect checks
	// and the agent gate must revoke such an earlier, valid receipt locally.
	node.FSM.mu.RLock()
	defer node.FSM.mu.RUnlock()
	local := node.FSM.data.State.Tasks[taskID]
	if node.FSM.fatal != nil || node.FSM.data.LAN == nil || node.FSM.data.LAN.TaskDevices[taskID] != node.id || node.FSM.data.LAN.Members[node.id].Stage != "active" {
		return nil, failure("DEVICE_NOT_AUTHORIZED", "local durable authorization changed")
	}
	if local != nil && (local.Revision > revision || local.Revision == revision && !reflect.DeepEqual(local, current)) {
		return nil, failure("REVISION_MISMATCH", "newer local task state prevents receipt issuance")
	}
	key, ok := node.lan.pair.PrivateKey.(ed25519.PrivateKey)
	if !ok {
		return nil, failure("UNSUPPORTED_IDENTITY", "this device identity does not support qualified execution receipts")
	}
	payload, err := json.Marshal(taskReceiptPayload{Version: 1, WorkspaceID: state.WorkspaceID, IssuerDeviceID: node.id, Task: current, CommitIndex: fresh.CommitIndex, Repository: fresh.Repository})
	if err != nil || len(payload) > maxReceiptBytes {
		return nil, failure("RECEIPT_LIMIT", "task receipt exceeds its qualified size limit")
	}
	signature := ed25519.Sign(key, payload)
	return &TaskReceipt{Payload: base64.RawURLEncoding.EncodeToString(payload), Signature: base64.RawURLEncoding.EncodeToString(signature), CertPEM: node.lan.config.Identity.CertPEM}, CommandResult{OK: true}
}
