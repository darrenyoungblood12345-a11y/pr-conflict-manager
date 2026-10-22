package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/hashicorp/raft"
)

type LANMember struct {
	DeviceID      string `json:"deviceId"`
	CACertPEM     string `json:"caCertPEM"`
	Stage         string `json:"stage"`
	JoinRequestID string `json:"joinRequestId"`
}

type LANState struct {
	WorkspaceID string               `json:"workspaceId"`
	Members     map[string]LANMember `json:"members"`
	TaskDevices map[string]string    `json:"taskDevices"`
}

type lanOperation struct {
	Type        string     `json:"type"`
	WorkspaceID string     `json:"workspaceId"`
	Member      *LANMember `json:"member,omitempty"`
	DeviceID    string     `json:"deviceId,omitempty"`
}

type lanEnvelope struct {
	Protocol  string          `json:"protocol"`
	Actor     string          `json:"actor,omitempty"`
	Request   *CommandRequest `json:"request,omitempty"`
	Operation *lanOperation   `json:"operation,omitempty"`
}

func cloneLAN(state *LANState) *LANState {
	if state == nil {
		return nil
	}
	next := &LANState{WorkspaceID: state.WorkspaceID, Members: make(map[string]LANMember, len(state.Members)), TaskDevices: make(map[string]string, len(state.TaskDevices))}
	for id, member := range state.Members {
		next.Members[id] = member
	}
	for id, device := range state.TaskDevices {
		next.TaskDevices[id] = device
	}
	return next
}

func (fsm *FSM) LANState() (*LANState, uint64) {
	fsm.mu.RLock()
	defer fsm.mu.RUnlock()
	return cloneLAN(fsm.data.LAN), fsm.data.LastIndex
}

func decodeLog(data []byte) (CommandRequest, *lanOperation, string, error) {
	var header struct {
		Protocol string `json:"protocol"`
	}
	if json.Unmarshal(data, &header) != nil {
		return CommandRequest{}, nil, "", errors.New("invalid log")
	}
	if header.Protocol == "" {
		request, err := DecodeRequest(data)
		return request, nil, "", err
	}
	var envelope lanEnvelope
	if len(data) > maxRequestBytes+4096 || decodeStrict(data, &envelope) != nil {
		return CommandRequest{}, nil, "", errors.New("invalid LAN log")
	}
	if envelope.Protocol == "agent-lan-v1" && envelope.Operation != nil && envelope.Request == nil && envelope.Actor == "" {
		return CommandRequest{}, envelope.Operation, "", nil
	}
	if envelope.Protocol == "agent-lan-command-v1" && envelope.Request != nil && envelope.Operation == nil && lanIdentifier.MatchString(envelope.Actor) {
		encoded, _ := json.Marshal(envelope.Request)
		request, err := DecodeRequest(encoded)
		return request, nil, envelope.Actor, err
	}
	return CommandRequest{}, nil, "", errors.New("invalid LAN log envelope")
}

func reduceLAN(candidate *persistedFSM, operation lanOperation) CommandResult {
	if !lanIdentifier.MatchString(operation.WorkspaceID) {
		return failure("INVALID_LAN", "invalid workspace identity")
	}
	if operation.Type == "initialize" {
		if candidate.LAN != nil {
			return failure("ALREADY_INITIALIZED", "workspace identity already committed")
		}
		if len(candidate.State.Tasks) != 0 || candidate.State.Plan.Revision != 0 || operation.Member == nil || operation.Member.Stage != "active" {
			return failure("INVALID_LAN", "LAN mode requires a fresh workspace")
		}
		candidate.LAN = &LANState{WorkspaceID: operation.WorkspaceID, Members: map[string]LANMember{}, TaskDevices: map[string]string{}}
	}
	if candidate.LAN == nil || candidate.LAN.WorkspaceID != operation.WorkspaceID {
		return failure("INVALID_LAN", "workspace identity mismatch")
	}
	next := cloneLAN(candidate.LAN)
	switch operation.Type {
	case "initialize", "enroll":
		member := operation.Member
		if member == nil || !lanIdentifier.MatchString(member.DeviceID) || !identifier.MatchString(member.JoinRequestID) || (operation.Type == "enroll" && member.Stage != "pending") {
			return failure("INVALID_LAN", "invalid enrollment")
		}
		if _, err := parseCA(member.CACertPEM, operation.WorkspaceID, member.DeviceID); err != nil {
			return failure("INVALID_LAN", "invalid device authority")
		}
		if existing, ok := next.Members[member.DeviceID]; ok {
			if existing.CACertPEM != member.CACertPEM || existing.JoinRequestID != member.JoinRequestID {
				return failure("IDENTITY_CONFLICT", "device identity is already enrolled")
			}
			return CommandResult{OK: true}
		}
		if len(next.Members) >= 10 {
			return failure("MEMBER_LIMIT", "workspace already contains ten enrolled devices")
		}
		for _, other := range next.Members {
			if other.JoinRequestID == member.JoinRequestID {
				return failure("REQUEST_ID_REUSED", "enrollment request belongs to another device")
			}
		}
		next.Members[member.DeviceID] = *member
	case "nonvoter", "activate":
		member, ok := next.Members[operation.DeviceID]
		if !ok {
			return failure("MEMBER_NOT_FOUND", "device is not enrolled")
		}
		if operation.Type == "nonvoter" {
			if member.Stage == "active" {
				return failure("INVALID_LAN", "active voters cannot be downgraded by enrollment")
			}
			member.Stage = "nonvoter"
		} else {
			if member.Stage != "nonvoter" && member.Stage != "active" {
				return failure("INVALID_LAN", "device has not caught up as a nonvoter")
			}
			member.Stage = "active"
		}
		next.Members[member.DeviceID] = member
	case "sync":
		// A committed FSM marker gives an actual applied-index target. Raft's
		// AppliedIndex alone may include commands merely queued to the FSM.
	default:
		return failure("INVALID_LAN", "unsupported membership operation")
	}
	candidate.LAN = next
	return CommandResult{OK: true}
}

func authorizeLAN(state *LANState, actor string, request CommandRequest) bool {
	if state == nil {
		return false
	}
	member, ok := state.Members[actor]
	if !ok || member.Stage != "active" {
		return false
	}
	command := request.Command
	if command.Type == "set_plan" || command.Type == "bind_repository" || command.Type == "register_task" || command.Type == "mark_pr_merged" {
		return true
	}
	return state.TaskDevices[command.TaskID] == actor
}

func (node *Node) applyLAN(ctxTimeout time.Duration, operation lanOperation) (uint64, CommandResult) {
	// Kept internal: neither local nor LAN task APIs accept membership entries.
	encoded, _ := json.Marshal(lanEnvelope{Protocol: "agent-lan-v1", Operation: &operation})
	future := node.Raft.Apply(encoded, ctxTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), ctxTimeout)
	defer cancel()
	if err := waitFuture(ctx, future); err != nil {
		return 0, failure("OUTCOME_UNKNOWN", "membership commit was not confirmed")
	}
	result, ok := future.Response().(CommandResult)
	if !ok {
		return 0, failure("INTERNAL_ERROR", "unexpected membership response")
	}
	return future.Index(), result
}

// Compile-time reminder that the transport uses real HashiCorp Raft commands.
var _ raft.FSM = (*FSM)(nil)
