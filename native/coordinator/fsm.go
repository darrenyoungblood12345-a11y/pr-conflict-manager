package coordinator

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"sync"

	"github.com/hashicorp/raft"
)

const maxStateBytes = 64 * 1024 * 1024

type requestRecord struct {
	Actor        string `json:"actor,omitempty"`
	Fingerprint  string `json:"fingerprint"`
	TaskID       string `json:"taskId,omitempty"`
	TaskRevision uint64 `json:"taskRevision,omitempty"`
	PlanRevision uint64 `json:"planRevision"`
}

type persistedFSM struct {
	Version   int                      `json:"version"`
	LastIndex uint64                   `json:"lastIndex"`
	State     WorkspaceState           `json:"state"`
	Requests  map[string]requestRecord `json:"requests"`
	LAN       *LANState                `json:"lan,omitempty"`
}

// FSM contains only committed domain state. Persisting a projection also lets a
// restarted minority show previously applied history before it regains quorum.
// LastIndex prevents replaying failed old commands against a newer projection.
type FSM struct {
	mu      sync.RWMutex
	data    persistedFSM
	persist func([]byte) error
	fatal   error
	// Fixed across production nodes. Tests inject a smaller bound before use.
	stateByteLimit int
	requireLAN     bool
}

func NewFSM() *FSM {
	return &FSM{data: persistedFSM{Version: 1, State: initialState(), Requests: map[string]requestRecord{}}, stateByteLimit: maxStateBytes}
}

func (fsm *FSM) State() WorkspaceState {
	fsm.mu.RLock()
	defer fsm.mu.RUnlock()
	return cloneState(fsm.data.State)
}

func (fsm *FSM) Healthy() bool {
	fsm.mu.RLock()
	defer fsm.mu.RUnlock()
	return fsm.fatal == nil
}

func (fsm *FSM) Apply(log *raft.Log) interface{} {
	fsm.mu.Lock()
	defer fsm.mu.Unlock()
	request, operation, actor, err := decodeLog(log.Data)
	result := failure("INVALID_COMMAND", "command validation failed")
	candidate := fsm.data
	if err == nil && operation != nil {
		if log.Index <= fsm.data.LastIndex {
			result = failure("ALREADY_APPLIED", "membership entry already applied")
		} else {
			result = reduceLAN(&candidate, *operation)
			if !result.OK {
				candidate = fsm.data
			}
		}
	} else if err == nil && (fsm.requireLAN || fsm.data.LAN != nil) && !authorizeLAN(fsm.data.LAN, actor, request) {
		result = failure("DEVICE_NOT_AUTHORIZED", "only an active enrolled task owner may submit this command")
	} else if err == nil && fsm.data.LAN != nil && request.Command.Type == "register_task" && fsm.data.State.Repository == nil {
		result = failure("REPOSITORY_REQUIRED", "bind the workspace to its GitHub repository before registering work")
	} else if err == nil && fsm.data.LAN != nil && request.Command.Type == "mark_pr_merged" && fsm.data.State.Tasks[request.Command.TaskID] != nil && fsm.data.State.Tasks[request.Command.TaskID].PullRequest == nil {
		result = failure("PULL_REQUEST_REQUIRED", "link this task to its repository pull request before recording a merge")
	} else if err == nil {
		if log.Index <= fsm.data.LastIndex {
			result = fsm.retry(request, actor)
		} else if _, exists := fsm.data.Requests[request.RequestID]; exists {
			result = fsm.retry(request, actor)
		} else {
			next := cloneState(fsm.data.State)
			result = reduce(&next, request.Command)
			if result.OK {
				candidate.State = next
				candidate.Requests = cloneRequestRecords(fsm.data.Requests)
				record := requestRecord{Actor: actor, Fingerprint: fingerprint(request), TaskID: result.TaskID, PlanRevision: next.Plan.Revision}
				if task := next.Tasks[result.TaskID]; task != nil {
					record.TaskRevision = task.Revision
				}
				candidate.Requests[request.RequestID] = record
				if candidate.LAN != nil && request.Command.Type == "register_task" {
					candidate.LAN = cloneLAN(candidate.LAN)
					candidate.LAN.TaskDevices[result.TaskID] = actor
				}
			}
		}
	}
	if log.Index > fsm.data.LastIndex {
		candidate.LastIndex = log.Index
		encoded, encodeErr := json.Marshal(candidate)
		if encodeErr == nil && !fitsStateBound(encoded, candidate.LastIndex, fsm.stateByteLimit) {
			// The log command is committed, but its domain operation is rejected
			// atomically. Include deduplication and activity in the size check;
			// retaining only a small state while its ledger grows is not enough.
			result = failure("STATE_LIMIT", "workspace storage limit reached; no task or plan changes were accepted")
			candidate = fsm.data
			candidate.LastIndex = log.Index
			encoded, encodeErr = json.Marshal(candidate)
		}
		if encodeErr != nil {
			fsm.fatal = errors.New("committed state encoding failed")
			result = failure("STORAGE_FAILURE", "committed state could not be encoded; restore local storage before continuing")
		} else {
			fsm.data = candidate
		}
		if fsm.persist != nil {
			if encodeErr == nil {
				encodeErr = fsm.persist(encoded)
			}
			if encodeErr != nil {
				// The Raft entry is already committed: never pretend it was rolled
				// back. Refuse further authority if the local durable view failed.
				fsm.fatal = errors.New("committed projection persistence failed")
				result = failure("STORAGE_FAILURE", "the command outcome must be rechecked after local storage recovery")
			}
		}
	}
	state := cloneState(fsm.data.State)
	result.State = &state
	return result
}

func cloneRequestRecords(records map[string]requestRecord) map[string]requestRecord {
	copy := make(map[string]requestRecord, len(records)+1)
	for key, record := range records {
		copy[key] = record
	}
	return copy
}

func fitsStateBound(encoded []byte, index uint64, limit int) bool {
	// Reserve the full uint64 width so recording a later rejected command's
	// applied index cannot make a previously accepted snapshot unrestorable.
	return len(encoded)+20-len(strconv.FormatUint(index, 10)) <= limit
}

func (fsm *FSM) retry(request CommandRequest, actor string) CommandResult {
	record, exists := fsm.data.Requests[request.RequestID]
	if !exists {
		return failure("ALREADY_APPLIED", "this log entry has already been applied")
	}
	if record.Fingerprint != fingerprint(request) || record.Actor != actor {
		return failure("REQUEST_ID_REUSED", "requestId was already used for a different command")
	}
	if request.Command.Type == "bind_repository" {
		if fsm.data.State.Repository == nil || *fsm.data.State.Repository != *request.Command.Repository {
			return failure("REPOSITORY_MISMATCH", "workspace repository binding changed unexpectedly")
		}
		return CommandResult{OK: true}
	}
	if record.TaskID != "" {
		task := fsm.data.State.Tasks[record.TaskID]
		if task == nil || task.Revision != record.TaskRevision {
			result := failure("STALE_RETRY", "the command was recorded, but its task has since changed; inspect current state")
			result.TaskID = record.TaskID
			return result
		}
	} else if fsm.data.State.Plan.Revision != record.PlanRevision {
		return failure("STALE_RETRY", "the plan has changed since this command; inspect current state")
	}
	return CommandResult{OK: true, TaskID: record.TaskID}
}

func reduce(state *WorkspaceState, command Command) CommandResult {
	if command.Type == "bind_repository" {
		if state.Repository != nil {
			if *state.Repository != *command.Repository {
				return failure("REPOSITORY_MISMATCH", "this workspace is permanently bound to another GitHub repository")
			}
			return CommandResult{OK: true}
		}
		repository := *command.Repository
		state.Repository = &repository
		appendEvent(state, command.Type, "", "Workspace repository bound to "+repository.Owner+"/"+repository.Repo)
		return CommandResult{OK: true}
	}
	if command.Type == "set_plan" {
		if *command.ExpectedRevision != state.Plan.Revision {
			return failure("REVISION_MISMATCH", "the shared plan changed; read it before submitting again")
		}
		state.Plan = Plan{Revision: state.Plan.Revision + 1, Markdown: command.Markdown}
		appendEvent(state, command.Type, "", "Shared plan updated")
		return CommandResult{OK: true}
	}
	if command.Type == "register_task" {
		if _, exists := state.Tasks[command.Task.ID]; exists {
			return failure("TASK_EXISTS", "a task with this identifier already exists")
		}
		if command.Task.PlanRevision != state.Plan.Revision {
			return failure("PLAN_CHANGED", "read the current shared plan before registering work")
		}
		task := &Task{TaskProposal: *command.Task, Revision: 1, Status: "active", Conflicts: []string{}}
		registerScopes(state, task)
		appendEvent(state, command.Type, task.ID, "Task registered as "+task.Status)
		return CommandResult{OK: true, TaskID: task.ID}
	}
	task := state.Tasks[command.TaskID]
	if task == nil {
		return failure("TASK_NOT_FOUND", "task does not exist")
	}
	if command.Type != "mark_pr_merged" && task.OwnerID != command.OwnerID {
		return failure("OWNER_MISMATCH", "only this task's owner can change its execution state")
	}
	if *command.ExpectedRevision != task.Revision {
		return failure("REVISION_MISMATCH", "task changed; inspect its current revision")
	}
	if !holdsReservation(task) {
		return failure("TASK_TERMINAL", "completed or cancelled tasks cannot resume; register a new task")
	}
	switch command.Type {
	case "link_pull_request":
		if task.PullRequest != nil && task.PullRequest.Number == *command.Number {
			return CommandResult{OK: true, TaskID: task.ID}
		}
		if task.PullRequest != nil && !task.StopAcknowledged {
			return failure("STOP_REQUIRED", "acknowledge stopped work before replacing a task's pull request")
		}
		task.PullRequest = &PullRequest{Number: *command.Number}
		task.PRMerged = false
		task.Revision++
	case "acknowledge_stop":
		task.StopAcknowledged = true
		// An acknowledgement is a durable stop, not a new permission receipt.
		if task.Status == "active" {
			task.Status = "blocked"
		}
		task.Revision++
		completeIfReady(state, task)
	case "cancel_task":
		if !task.StopAcknowledged {
			return failure("STOP_REQUIRED", "acknowledge that admitted and background writes stopped before cancelling")
		}
		task.Status = "cancelled"
		task.Revision++
		task.Conflicts = []string{}
		removeConflictReferences(state, task.ID)
	case "report_completion":
		task.Status = "awaiting-merge"
		task.Revision++
		completeIfReady(state, task)
	case "mark_pr_merged":
		task.PRMerged = true
		task.Revision++
		completeIfReady(state, task)
	case "revise_task":
		if !task.StopAcknowledged {
			return failure("STOP_REQUIRED", "old-scope writes must stop and be acknowledged before replacing a reservation")
		}
		if command.Task.ID != task.ID || command.Task.OwnerID != task.OwnerID {
			return failure("IDENTITY_MISMATCH", "a revision cannot replace the task or its owner identity")
		}
		if command.Task.PlanRevision != state.Plan.Revision {
			return failure("PLAN_CHANGED", "read the current shared plan before revising work")
		}
		removeConflictReferences(state, task.ID)
		next := &Task{TaskProposal: *command.Task, Revision: task.Revision + 1, Status: "active", Conflicts: []string{}}
		registerScopes(state, next)
	default:
		return failure("INVALID_COMMAND", "unsupported task command")
	}
	appendEvent(state, command.Type, task.ID, "Task "+command.Type+" recorded")
	return CommandResult{OK: true, TaskID: task.ID}
}

func completeIfReady(state *WorkspaceState, task *Task) {
	// A merge observation alone never releases an active/offline task. The
	// explicit completion and stop acknowledgement must refer to current work.
	if task.Status != "awaiting-merge" || !task.StopAcknowledged || !task.PRMerged {
		return
	}
	task.Status = "completed"
	task.Conflicts = []string{}
	removeConflictReferences(state, task.ID)
}

func holdsReservation(task *Task) bool {
	return task.Status == "active" || task.Status == "blocked" || task.Status == "awaiting-merge"
}

func registerScopes(state *WorkspaceState, task *Task) {
	for _, id := range sortedTaskIDs(state.Tasks) {
		holder := state.Tasks[id]
		if id == task.ID || !holdsReservation(holder) || !tasksOverlap(task, holder) {
			continue
		}
		task.Status = "blocked"
		task.Conflicts = append(task.Conflicts, id)
		holder.Status = "blocked"
		holder.StopAcknowledged = false
		holder.Revision++
		holder.Conflicts = appendUnique(holder.Conflicts, task.ID)
	}
	state.Tasks[task.ID] = task
}

func tasksOverlap(left, right *Task) bool {
	for _, leftScope := range left.Scopes {
		for _, rightScope := range right.Scopes {
			if scopesOverlap(leftScope, rightScope) {
				return true
			}
		}
	}
	return false
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	values = append(values, value)
	sort.Strings(values)
	return values
}

func removeConflictReferences(state *WorkspaceState, id string) {
	for _, otherID := range sortedTaskIDs(state.Tasks) {
		other := state.Tasks[otherID]
		if otherID == id {
			continue
		}
		filtered := make([]string, 0, len(other.Conflicts))
		for _, conflictID := range other.Conflicts {
			if conflictID != id {
				filtered = append(filtered, conflictID)
			}
		}
		if len(filtered) != len(other.Conflicts) {
			other.Conflicts = filtered
			other.Revision++
			// Remaining blocked tasks must be explicitly revised by their
			// owners; releasing another scope never resumes writing itself.
		}
	}
}

func sortedTaskIDs(tasks map[string]*Task) []string {
	ids := make([]string, 0, len(tasks))
	for id := range tasks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func appendEvent(state *WorkspaceState, eventType, taskID, message string) {
	state.Events = append(state.Events, ActivityEvent{Index: uint64(len(state.Events) + 1), Type: eventType, TaskID: taskID, Message: message})
}

func cloneState(state WorkspaceState) WorkspaceState {
	copy := WorkspaceState{Plan: state.Plan, Tasks: make(map[string]*Task, len(state.Tasks)), Events: append([]ActivityEvent{}, state.Events...)}
	if state.Repository != nil {
		repository := *state.Repository
		copy.Repository = &repository
	}
	for id, task := range state.Tasks {
		value := *task
		value.Scopes = append([]Scope{}, task.Scopes...)
		if task.PullRequest != nil {
			pullRequest := *task.PullRequest
			value.PullRequest = &pullRequest
		}
		value.Conflicts = append([]string{}, task.Conflicts...)
		copy.Tasks[id] = &value
	}
	return copy
}

type immutableSnapshot struct{ data []byte }

func (fsm *FSM) Snapshot() (raft.FSMSnapshot, error) {
	fsm.mu.RLock()
	defer fsm.mu.RUnlock()
	data, err := json.Marshal(fsm.data)
	return &immutableSnapshot{data: data}, err
}

func (snapshot *immutableSnapshot) Persist(sink raft.SnapshotSink) error {
	if _, err := sink.Write(snapshot.data); err != nil {
		_ = sink.Cancel()
		return err
	}
	if err := sink.Close(); err != nil {
		_ = sink.Cancel()
		return err
	}
	return nil
}

func (snapshot *immutableSnapshot) Release() {}

func (fsm *FSM) Restore(reader io.ReadCloser) error {
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, int64(fsm.stateByteLimit)+1))
	if err != nil || len(data) > fsm.stateByteLimit {
		return errors.New("snapshot is unreadable or exceeds the size limit")
	}
	var restored persistedFSM
	if err := decodeStrict(data, &restored); err != nil {
		return fmt.Errorf("invalid FSM snapshot: %w", err)
	}
	if restored.Version != 1 || restored.State.Tasks == nil || restored.State.Events == nil || restored.Requests == nil {
		return errors.New("snapshot version or required state is invalid")
	}
	if restored.State.Repository != nil {
		normalized, err := normalizeRepository(*restored.State.Repository)
		if err != nil || normalized != *restored.State.Repository {
			return errors.New("snapshot contains invalid repository binding")
		}
	}
	if restored.LAN != nil {
		if !lanIdentifier.MatchString(restored.LAN.WorkspaceID) || restored.LAN.Members == nil || restored.LAN.TaskDevices == nil || len(restored.LAN.Members) > 10 {
			return errors.New("invalid saved LAN roster")
		}
		for id, member := range restored.LAN.Members {
			if id != member.DeviceID || !lanIdentifier.MatchString(id) {
				return errors.New("invalid saved device identity")
			}
			if _, err := parseCA(member.CACertPEM, restored.LAN.WorkspaceID, id); err != nil {
				return errors.New("invalid saved device authority")
			}
			if member.Stage != "pending" && member.Stage != "nonvoter" && member.Stage != "active" {
				return errors.New("invalid saved membership stage")
			}
		}
		for id, device := range restored.LAN.TaskDevices {
			if restored.State.Tasks[id] == nil || restored.LAN.Members[device].DeviceID == "" {
				return errors.New("invalid saved task device")
			}
		}
		for id := range restored.State.Tasks {
			if restored.LAN.TaskDevices[id] == "" {
				return errors.New("missing saved task device")
			}
		}
	}
	if !fitsStateBound(data, restored.LastIndex, fsm.stateByteLimit) {
		return errors.New("snapshot has no space for durable applied-index bookkeeping")
	}
	for id, task := range restored.State.Tasks {
		if task == nil || id != task.ID || task.Revision == 0 {
			return errors.New("snapshot contains an invalid task")
		}
		if task.PullRequest != nil && (task.PullRequest.Number == 0 || task.PullRequest.Number > maxSafeInteger) {
			return errors.New("snapshot contains an invalid pull request link")
		}
		if _, err := normalizeProposal(task.TaskProposal); err != nil {
			return errors.New("snapshot contains invalid task scopes")
		}
		switch task.Status {
		case "active", "blocked", "awaiting-merge", "completed", "cancelled":
		default:
			return errors.New("snapshot contains an invalid task status")
		}
	}
	fsm.mu.Lock()
	defer fsm.mu.Unlock()
	// A committed projection can be ahead of the last periodic Raft snapshot
	// after a crash. Keep that known-committed view while Raft replays the log;
	// Apply's persisted index skips already-applied entries. Manual rollback
	// restores are deliberately not exposed by this feasibility harness.
	if restored.LastIndex < fsm.data.LastIndex {
		return nil
	}
	if fsm.persist != nil {
		if err := fsm.persist(data); err != nil {
			return errors.New("cannot persist restored state")
		}
	}
	fsm.data = restored
	fsm.fatal = nil
	return nil
}
