package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func (runtime *lanRuntime) peerCall(ctx context.Context, deviceID, method, path string, body any, output any, pinned *LANMember, controlURL string) error {
	if controlURL == "" {
		hint, ok := runtime.hint(deviceID)
		if !ok {
			return errors.New("peer endpoint is unknown")
		}
		controlURL = hint.ControlURL
	}
	config, err := runtime.clientTLS(deviceID, pinned, "http/1.1", pinned == nil)
	if err != nil {
		return err
	}
	var data []byte
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, controlURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{TLSClientConfig: config, DisableKeepAlives: true, TLSHandshakeTimeout: 2 * time.Second, ResponseHeaderTimeout: 5 * time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("authenticated peer connection failed")
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, maxStateBytes+65537))
	if err != nil || len(encoded) > maxStateBytes+65536 {
		return errors.New("invalid peer response size")
	}
	if response.StatusCode != http.StatusOK {
		return errors.New("peer did not confirm an authoritative result")
	}
	if err := decodeStrict(encoded, output); err != nil {
		return errors.New("invalid authenticated peer response")
	}
	return nil
}

func (runtime *lanRuntime) active(id string) bool {
	state, _ := runtime.node.FSM.LANState()
	return state != nil && state.Members[id].Stage == "active"
}

func (runtime *lanRuntime) snapshot(ctx context.Context) Snapshot {
	snapshot := runtime.node.localSnapshot(ctx)
	snapshot.AuthoritySource = "cached"
	if !runtime.node.FSM.Healthy() || !runtime.active(runtime.id) {
		snapshot.HasAuthority = false
		return snapshot
	}
	if snapshot.HasAuthority {
		snapshot.AuthoritySource = "local"
		return snapshot
	}
	_, leader := runtime.node.Raft.LeaderWithID()
	if string(leader) == "" || string(leader) == runtime.id {
		return snapshot
	}
	var remote Snapshot
	if runtime.peerCall(ctx, string(leader), http.MethodGet, "/lan/v1/snapshot", nil, &remote, nil, "") == nil && remote.HasAuthority && remote.LeaderID == string(leader) && remote.NodeID == string(leader) {
		remote.NodeID = runtime.id
		remote.AuthoritySource = "forwarded"
		return remote
	}
	return snapshot
}

func (runtime *lanRuntime) command(ctx context.Context, request CommandRequest) CommandResult {
	encoded, err := json.Marshal(request)
	if err != nil {
		return failure("INVALID_COMMAND", "invalid command")
	}
	if _, err := DecodeRequest(encoded); err != nil {
		return failure("INVALID_COMMAND", "command validation failed")
	}
	if !runtime.node.FSM.Healthy() {
		return failure("STORAGE_FAILURE", "restore this Mac's durable storage before accepting new work")
	}
	if !runtime.active(runtime.id) {
		return failure("DEVICE_NOT_AUTHORIZED", "this Mac is not yet an active workspace member")
	}
	if runtime.node.HasAuthority(ctx) {
		return runtime.authoritativeCommand(ctx, runtime.id, request)
	}
	_, leader := runtime.node.Raft.LeaderWithID()
	if string(leader) == "" || string(leader) == runtime.id {
		return failure("NO_AUTHORITY", "new work waits for an authoritative coordinator")
	}
	var result CommandResult
	if err := runtime.peerCall(ctx, string(leader), http.MethodPost, "/lan/v1/commands", request, &result, nil, ""); err != nil {
		return failure("OUTCOME_UNKNOWN", "no authoritative commit was confirmed; retry the same requestId")
	}
	return result
}

func (runtime *lanRuntime) authoritativeCommand(ctx context.Context, actor string, request CommandRequest) CommandResult {
	if !runtime.active(actor) || !runtime.active(runtime.id) {
		return failure("DEVICE_NOT_AUTHORIZED", "only active enrolled devices may submit task commands")
	}
	if !runtime.node.HasAuthority(ctx) {
		return failure("NO_AUTHORITY", "leader authority could not be verified")
	}
	encoded, err := json.Marshal(lanEnvelope{Protocol: "agent-lan-command-v1", Actor: actor, Request: &request})
	if err != nil {
		return failure("INVALID_COMMAND", "invalid command")
	}
	if _, _, _, err := decodeLog(encoded); err != nil {
		return failure("INVALID_COMMAND", "invalid command")
	}
	future := runtime.node.Raft.Apply(encoded, 500*time.Millisecond)
	if waitFuture(ctx, future) != nil {
		return failure("OUTCOME_UNKNOWN", "commit was not confirmed; retry the same requestId")
	}
	result, ok := future.Response().(CommandResult)
	if !ok {
		return failure("INTERNAL_ERROR", "unexpected coordinator response")
	}
	return result
}

func (runtime *lanRuntime) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		if request.Header.Get("Origin") != "" {
			writeJSON(writer, http.StatusForbidden, failure("ORIGIN_NOT_ALLOWED", "browser requests are not supported"))
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
		defer cancel()
		if request.URL.Path == "/lan/v1/join" && request.Method == http.MethodPost {
			runtime.handleJoin(ctx, writer, request)
			return
		}
		if request.TLS == nil {
			writeJSON(writer, http.StatusUnauthorized, failure("UNAUTHORIZED", "mutual TLS is required"))
			return
		}
		actor, err := runtime.authenticated(*request.TLS)
		if err != nil {
			writeJSON(writer, http.StatusUnauthorized, failure("UNAUTHORIZED", "an enrolled device certificate is required"))
			return
		}
		switch {
		case request.URL.Path == "/lan/v1/peer-hints" && request.Method == http.MethodPost:
			if !runtime.active(actor) {
				writeJSON(writer, http.StatusForbidden, failure("NOT_ACTIVE", "only active members may share endpoint hints"))
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 8192))
			var hints struct {
				PeerHints []PeerHint `json:"peerHints"`
			}
			if err != nil || decodeStrict(body, &hints) != nil || runtime.updateHints(hints.PeerHints) != nil {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_HINTS", "invalid endpoint hints"))
				return
			}
			writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
		case request.URL.Path == "/lan/v1/sync" && request.Method == http.MethodGet:
			state, index := runtime.node.FSM.LANState()
			if state == nil {
				writeJSON(writer, http.StatusServiceUnavailable, failure("NOT_READY", "membership is not yet replicated"))
				return
			}
			writeJSON(writer, http.StatusOK, struct {
				DeviceID     string `json:"deviceId"`
				AppliedIndex uint64 `json:"appliedIndex"`
				WorkspaceID  string `json:"workspaceId"`
			}{runtime.id, index, state.WorkspaceID})
		case request.URL.Path == "/lan/v1/snapshot" && request.Method == http.MethodGet:
			if !runtime.active(actor) || !runtime.active(runtime.id) || !runtime.node.HasAuthority(ctx) {
				writeJSON(writer, http.StatusServiceUnavailable, failure("NO_AUTHORITY", "an active leader is required"))
				return
			}
			snapshot := runtime.node.localSnapshot(ctx)
			snapshot.AuthoritySource = "local"
			if !snapshot.HasAuthority {
				writeJSON(writer, http.StatusServiceUnavailable, failure("NO_AUTHORITY", "authority was lost"))
				return
			}
			writeJSON(writer, http.StatusOK, snapshot)
		case request.URL.Path == "/lan/v1/commands" && request.Method == http.MethodPost:
			body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBytes))
			command, decodeErr := DecodeRequest(body)
			if err != nil || decodeErr != nil {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_COMMAND", "invalid command"))
				return
			}
			writeJSON(writer, http.StatusOK, runtime.authoritativeCommand(ctx, actor, command))
		default:
			writeJSON(writer, http.StatusNotFound, failure("NOT_FOUND", "unknown peer endpoint"))
		}
	})
}
