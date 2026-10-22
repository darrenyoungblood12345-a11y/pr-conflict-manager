package coordinator

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hashicorp/raft"
)

type LANPublic struct {
	WorkspaceID  string `json:"workspaceId"`
	DeviceID     string `json:"deviceId"`
	ControlURL   string `json:"controlUrl"`
	RaftEndpoint string `json:"raftEndpoint"`
	CACertPEM    string `json:"caCertPEM"`
	Fingerprint  string `json:"fingerprint"`
}

type LANStatus struct {
	WorkspaceID  string      `json:"workspaceId"`
	DeviceID     string      `json:"deviceId"`
	Stage        string      `json:"stage"`
	HasAuthority bool        `json:"hasAuthority"`
	LeaderID     string      `json:"leaderId"`
	Members      []LANMember `json:"members"`
	Public       LANPublic   `json:"public"`
	JoinError    *APIError   `json:"joinError,omitempty"`
	JoinAttempt  string      `json:"joinAttempt"`
}

type lanRuntime struct {
	node        *Node
	fsm         *FSM
	config      LANConfig
	id          string
	pair        tls.Certificate
	public      LANPublic
	mu          sync.RWMutex
	hints       map[string]PeerHint
	bootstrap   map[string]LANMember
	joinError   *APIError
	joinAttempt string
	verifier    PasswordVerifier
	listener    net.Listener
	server      *http.Server
	cancel      context.CancelFunc
	workers     sync.WaitGroup
	membership  sync.Mutex
	joinSlots   chan struct{}
	lastJoin    time.Time
	pauseAt     atomic.Value
	creator     bool
}

func (runtime *lanRuntime) roster() map[string]LANMember {
	if runtime.fsm != nil {
		state, _ := runtime.fsm.LANState()
		if state != nil {
			if _, ok := state.Members[runtime.id]; ok {
				return state.Members
			}
		}
	}
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	copy := make(map[string]LANMember, len(runtime.bootstrap))
	for id, member := range runtime.bootstrap {
		copy[id] = member
	}
	return copy
}

func (runtime *lanRuntime) authenticated(state tls.ConnectionState) (string, error) {
	if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		return "", errors.New("mutual TLS is required")
	}
	leaf := state.PeerCertificates[0]
	for id, member := range runtime.roster() {
		if member.Stage == "removed" {
			continue
		}
		ca, err := parseCA(member.CACertPEM, runtime.config.WorkspaceID, id)
		if err != nil {
			continue
		}
		for _, chain := range state.VerifiedChains {
			if len(chain) == 2 && chain[1].Equal(ca) && !leaf.IsCA && len(leaf.DNSNames) == 1 && leaf.DNSNames[0] == logicalName(runtime.config.WorkspaceID, id) && leaf.VerifyHostname(logicalName(runtime.config.WorkspaceID, id)) == nil {
				return id, nil
			}
		}
	}
	return "", errors.New("certificate is not bound to an enrolled workspace device")
}

func (runtime *lanRuntime) serverTLS(required bool, protocol string) *tls.Config {
	base := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{runtime.pair}, NextProtos: []string{protocol}, SessionTicketsDisabled: true}
	base.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
		config := base.Clone()
		config.GetConfigForClient = nil
		config.ClientCAs = x509.NewCertPool()
		for id, member := range runtime.roster() {
			if ca, err := parseCA(member.CACertPEM, runtime.config.WorkspaceID, id); err == nil {
				config.ClientCAs.AddCert(ca)
			}
		}
		config.ClientAuth = tls.VerifyClientCertIfGiven
		if required {
			config.ClientAuth = tls.RequireAndVerifyClientCert
		}
		config.VerifyConnection = func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 && !required {
				return nil
			}
			_, err := runtime.authenticated(state)
			return err
		}
		return config, nil
	}
	return base
}

func (runtime *lanRuntime) clientTLS(deviceID string, pinned *LANMember, protocol string, withIdentity bool) (*tls.Config, error) {
	member, ok := runtime.roster()[deviceID]
	if pinned != nil {
		member, ok = *pinned, true
	}
	if !ok || member.Stage == "removed" {
		return nil, errors.New("peer has no trusted device authority")
	}
	ca, err := parseCA(member.CACertPEM, runtime.config.WorkspaceID, deviceID)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	config := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: logicalName(runtime.config.WorkspaceID, deviceID), NextProtos: []string{protocol}}
	if withIdentity {
		config.Certificates = []tls.Certificate{runtime.pair}
	}
	config.VerifyConnection = func(state tls.ConnectionState) error {
		if len(state.VerifiedChains) == 0 || len(state.VerifiedChains[0]) != 2 || !state.VerifiedChains[0][1].Equal(ca) || len(state.PeerCertificates[0].DNSNames) != 1 || state.PeerCertificates[0].DNSNames[0] != config.ServerName {
			return errors.New("peer certificate does not match the selected invitation or roster identity")
		}
		if pinned == nil {
			current, exists := runtime.roster()[deviceID]
			if !exists || current.CACertPEM != member.CACertPEM || current.Stage == "removed" {
				return errors.New("peer trust changed")
			}
		}
		return nil
	}
	return config, nil
}

func (runtime *lanRuntime) hint(id string) (PeerHint, bool) {
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	hint, ok := runtime.hints[id]
	return hint, ok
}

type logicalAddress string

func (address logicalAddress) Network() string { return "apm-raft-tls" }
func (address logicalAddress) String() string  { return string(address) }

type tlsStream struct {
	listener net.Listener
	runtime  *lanRuntime
}

func (stream *tlsStream) Addr() net.Addr { return logicalAddress(stream.runtime.id) }
func (stream *tlsStream) Close() error   { return stream.listener.Close() }
func (stream *tlsStream) Accept() (net.Conn, error) {
	for {
		connection, err := stream.listener.Accept()
		if err != nil {
			return nil, err
		}
		secure := tls.Server(connection, stream.runtime.serverTLS(true, "apm-raft-v1"))
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err = secure.HandshakeContext(ctx)
		cancel()
		if err == nil {
			return secure, nil
		}
		_ = connection.Close()
	}
}
func (stream *tlsStream) Dial(address raft.ServerAddress, timeout time.Duration) (net.Conn, error) {
	id := string(address)
	hint, ok := stream.runtime.hint(id)
	if !ok {
		return nil, errors.New("no public endpoint hint for peer")
	}
	config, err := stream.runtime.clientTLS(id, nil, "apm-raft-v1", true)
	if err != nil {
		return nil, err
	}
	return tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", hint.RaftEndpoint, config)
}

var _ raft.StreamLayer = (*tlsStream)(nil)
