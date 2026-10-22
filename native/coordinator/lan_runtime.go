package coordinator

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
)

var lanBindingKey = []byte("agent-pr-monitor/lan-binding-v1")
var lanOriginKey = []byte("agent-pr-monitor/lan-origin-v1")
var lanPublicCacheKey = []byte("agent-pr-monitor/lan-public-cache-v1")

type lanPublicCache struct {
	Members map[string]LANMember `json:"members"`
	Hints   []PeerHint           `json:"hints"`
}

func newLANRuntime(id string, config LANConfig, store *raftboltdb.BoltStore, existing, mayBootstrap bool, fsm *FSM) (*lanRuntime, *raft.NetworkTransport, error) {
	if config.Version != 1 || !lanIdentifier.MatchString(id) || !lanIdentifier.MatchString(config.WorkspaceID) || config.ControlPort < 0 || config.ControlPort > 65535 || config.RaftPort < 0 || config.RaftPort > 65535 || len(config.PeerHints) > 10 {
		return nil, nil, errors.New("invalid LAN configuration")
	}
	ip := net.ParseIP(config.ListenHost)
	if ip == nil || !(ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback()) {
		return nil, nil, errors.New("LAN listenHost must be a numeric unicast LAN address")
	}
	pair, ca, err := validateIdentity(config.Identity, config.WorkspaceID, id)
	if err != nil {
		return nil, nil, err
	}
	if config.Join == nil && !config.PasswordVerifier.valid() {
		return nil, nil, errors.New("a valid password verifier is required")
	}
	if config.Join != nil {
		invitation := config.Join
		if invitation.DeviceID == id || !identifier.MatchString(invitation.RequestID) || len(invitation.Password) < 8 || len(invitation.Password) > 1024 || validateHint(PeerHint{DeviceID: invitation.DeviceID, ControlURL: invitation.ControlURL, RaftEndpoint: net.JoinHostPort(config.ListenHost, "1")}) != nil {
			return nil, nil, errors.New("invalid pinned join invitation")
		}
		if _, err := parseCA(invitation.TrustedCACertPEM, config.WorkspaceID, invitation.DeviceID); err != nil {
			return nil, nil, errors.New("invalid pinned invitation authority")
		}
	}
	binding := config.WorkspaceID + ":" + id + ":" + caFingerprint(ca)
	origin, _ := store.Get(lanOriginKey)
	if mayBootstrap && string(origin) == "join" {
		return nil, nil, errors.New("a saved joining workspace must never bootstrap a new cluster")
	}
	if !existing && !mayBootstrap && config.Join == nil && string(origin) != "join" {
		return nil, nil, errors.New("cannot reopen a LAN workspace without saved Raft state; restore its durable data instead of creating a separate cluster")
	}
	if saved, err := store.Get(lanBindingKey); err == nil && len(saved) > 0 {
		if string(saved) != binding {
			return nil, nil, errors.New("saved LAN identity does not match the supplied profile")
		}
	} else if existing {
		return nil, nil, errors.New("LAN mode requires a new data directory; legacy identity migration is not supported")
	}
	for _, hint := range config.PeerHints {
		if err := validateHint(hint); err != nil {
			return nil, nil, err
		}
	}
	if err := store.Set(lanBindingKey, []byte(binding)); err != nil {
		return nil, nil, errors.New("cannot bind durable storage to LAN identity")
	}
	if origin, _ := store.Get(lanOriginKey); len(origin) == 0 {
		value := "join"
		if mayBootstrap {
			value = "seed"
		}
		if err := store.Set(lanOriginKey, []byte(value)); err != nil {
			return nil, nil, errors.New("cannot save workspace startup origin")
		}
	}
	if config.Join != nil {
		invitation := *config.Join
		config.Join = &invitation
	}
	runtime := &lanRuntime{config: config, id: id, fsm: fsm, pair: pair, verifier: config.PasswordVerifier, hints: map[string]PeerHint{}, bootstrap: map[string]LANMember{id: {DeviceID: id, CACertPEM: config.Identity.CACertPEM, Stage: "pending", JoinRequestID: "bootstrap-" + id}}, joinSlots: make(chan struct{}, 1), joinAttempt: "none"}
	runtime.creator = mayBootstrap || string(origin) == "seed"
	if config.Join != nil {
		runtime.joinAttempt = "pending"
	}
	runtime.config.Identity.CAKeyPEM = ""
	runtime.config.Identity.KeyPEM = ""
	if cached, err := store.Get(lanPublicCacheKey); err == nil && len(cached) > 0 {
		var cache lanPublicCache
		if decodeStrict(cached, &cache) != nil || len(cache.Members) > 10 || len(cache.Hints) > 10 {
			return nil, nil, errors.New("invalid cached public LAN trust")
		}
		for device, member := range cache.Members {
			if device != member.DeviceID {
				return nil, nil, errors.New("invalid cached peer identity")
			}
			if _, err := parseCA(member.CACertPEM, config.WorkspaceID, device); err != nil {
				return nil, nil, errors.New("invalid cached peer authority")
			}
			runtime.bootstrap[device] = member
		}
		for _, hint := range cache.Hints {
			if validateHint(hint) != nil {
				return nil, nil, errors.New("invalid cached public endpoint")
			}
			runtime.hints[hint.DeviceID] = hint
		}
	}
	if config.Join != nil {
		runtime.bootstrap[config.Join.DeviceID] = LANMember{DeviceID: config.Join.DeviceID, CACertPEM: config.Join.TrustedCACertPEM, Stage: "active"}
	}
	for _, hint := range config.PeerHints {
		runtime.hints[hint.DeviceID] = hint
	}
	control, err := net.Listen("tcp", net.JoinHostPort(config.ListenHost, strconv.Itoa(config.ControlPort)))
	if err != nil {
		return nil, nil, errors.New("cannot listen on LAN control address")
	}
	raftListener, err := net.Listen("tcp", net.JoinHostPort(config.ListenHost, strconv.Itoa(config.RaftPort)))
	if err != nil {
		_ = control.Close()
		return nil, nil, errors.New("cannot listen on LAN Raft address")
	}
	runtime.listener = control
	runtime.public = LANPublic{WorkspaceID: config.WorkspaceID, DeviceID: id, ControlURL: "https://" + control.Addr().String(), RaftEndpoint: raftListener.Addr().String(), CACertPEM: config.Identity.CACertPEM, Fingerprint: caFingerprint(ca)}
	runtime.hints[id] = PeerHint{DeviceID: id, ControlURL: runtime.public.ControlURL, RaftEndpoint: runtime.public.RaftEndpoint}
	transport := raft.NewNetworkTransport(&tlsStream{listener: raftListener, runtime: runtime}, 3, time.Second, io.Discard)
	return runtime, transport, nil
}

func (runtime *lanRuntime) persistPublic() error {
	runtime.mu.RLock()
	cache := lanPublicCache{Members: map[string]LANMember{}, Hints: []PeerHint{}}
	for id, member := range runtime.bootstrap {
		cache.Members[id] = member
	}
	for _, hint := range runtime.hints {
		cache.Hints = append(cache.Hints, hint)
	}
	runtime.mu.RUnlock()
	encoded, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	return runtime.node.store.Set(lanPublicCacheKey, encoded)
}

func (runtime *lanRuntime) start(node *Node, bootstrap bool) error {
	runtime.node = node
	if err := runtime.persistPublic(); err != nil {
		return errors.New("cannot save public LAN endpoints")
	}
	runtime.server = &http.Server{Handler: runtime.handler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 8 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, ErrorLog: nil}
	ctx, cancel := context.WithCancel(context.Background())
	runtime.cancel = cancel
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		_ = runtime.server.Serve(tls.NewListener(runtime.listener, runtime.serverTLS(false, "http/1.1")))
	}()
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if (bootstrap || runtime.creator) && runtime.pauseAt.Load() != "before-initialize" {
				state, _ := node.FSM.LANState()
				check, stop := context.WithTimeout(ctx, time.Second)
				if state == nil && node.HasAuthority(check) {
					member := LANMember{DeviceID: runtime.id, CACertPEM: runtime.config.Identity.CACertPEM, Stage: "active", JoinRequestID: "bootstrap-" + runtime.id}
					_, _ = node.applyLAN(time.Second, lanOperation{Type: "initialize", WorkspaceID: runtime.config.WorkspaceID, Member: &member})
				}
				stop()
			}
			if runtime.config.Join != nil {
				runtime.attemptJoin(ctx)
			}
			check, stop := context.WithTimeout(ctx, time.Second)
			if node.HasAuthority(check) {
				runtime.advanceEnrollment(ctx)
			}
			stop()
		}
	}()
	return nil
}

func (runtime *lanRuntime) close() {
	if runtime.cancel != nil {
		runtime.cancel()
	}
	if runtime.server != nil {
		_ = runtime.server.Close()
	} else if runtime.listener != nil {
		_ = runtime.listener.Close()
	}
	runtime.workers.Wait()
}

func (runtime *lanRuntime) updateHints(hints []PeerHint) error {
	if len(hints) > 10 {
		return errors.New("too many endpoint hints")
	}
	for _, hint := range hints {
		if err := validateHint(hint); err != nil {
			return err
		}
	}
	runtime.mu.Lock()
	next := make(map[string]PeerHint, len(runtime.hints))
	for id, hint := range runtime.hints {
		next[id] = hint
	}
	for _, hint := range hints {
		if hint.DeviceID != runtime.id {
			next[hint.DeviceID] = hint
		}
	}
	if len(next) > 10 {
		runtime.mu.Unlock()
		return errors.New("too many endpoint hints")
	}
	runtime.hints = next
	runtime.mu.Unlock()
	return runtime.persistPublic()
}

func (runtime *lanRuntime) status(ctx context.Context) LANStatus {
	state, _ := runtime.node.FSM.LANState()
	_, leader := runtime.node.Raft.LeaderWithID()
	status := LANStatus{WorkspaceID: runtime.config.WorkspaceID, DeviceID: runtime.id, Stage: "starting", LeaderID: string(leader), Members: []LANMember{}, Public: runtime.public}
	if state != nil {
		for _, member := range state.Members {
			status.Members = append(status.Members, member)
		}
		if self, exists := state.Members[runtime.id]; exists {
			status.Stage = self.Stage
		}
	}
	if status.Stage == "active" {
		status.HasAuthority = runtime.node.Snapshot(ctx).HasAuthority
	}
	sort.Slice(status.Members, func(a, b int) bool { return status.Members[a].DeviceID < status.Members[b].DeviceID })
	runtime.mu.RLock()
	if runtime.joinError != nil {
		value := *runtime.joinError
		status.JoinError = &value
	}
	status.JoinAttempt = runtime.joinAttempt
	runtime.mu.RUnlock()
	return status
}
