package coordinator

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const maxRequestBytes = 256 * 1024
const maxSafeInteger = 9007199254740991

type Scope struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Symbol string `json:"symbol,omitempty"`
}

type TaskProposal struct {
	ID           string  `json:"id"`
	OwnerID      string  `json:"ownerId"`
	SessionID    string  `json:"sessionId"`
	Agent        string  `json:"agent"`
	Branch       string  `json:"branch"`
	BaseCommit   string  `json:"baseCommit"`
	Description  string  `json:"description"`
	PlanRevision uint64  `json:"planRevision"`
	Scopes       []Scope `json:"scopes"`
}

type Task struct {
	TaskProposal
	Revision         uint64       `json:"revision"`
	Status           string       `json:"status"`
	StopAcknowledged bool         `json:"stopAcknowledged"`
	PRMerged         bool         `json:"prMerged"`
	Conflicts        []string     `json:"conflicts"`
	PullRequest      *PullRequest `json:"pullRequest,omitempty"`
}

type PullRequest struct {
	Number uint64 `json:"number"`
}

type Plan struct {
	Revision uint64 `json:"revision"`
	Markdown string `json:"markdown"`
}

type ActivityEvent struct {
	Index   uint64 `json:"index"`
	Type    string `json:"type"`
	TaskID  string `json:"taskId,omitempty"`
	Message string `json:"message"`
}

type WorkspaceState struct {
	Repository *Repository      `json:"repository,omitempty"`
	Plan       Plan             `json:"plan"`
	Tasks      map[string]*Task `json:"tasks"`
	Events     []ActivityEvent  `json:"events"`
}

type Repository struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

type Member struct {
	ID      string `json:"id"`
	Address string `json:"address"`
	Voter   bool   `json:"voter"`
}

type Snapshot struct {
	WorkspaceState
	NodeID          string   `json:"nodeId"`
	LeaderID        string   `json:"leaderId"`
	HasAuthority    bool     `json:"hasAuthority"`
	CommitIndex     uint64   `json:"commitIndex"`
	Members         []Member `json:"members"`
	AuthoritySource string   `json:"authoritySource,omitempty"`
}

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type CommandResult struct {
	OK     bool            `json:"ok"`
	Error  *APIError       `json:"error,omitempty"`
	TaskID string          `json:"taskId,omitempty"`
	State  *WorkspaceState `json:"state,omitempty"`
}

type Command struct {
	Type             string        `json:"type"`
	ExpectedRevision *uint64       `json:"expectedRevision,omitempty"`
	Markdown         string        `json:"markdown,omitempty"`
	Task             *TaskProposal `json:"task,omitempty"`
	TaskID           string        `json:"taskId,omitempty"`
	OwnerID          string        `json:"ownerId,omitempty"`
	Repository       *Repository   `json:"repository,omitempty"`
	Number           *uint64       `json:"number,omitempty"`
}

type CommandRequest struct {
	RequestID string  `json:"requestId"`
	Command   Command `json:"command"`
}

// Preserve required zero values (notably an empty initial plan) while encoding
// exactly one discriminated-union variant for the TypeScript JSON contract.
func (command Command) MarshalJSON() ([]byte, error) {
	fields := map[string]any{"type": command.Type}
	switch command.Type {
	case "bind_repository":
		fields["repository"] = command.Repository
	case "set_plan":
		fields["expectedRevision"], fields["markdown"] = command.ExpectedRevision, command.Markdown
	case "register_task":
		fields["task"] = command.Task
	case "acknowledge_stop", "cancel_task", "report_completion", "revise_task":
		fields["taskId"], fields["ownerId"], fields["expectedRevision"] = command.TaskID, command.OwnerID, command.ExpectedRevision
		if command.Type == "revise_task" {
			fields["task"] = command.Task
		}
	case "link_pull_request":
		fields["taskId"], fields["ownerId"], fields["expectedRevision"], fields["number"] = command.TaskID, command.OwnerID, command.ExpectedRevision, command.Number
	case "mark_pr_merged":
		fields["taskId"], fields["expectedRevision"] = command.TaskID, command.ExpectedRevision
	}
	return json.Marshal(fields)
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
var commitHash = regexp.MustCompile(`^[a-fA-F0-9]{7,64}$`)

func initialState() WorkspaceState {
	return WorkspaceState{Plan: Plan{}, Tasks: map[string]*Task{}, Events: []ActivityEvent{}}
}

func failure(code, message string) CommandResult {
	return CommandResult{Error: &APIError{Code: code, Message: message}}
}

// DecodeRequest rejects unknown and cross-variant command fields. In particular,
// a frontend cannot supply a status, revision, or stop acknowledgement in a task.
func DecodeRequest(data []byte) (CommandRequest, error) {
	var request CommandRequest
	if len(data) > maxRequestBytes || !utf8.Valid(data) {
		return request, errors.New("request exceeds the size limit")
	}
	if err := decodeStrict(data, &request); err != nil {
		return request, errors.New("request does not match the command schema")
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil || len(envelope) != 2 || envelope["command"] == nil || envelope["requestId"] == nil {
		return request, errors.New("requestId and command are required")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(envelope["command"], &fields); err != nil {
		return request, errors.New("command must be an object")
	}
	required := []string{"type"}
	switch request.Command.Type {
	case "bind_repository":
		required = append(required, "repository")
	case "set_plan":
		required = append(required, "expectedRevision", "markdown")
	case "register_task":
		required = append(required, "task")
	case "acknowledge_stop", "cancel_task", "report_completion":
		required = append(required, "taskId", "ownerId", "expectedRevision")
	case "revise_task":
		required = append(required, "taskId", "ownerId", "expectedRevision", "task")
	case "link_pull_request":
		required = append(required, "taskId", "ownerId", "expectedRevision", "number")
	case "mark_pr_merged":
		required = append(required, "taskId", "expectedRevision")
	default:
		return request, errors.New("unsupported command type")
	}
	if len(fields) != len(required) {
		return request, errors.New("command fields do not match its type")
	}
	for _, name := range required {
		if value, exists := fields[name]; !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return request, fmt.Errorf("%s is required", name)
		}
	}
	if !identifier.MatchString(request.RequestID) {
		return request, errors.New("requestId must be a bounded identifier")
	}
	if request.Command.ExpectedRevision != nil && *request.Command.ExpectedRevision > maxSafeInteger {
		return request, errors.New("expectedRevision exceeds the JSON integer range")
	}
	if request.Command.Type == "link_pull_request" && (request.Command.Number == nil || *request.Command.Number == 0 || *request.Command.Number > maxSafeInteger) {
		return request, errors.New("pull request number must be a positive safe integer")
	}
	if request.Command.Type == "bind_repository" {
		if request.Command.Repository == nil {
			return request, errors.New("repository identity is required")
		}
		repository, err := normalizeRepository(*request.Command.Repository)
		if err != nil {
			return request, err
		}
		request.Command.Repository = &repository
	} else if request.Command.Type == "set_plan" {
		if !utf8.ValidString(request.Command.Markdown) || len(request.Command.Markdown) > 64*1024 {
			return request, errors.New("plan must be valid UTF-8 and at most 64 KiB")
		}
	} else if request.Command.Type != "register_task" {
		if !identifier.MatchString(request.Command.TaskID) {
			return request, errors.New("taskId must be a bounded identifier")
		}
		if request.Command.Type != "mark_pr_merged" && !identifier.MatchString(request.Command.OwnerID) {
			return request, errors.New("ownerId must be a bounded identifier")
		}
	}
	if request.Command.Task != nil {
		var taskFields map[string]json.RawMessage
		if err := json.Unmarshal(fields["task"], &taskFields); err != nil || len(taskFields) != 9 {
			return request, errors.New("task proposal fields are required")
		}
		for _, name := range []string{"id", "ownerId", "sessionId", "agent", "branch", "baseCommit", "description", "planRevision", "scopes"} {
			if value, exists := taskFields[name]; !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return request, errors.New("task proposal fields cannot be missing or null")
			}
		}
		task, err := normalizeProposal(*request.Command.Task)
		if err != nil {
			return request, err
		}
		request.Command.Task = &task
	}
	return request, nil
}

var repositoryOwner = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$`)
var repositoryName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,100}$`)

func normalizeRepository(repository Repository) (Repository, error) {
	if !repositoryOwner.MatchString(repository.Owner) || !repositoryName.MatchString(repository.Repo) || repository.Repo == "." || repository.Repo == ".." {
		return Repository{}, errors.New("invalid GitHub repository identity")
	}
	return Repository{Owner: strings.ToLower(repository.Owner), Repo: strings.ToLower(repository.Repo)}, nil
}

func decodeStrict(data []byte, output any) error {
	if err := uniqueJSONFields(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func uniqueJSONFields(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 32 {
			return errors.New("JSON nesting exceeds the limit")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, isDelimiter := token.(json.Delim)
		if !isDelimiter {
			return nil
		}
		switch delimiter {
		case '{':
			fields := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || fields[name] {
					return errors.New("duplicate JSON object fields are not allowed")
				}
				fields[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		_, err = decoder.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func normalizeProposal(proposal TaskProposal) (TaskProposal, error) {
	if !identifier.MatchString(proposal.ID) || !identifier.MatchString(proposal.OwnerID) || !identifier.MatchString(proposal.SessionID) {
		return proposal, errors.New("task, owner, and session identifiers are required")
	}
	switch proposal.Agent {
	case "codex", "cursor", "opencode", "claude-code":
	default:
		return proposal, errors.New("unsupported agent")
	}
	if !boundedText(proposal.Description, 8000) || !boundedText(proposal.Branch, 256) || !commitHash.MatchString(proposal.BaseCommit) {
		return proposal, errors.New("description, branch, and a hexadecimal base commit are required")
	}
	if proposal.PlanRevision > maxSafeInteger || len(proposal.Scopes) == 0 || len(proposal.Scopes) > 256 {
		return proposal, errors.New("a valid plan revision and 1–256 scopes are required")
	}
	normalized := make([]Scope, 0, len(proposal.Scopes))
	seen := map[Scope]bool{}
	for _, scope := range proposal.Scopes {
		safePath, err := normalizeRepoPath(scope.Path)
		if err != nil {
			return proposal, err
		}
		scope.Path = safePath
		switch scope.Kind {
		case "file":
			if scope.Symbol != "" {
				return proposal, errors.New("file scopes must not contain a symbol")
			}
		case "symbol":
			if !boundedText(scope.Symbol, 512) || strings.IndexFunc(scope.Symbol, unicode.IsControl) >= 0 {
				return proposal, errors.New("symbol scopes require a qualified symbol; use an explicit file scope for parser fallback")
			}
		default:
			return proposal, errors.New("scope kind must be file or symbol")
		}
		if !seen[scope] {
			normalized = append(normalized, scope)
			seen[scope] = true
		}
	}
	sort.Slice(normalized, func(a, b int) bool {
		left, right := normalized[a], normalized[b]
		return left.Path+"\x00"+left.Kind+"\x00"+left.Symbol < right.Path+"\x00"+right.Kind+"\x00"+right.Symbol
	})
	proposal.Scopes = normalized
	proposal.BaseCommit = strings.ToLower(proposal.BaseCommit)
	return proposal, nil
}

func boundedText(value string, limit int) bool {
	return utf8.ValidString(value) && len(value) > 0 && len(value) <= limit && strings.TrimSpace(value) == value && strings.TrimSpace(value) != ""
}

func normalizeRepoPath(value string) (string, error) {
	if !boundedText(value, 1024) || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "~") || strings.ContainsAny(value, "\\:") || strings.IndexFunc(value, unicode.IsControl) >= 0 || path.Clean(value) != value || value == "." {
		return "", errors.New("scope paths must be unambiguous repository-relative paths")
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." || strings.TrimSpace(component) != component {
			return "", errors.New("scope paths cannot traverse or contain ambiguous components")
		}
	}
	normalized := norm.NFC.String(cases.Fold().String(value))
	// Canonical identities must survive boundary validation, FSM replay, and
	// snapshot restore unchanged. The pinned fold implementation toggles
	// Cherokee case; reject unqualified identities instead of granting aliases.
	if normalized != norm.NFC.String(cases.Fold().String(normalized)) {
		return "", errors.New("path Unicode identity is not qualified for stable normalization")
	}
	if len(normalized) > 1024 {
		return "", errors.New("normalized scope path exceeds the supported byte limit")
	}
	return normalized, nil
}

func scopesOverlap(left, right Scope) bool {
	if left.Path != right.Path {
		return false
	}
	if left.Kind == "file" || right.Kind == "file" || left.Symbol == right.Symbol {
		return true
	}
	for _, separator := range []string{".", "::", "#", "/"} {
		if strings.HasPrefix(left.Symbol, right.Symbol+separator) || strings.HasPrefix(right.Symbol, left.Symbol+separator) {
			return true
		}
	}
	return false
}

func fingerprint(request CommandRequest) string {
	data, _ := json.Marshal(request.Command)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
