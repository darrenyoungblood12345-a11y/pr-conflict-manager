package coordinator

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
	"go.etcd.io/bbolt"
)

var projectionKey = []byte("agent-pr-monitor/committed-fsm-v1")
var nodeIDKey = []byte("agent-pr-monitor/node-id-v1")
var raftAddressKey = []byte("agent-pr-monitor/raft-address-v1")

type Options struct {
	ID             string
	DataDir        string
	APIAddress     string
	RaftAddress    string
	Bootstrap      bool
	BootstrapIfNew bool
	LAN            *LANConfig
	// Fast timers are for real, local integration tests only.
	TestTimers bool
	// Fault-injection seam, unavailable through the CLI or LAN config.
	TestPauseLANAt string
}

type Node struct {
	Raft      *raft.Raft
	FSM       *FSM
	Transport *raft.NetworkTransport
	store     *raftboltdb.BoltStore
	id        string
	closed    sync.Once
	lan       *lanRuntime
}

func OpenNode(options Options) (*Node, error) {
	if !identifier.MatchString(options.ID) || options.DataDir == "" {
		return nil, errors.New("a bounded --id and --data-dir are required")
	}
	if options.Bootstrap && options.BootstrapIfNew {
		return nil, errors.New("--bootstrap and --bootstrap-if-new are mutually exclusive")
	}
	if options.LAN != nil && options.LAN.Join != nil && (options.Bootstrap || options.BootstrapIfNew) {
		return nil, errors.New("joining devices must never bootstrap a separate cluster")
	}
	if options.RaftAddress == "" {
		options.RaftAddress = "127.0.0.1:0"
	}
	if err := requireLoopback(options.RaftAddress); err != nil && options.LAN == nil {
		return nil, err
	}
	securedDirectory, err := prepareDataDirectory(options.DataDir)
	if err != nil {
		return nil, err
	}
	options.DataDir = securedDirectory
	store, err := raftboltdb.New(raftboltdb.Options{Path: filepath.Join(options.DataDir, "raft.db"), BoltOptions: &bbolt.Options{Timeout: time.Second}})
	if err != nil {
		return nil, errors.New("cannot open the durable store (check whether the workspace is already open)")
	}
	if savedID, err := store.Get(nodeIDKey); err == nil && string(savedID) != options.ID {
		_ = store.Close()
		return nil, errors.New("the data directory belongs to a different node identity")
	}
	_, port, _ := net.SplitHostPort(options.RaftAddress)
	if port == "0" && options.LAN == nil {
		if savedAddress, err := store.Get(raftAddressKey); err == nil && len(savedAddress) > 0 {
			if err := requireLoopback(string(savedAddress)); err != nil {
				_ = store.Close()
				return nil, errors.New("the saved Raft address is invalid")
			}
			options.RaftAddress = string(savedAddress)
		}
	}
	snapshots, err := raft.NewFileSnapshotStore(options.DataDir, 3, io.Discard)
	if err != nil {
		_ = store.Close()
		return nil, errors.New("cannot open the snapshot store")
	}
	existing, err := raft.HasExistingState(store, store, snapshots)
	if err != nil || (options.Bootstrap && existing) {
		_ = store.Close()
		return nil, errors.New("refusing to bootstrap over existing persisted Raft state")
	}
	if saved, _ := store.Get(lanBindingKey); len(saved) > 0 && options.LAN == nil {
		_ = store.Close()
		return nil, errors.New("saved LAN state requires its encrypted LAN identity profile")
	}
	fsm := NewFSM()
	if cached, err := store.Get(projectionKey); err == nil && len(cached) > 0 {
		if err := fsm.Restore(io.NopCloser(strings.NewReader(string(cached)))); err != nil {
			_ = store.Close()
			return nil, errors.New("the cached committed projection is invalid")
		}
	}
	fsm.persist = func(data []byte) error { return store.Set(projectionKey, data) }
	var lan *lanRuntime
	var transport *raft.NetworkTransport
	if options.LAN != nil {
		fsm.requireLAN = true
		lan, transport, err = newLANRuntime(options.ID, *options.LAN, store, existing, options.Bootstrap || options.BootstrapIfNew, fsm)
	} else {
		transport, err = raft.NewTCPTransport(options.RaftAddress, nil, 3, 750*time.Millisecond, io.Discard)
	}
	if err != nil {
		_ = store.Close()
		if options.LAN != nil {
			return nil, err
		}
		return nil, errors.New("cannot listen on the local Raft address")
	}
	if lan != nil && options.TestTimers {
		lan.pauseAt.Store(options.TestPauseLANAt)
	}
	closeUnstarted := func() {
		if lan != nil {
			lan.close()
		}
		_ = transport.Close()
		_ = store.Close()
	}
	if err := store.Set(nodeIDKey, []byte(options.ID)); err != nil {
		closeUnstarted()
		return nil, errors.New("cannot persist the local node identity")
	}
	if err := store.Set(raftAddressKey, []byte(transport.LocalAddr())); err != nil {
		closeUnstarted()
		return nil, errors.New("cannot persist the local Raft address")
	}
	config := raft.DefaultConfig()
	config.LocalID = raft.ServerID(options.ID)
	config.LogOutput = io.Discard
	config.SnapshotThreshold = 256
	config.TrailingLogs = 64
	if options.TestTimers {
		config.HeartbeatTimeout = 150 * time.Millisecond
		config.ElectionTimeout = 150 * time.Millisecond
		config.LeaderLeaseTimeout = 100 * time.Millisecond
		config.CommitTimeout = 10 * time.Millisecond
	}
	raftNode, err := raft.NewRaft(config, fsm, store, store, snapshots, transport)
	if err != nil {
		closeUnstarted()
		return nil, errors.New("cannot start the local Raft node")
	}
	node := &Node{Raft: raftNode, FSM: fsm, Transport: transport, store: store, id: options.ID, lan: lan}
	if options.Bootstrap || (options.BootstrapIfNew && !existing) {
		err := raftNode.BootstrapCluster(raft.Configuration{Servers: []raft.Server{{ID: raft.ServerID(options.ID), Address: transport.LocalAddr(), Suffrage: raft.Voter}}}).Error()
		if err != nil {
			_ = node.Close()
			return nil, errors.New("cannot bootstrap the new local workspace")
		}
	}
	if lan != nil {
		if err := lan.start(node, options.Bootstrap || options.BootstrapIfNew); err != nil {
			_ = node.Close()
			return nil, err
		}
	}
	return node, nil
}

func requireLoopback(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("addresses must use a numeric loopback IP and port")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("phase 1 permits numeric loopback addresses only")
	}
	return nil
}

func waitFuture(ctx context.Context, future raft.Future) error {
	done := make(chan error, 1)
	go func() { done <- future.Error() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Authority is freshly checked against Raft's voter quorum. State() == Leader
// alone is unsafe during the interval before a partitioned leader steps down.
func (node *Node) HasAuthority(ctx context.Context) bool {
	if node.Raft.State() != raft.Leader || !node.FSM.Healthy() {
		return false
	}
	if err := waitFuture(ctx, node.Raft.VerifyLeader()); err != nil {
		return false
	}
	if err := waitFuture(ctx, node.Raft.Barrier(500*time.Millisecond)); err != nil {
		return false
	}
	return node.Raft.State() == raft.Leader && node.FSM.Healthy()
}

func (node *Node) Snapshot(ctx context.Context) Snapshot {
	if node.lan != nil {
		return node.lan.snapshot(ctx)
	}
	return node.localSnapshot(ctx)
}

func (node *Node) localSnapshot(ctx context.Context) Snapshot {
	authority := node.HasAuthority(ctx)
	_, leaderID := node.Raft.LeaderWithID()
	members := []Member{}
	future := node.Raft.GetConfiguration()
	if err := waitFuture(ctx, future); err == nil {
		for _, server := range future.Configuration().Servers {
			members = append(members, Member{ID: string(server.ID), Address: string(server.Address), Voter: server.Suffrage == raft.Voter})
		}
	}
	sort.Slice(members, func(a, b int) bool { return members[a].ID < members[b].ID })
	return Snapshot{WorkspaceState: node.FSM.State(), NodeID: node.id, LeaderID: string(leaderID), HasAuthority: authority, CommitIndex: node.Raft.CommitIndex(), Members: members}
}

func (node *Node) Command(ctx context.Context, request CommandRequest) CommandResult {
	if node.lan != nil {
		return node.lan.command(ctx, request)
	}
	// Validate in both the boundary and the FSM: internal callers and replay
	// must have the same validation as HTTP/MCP users.
	encoded, err := json.Marshal(request)
	if err != nil {
		return failure("INVALID_COMMAND", "invalid command")
	}
	if _, err := DecodeRequest(encoded); err != nil {
		return failure("INVALID_COMMAND", "command validation failed")
	}
	if !node.HasAuthority(ctx) {
		return failure("NO_AUTHORITY", "new work waits until this node can verify an authoritative coordinator")
	}
	future := node.Raft.Apply(encoded, 500*time.Millisecond)
	if err := waitFuture(ctx, future); err != nil {
		return failure("OUTCOME_UNKNOWN", "commit was not confirmed; read current state and retry the same requestId")
	}
	result, ok := future.Response().(CommandResult)
	if !ok {
		return failure("INTERNAL_ERROR", "unexpected coordinator response")
	}
	return result
}

func (node *Node) Close() error {
	var closeErr error
	node.closed.Do(func() {
		if node.lan != nil {
			node.lan.close()
		}
		closeErr = node.Raft.Shutdown().Error()
		if err := node.Transport.Close(); closeErr == nil {
			closeErr = err
		}
		if err := node.store.Close(); closeErr == nil {
			closeErr = err
		}
	})
	return closeErr
}

type Ready struct {
	URL   string     `json:"url"`
	Token string     `json:"token"`
	LAN   *LANPublic `json:"lan,omitempty"`
}

type API struct {
	Ready    Ready
	server   *http.Server
	listener net.Listener
}

func StartAPI(node *Node, address string) (*API, error) {
	if address == "" {
		address = "127.0.0.1:0"
	}
	if err := requireLoopback(address); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, errors.New("cannot start the local API listener")
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		_ = listener.Close()
		return nil, errors.New("cannot create a local API credential")
	}
	ready := Ready{URL: "http://" + listener.Addr().String(), Token: base64.RawURLEncoding.EncodeToString(secret)}
	if node.lan != nil {
		public := node.lan.public
		ready.LAN = &public
	}
	api := &API{Ready: ready, listener: listener}
	api.server = &http.Server{Handler: newHandler(node, ready.Token), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	go func() { _ = api.server.Serve(listener) }()
	return api, nil
}

func (api *API) Close(ctx context.Context) error { return api.server.Shutdown(ctx) }

func newHandler(node *Node, token string) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if provided == request.Header.Get("Authorization") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			writeJSON(writer, http.StatusUnauthorized, failure("UNAUTHORIZED", "a valid local bearer credential is required"))
			return
		}
		// A browser-origin request is not an authenticated desktop IPC call.
		// There is no CORS or redirect behavior, including for OPTIONS.
		if request.Header.Get("Origin") != "" {
			writeJSON(writer, http.StatusForbidden, failure("ORIGIN_NOT_ALLOWED", "browser-origin requests are not supported"))
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		switch {
		case request.URL.Path == "/v1/task-receipt" && request.Method == http.MethodGet:
			query := request.URL.Query()
			taskID, rawRevision := query.Get("taskId"), query.Get("revision")
			revision, err := strconv.ParseUint(rawRevision, 10, 64)
			if len(request.URL.RawQuery) > 512 || len(query) != 2 || len(query["taskId"]) != 1 || len(query["revision"]) != 1 || err != nil || strconv.FormatUint(revision, 10) != rawRevision {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_RECEIPT_REQUEST", "an exact taskId and revision are required"))
				return
			}
			receipt, result := node.IssueTaskReceipt(ctx, taskID, revision)
			if receipt == nil {
				status := http.StatusConflict
				if result.Error.Code == "NO_AUTHORITY" || result.Error.Code == "REPLICA_CATCHING_UP" {
					status = http.StatusServiceUnavailable
				}
				if result.Error.Code == "INVALID_RECEIPT_REQUEST" {
					status = http.StatusBadRequest
				}
				if result.Error.Code == "DEVICE_NOT_AUTHORIZED" {
					status = http.StatusForbidden
				}
				writeJSON(writer, status, result)
				return
			}
			writeJSON(writer, http.StatusOK, receipt)
		case request.URL.Path == "/v1/lan/status" && request.Method == http.MethodGet && node.lan != nil:
			writeJSON(writer, http.StatusOK, node.lan.status(ctx))
		case request.URL.Path == "/v1/lan/peer-hints" && request.Method == http.MethodPut && node.lan != nil:
			body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 8192))
			var hints struct {
				PeerHints []PeerHint `json:"peerHints"`
			}
			if err != nil || decodeStrict(body, &hints) != nil || node.lan.updateHints(hints.PeerHints) != nil {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_HINTS", "invalid endpoint hints"))
				return
			}
			writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
		case request.URL.Path == "/v1/snapshot" && request.Method == http.MethodGet:
			writeJSON(writer, http.StatusOK, node.Snapshot(ctx))
		case request.URL.Path == "/v1/commands" && request.Method == http.MethodPost:
			body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBytes))
			if err != nil {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_COMMAND", "request is unreadable or too large"))
				return
			}
			command, err := DecodeRequest(body)
			if err != nil {
				writeJSON(writer, http.StatusBadRequest, failure("INVALID_COMMAND", "command validation failed"))
				return
			}
			result := node.Command(ctx, command)
			status := http.StatusOK
			if result.Error != nil && (result.Error.Code == "NO_AUTHORITY" || result.Error.Code == "OUTCOME_UNKNOWN") {
				status = http.StatusServiceUnavailable
			}
			writeJSON(writer, status, result)
		case request.URL.Path == "/v1/snapshot" || request.URL.Path == "/v1/commands":
			writeJSON(writer, http.StatusMethodNotAllowed, failure("METHOD_NOT_ALLOWED", "unsupported HTTP method"))
		default:
			writeJSON(writer, http.StatusNotFound, failure("NOT_FOUND", "unknown local API endpoint"))
		}
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
