package coordinator

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"

	"github.com/hashicorp/raft"
)

type joinRequest struct {
	WorkspaceID  string `json:"workspaceId"`
	RequestID    string `json:"requestId"`
	DeviceID     string `json:"deviceId"`
	CACertPEM    string `json:"caCertPEM"`
	CertPEM      string `json:"certPEM"`
	CSRPEM       string `json:"csrPEM"`
	ControlURL   string `json:"controlUrl"`
	RaftEndpoint string `json:"raftEndpoint"`
	Password     string `json:"password"`
}

type joinGrant struct {
	WorkspaceID string      `json:"workspaceId"`
	Members     []LANMember `json:"members"`
	PeerHints   []PeerHint  `json:"peerHints"`
}

func validateJoin(request joinRequest, workspaceID string) error {
	if request.WorkspaceID != workspaceID || !identifier.MatchString(request.RequestID) || len(request.Password) < 8 || len(request.Password) > 1024 || validateHint(PeerHint{DeviceID: request.DeviceID, ControlURL: request.ControlURL, RaftEndpoint: request.RaftEndpoint}) != nil {
		return errors.New("invalid enrollment request")
	}
	ca, err := parseCA(request.CACertPEM, workspaceID, request.DeviceID)
	if err != nil {
		return err
	}
	block, rest := pem.Decode([]byte(request.CertPEM))
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		return errors.New("invalid enrollment leaf")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil || leaf.IsCA || len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != logicalName(workspaceID, request.DeviceID) {
		return errors.New("invalid enrollment leaf identity")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth} {
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: logicalName(workspaceID, request.DeviceID), KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
			return errors.New("invalid enrollment certificate chain")
		}
	}
	block, rest = pem.Decode([]byte(request.CSRPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(rest) != 0 {
		return errors.New("a signed enrollment request is required")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil || csr.Subject.SerialNumber != request.RequestID || len(csr.DNSNames) != 1 || csr.DNSNames[0] != logicalName(workspaceID, request.DeviceID) || !bytes.Equal(csr.RawSubjectPublicKeyInfo, leaf.RawSubjectPublicKeyInfo) {
		return errors.New("enrollment possession proof does not match this request")
	}
	return nil
}

func (runtime *lanRuntime) handleJoin(ctx context.Context, writer http.ResponseWriter, request *http.Request) {
	select {
	case runtime.joinSlots <- struct{}{}:
		defer func() { <-runtime.joinSlots }()
	default:
		writeJSON(writer, http.StatusTooManyRequests, failure("JOIN_BUSY", "enrollment is busy; retry later"))
		return
	}
	runtime.mu.Lock()
	tooSoon := time.Since(runtime.lastJoin) < 200*time.Millisecond
	if !tooSoon {
		runtime.lastJoin = time.Now()
	}
	verifier := runtime.verifier
	joinAttempt := runtime.joinAttempt
	runtime.mu.Unlock()
	if joinAttempt == "pending" || joinAttempt == "failed" {
		writeJSON(writer, http.StatusServiceUnavailable, failure("ENROLLMENT_NOT_VERIFIED", "verify this Mac's enrollment before accepting other members"))
		return
	}
	if tooSoon {
		writeJSON(writer, http.StatusTooManyRequests, failure("JOIN_BUSY", "enrollment is rate limited"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 24576))
	var joining joinRequest
	if err != nil || decodeStrict(body, &joining) != nil || validateJoin(joining, runtime.config.WorkspaceID) != nil {
		writeJSON(writer, http.StatusBadRequest, failure("INVALID_JOIN", "invalid enrollment request"))
		return
	}
	if !verifier.matches(joining.Password) {
		writeJSON(writer, http.StatusUnauthorized, failure("INVALID_PASSWORD", "workspace password was not accepted"))
		return
	}
	if !runtime.active(runtime.id) {
		writeJSON(writer, http.StatusServiceUnavailable, failure("NOT_ACTIVE", "this Mac is not yet an active workspace member"))
		return
	}
	if !runtime.node.HasAuthority(ctx) {
		_, leader := runtime.node.Raft.LeaderWithID()
		var grant joinGrant
		if string(leader) == "" || string(leader) == runtime.id || runtime.peerCall(ctx, string(leader), http.MethodPost, "/lan/v1/join", joining, &grant, nil, "") != nil {
			writeJSON(writer, http.StatusServiceUnavailable, failure("NO_AUTHORITY", "enrollment waits for an authoritative coordinator"))
			return
		}
		if runtime.updateHints(grant.PeerHints) != nil {
			writeJSON(writer, http.StatusServiceUnavailable, failure("STORAGE_FAILURE", "peer endpoints could not be saved"))
			return
		}
		writeJSON(writer, http.StatusOK, grant)
		return
	}
	runtime.membership.Lock()
	defer runtime.membership.Unlock()
	if !runtime.node.HasAuthority(ctx) {
		writeJSON(writer, http.StatusServiceUnavailable, failure("NO_AUTHORITY", "leader authority was lost"))
		return
	}
	member := LANMember{DeviceID: joining.DeviceID, CACertPEM: joining.CACertPEM, Stage: "pending", JoinRequestID: joining.RequestID}
	_, result := runtime.node.applyLAN(time.Second, lanOperation{Type: "enroll", WorkspaceID: runtime.config.WorkspaceID, Member: &member})
	if !result.OK {
		writeJSON(writer, http.StatusConflict, result)
		return
	}
	if err := runtime.updateHints([]PeerHint{{DeviceID: joining.DeviceID, ControlURL: joining.ControlURL, RaftEndpoint: joining.RaftEndpoint}}); err != nil {
		writeJSON(writer, http.StatusServiceUnavailable, failure("STORAGE_FAILURE", "enrollment endpoints could not be saved"))
		return
	}
	state, _ := runtime.node.FSM.LANState()
	grant := joinGrant{WorkspaceID: runtime.config.WorkspaceID, Members: []LANMember{}, PeerHints: []PeerHint{}}
	for _, member := range state.Members {
		grant.Members = append(grant.Members, member)
	}
	runtime.mu.RLock()
	for _, hint := range runtime.hints {
		grant.PeerHints = append(grant.PeerHints, hint)
	}
	runtime.mu.RUnlock()
	// Return the public trust grant before replication starts. The new Mac's
	// listeners already run; waiting for catchup here would create a trust/start
	// deadlock and would misreport a password check as completed enrollment.
	writeJSON(writer, http.StatusOK, grant)
}

func (runtime *lanRuntime) attemptJoin(ctx context.Context) {
	runtime.mu.Lock()
	tooSoon := time.Since(runtime.lastJoin) < time.Second
	if !tooSoon {
		runtime.lastJoin = time.Now()
	}
	runtime.mu.Unlock()
	if tooSoon {
		return
	}
	invitation := runtime.config.Join
	if invitation == nil {
		return
	}
	// Password-bearing enrollment is one attempt per explicit user action.
	// Catchup and leader failover continue from public trust without a password.
	defer func() { invitation.Password = ""; runtime.config.Join = nil }()
	signer, ok := runtime.pair.PrivateKey.(crypto.Signer)
	if !ok {
		return
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{SerialNumber: invitation.RequestID}, DNSNames: []string{logicalName(runtime.config.WorkspaceID, runtime.id)}}, signer)
	if err != nil {
		return
	}
	joining := joinRequest{WorkspaceID: runtime.config.WorkspaceID, RequestID: invitation.RequestID, DeviceID: runtime.id, CACertPEM: runtime.config.Identity.CACertPEM, CertPEM: runtime.config.Identity.CertPEM, CSRPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})), ControlURL: runtime.public.ControlURL, RaftEndpoint: runtime.public.RaftEndpoint, Password: invitation.Password}
	pinned := LANMember{DeviceID: invitation.DeviceID, CACertPEM: invitation.TrustedCACertPEM, Stage: "active"}
	var grant joinGrant
	call, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = runtime.peerCall(call, invitation.DeviceID, http.MethodPost, "/lan/v1/join", joining, &grant, &pinned, invitation.ControlURL)
	cancel()
	if err == nil {
		err = runtime.installGrant(grant, joining)
	}
	runtime.mu.Lock()
	if err != nil {
		runtime.joinError = &APIError{Code: "JOIN_PENDING", Message: "enrollment was not confirmed; verify the invitation, password, and coordinator availability"}
		runtime.joinAttempt = "failed"
	} else {
		runtime.joinError = nil
		runtime.joinAttempt = "verified"
	}
	runtime.mu.Unlock()
}

func (runtime *lanRuntime) installGrant(grant joinGrant, request joinRequest) error {
	if grant.WorkspaceID != runtime.config.WorkspaceID || len(grant.Members) > 10 || len(grant.PeerHints) > 10 {
		return errors.New("invalid enrollment trust grant")
	}
	trusted := map[string]LANMember{}
	for _, member := range grant.Members {
		if _, exists := trusted[member.DeviceID]; exists {
			return errors.New("duplicate grant identity")
		}
		if _, err := parseCA(member.CACertPEM, grant.WorkspaceID, member.DeviceID); err != nil {
			return err
		}
		if member.Stage != "pending" && member.Stage != "nonvoter" && member.Stage != "active" {
			return errors.New("invalid grant stage")
		}
		trusted[member.DeviceID] = member
	}
	self, exists := trusted[runtime.id]
	if !exists || self.CACertPEM != request.CACertPEM || self.JoinRequestID != request.RequestID {
		return errors.New("grant does not bind the requested identity")
	}
	invitation := runtime.config.Join
	if invitation == nil || trusted[invitation.DeviceID].CACertPEM != invitation.TrustedCACertPEM {
		return errors.New("grant changed the pinned inviter identity")
	}
	for _, hint := range grant.PeerHints {
		if validateHint(hint) != nil {
			return errors.New("invalid enrollment endpoint grant")
		}
	}
	verifier, err := NewPasswordVerifier(request.Password)
	if err != nil {
		return err
	}
	runtime.mu.Lock()
	runtime.bootstrap = trusted
	runtime.verifier = verifier
	runtime.mu.Unlock()
	if err := runtime.updateHints(grant.PeerHints); err != nil {
		return err
	}
	return runtime.persistPublic()
}

func (runtime *lanRuntime) advanceEnrollment(ctx context.Context) {
	runtime.membership.Lock()
	defer runtime.membership.Unlock()
	state, _ := runtime.node.FSM.LANState()
	if state == nil {
		return
	}
	ids := []string{}
	for id, member := range state.Members {
		if member.Stage != "active" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		check, cancel := context.WithTimeout(ctx, time.Second)
		authority := runtime.node.HasAuthority(check)
		cancel()
		if !authority {
			return
		}
		// Endpoint hints grant no authority. Share them over member TLS before
		// promotion so another eligible voter can find the added Mac after a
		// leader loss. Discovery/local hints may later replace physical IPs.
		hints := []PeerHint{}
		runtime.mu.RLock()
		for _, hint := range runtime.hints {
			hints = append(hints, hint)
		}
		runtime.mu.RUnlock()
		for peerID := range state.Members {
			if peerID == runtime.id {
				continue
			}
			probe, stop := context.WithTimeout(ctx, 400*time.Millisecond)
			var ack struct {
				OK bool `json:"ok"`
			}
			_ = runtime.peerCall(probe, peerID, http.MethodPost, "/lan/v1/peer-hints", struct {
				PeerHints []PeerHint `json:"peerHints"`
			}{hints}, &ack, nil, "")
			stop()
		}
		configuration := runtime.node.Raft.GetConfiguration()
		if configuration.Error() != nil {
			return
		}
		var found *raft.Server
		for _, server := range configuration.Configuration().Servers {
			if string(server.ID) == id {
				value := server
				found = &value
			}
		}
		if found == nil {
			change, stop := context.WithTimeout(ctx, time.Second)
			err := waitFuture(change, runtime.node.Raft.AddNonvoter(raft.ServerID(id), raft.ServerAddress(id), configuration.Index(), time.Second))
			stop()
			if err != nil {
				return
			}
		}
		if state.Members[id].Stage == "pending" {
			_, result := runtime.node.applyLAN(time.Second, lanOperation{Type: "nonvoter", WorkspaceID: state.WorkspaceID, DeviceID: id})
			if !result.OK {
				return
			}
		}
		target, result := runtime.node.applyLAN(time.Second, lanOperation{Type: "sync", WorkspaceID: state.WorkspaceID})
		if !result.OK {
			return
		}
		var sync struct {
			DeviceID     string `json:"deviceId"`
			AppliedIndex uint64 `json:"appliedIndex"`
			WorkspaceID  string `json:"workspaceId"`
		}
		probe, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		caughtUp := false
		for probe.Err() == nil {
			err := runtime.peerCall(probe, id, http.MethodGet, "/lan/v1/sync", nil, &sync, nil, "")
			if err == nil && sync.DeviceID == id && sync.WorkspaceID == state.WorkspaceID && sync.AppliedIndex >= target {
				caughtUp = true
				break
			}
			select {
			case <-probe.Done():
			case <-time.After(25 * time.Millisecond):
			}
		}
		cancel()
		if !caughtUp {
			continue
		}
		if runtime.pauseAt.Load() == "before-promotion" {
			return
		}
		check, cancel = context.WithTimeout(ctx, time.Second)
		authority = runtime.node.HasAuthority(check)
		cancel()
		if !authority {
			return
		}
		configuration = runtime.node.Raft.GetConfiguration()
		if configuration.Error() != nil {
			return
		}
		change, stop := context.WithTimeout(ctx, time.Second)
		err := waitFuture(change, runtime.node.Raft.AddVoter(raft.ServerID(id), raft.ServerAddress(id), configuration.Index(), time.Second))
		stop()
		if err != nil {
			return
		}
		if runtime.pauseAt.Load() == "after-promotion" {
			return
		}
		// If promotion commits but this final stage does not, the next leader
		// repeats the sync proof and idempotent promotion before activation.
		_, result = runtime.node.applyLAN(time.Second, lanOperation{Type: "activate", WorkspaceID: state.WorkspaceID, DeviceID: id})
		if !result.OK {
			return
		}
		return // One serialized transition per pass; never remove on heartbeat.
	}
}
