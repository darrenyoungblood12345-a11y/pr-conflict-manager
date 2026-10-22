# Native coordinator feasibility harness

The coordinator uses real HashiCorp Raft, `raft-boltdb/v2` backed by bbolt, and
`FileSnapshotStore`. The original loopback harness remains available. An
authenticated LAN core now supports pinned enrollment, TLS Raft replication,
leader forwarding, and signed execution receipts. These are verified with real
peers on one Mac; multi-Mac sleep/wake, firewall/discovery behavior, real agent
clients, and the complete OS matrix remain release gates.

## Build and run

From the repository root:

```sh
npm run build:native
native/coordinator/bin/coordinator --id local-mac --data-dir /private/tmp/agent-workspace-example --bootstrap-if-new
```

The helper writes exactly one readiness object to stdout: `{url, token}`. The
parent application consumes it privately. Do not copy the token into logs or
documentation. Both HTTP endpoints require `Authorization: Bearer <token>`:

- `GET /v1/snapshot` returns the shared snapshot contract.
- `POST /v1/commands` accepts the shared `{requestId, command}` contract.

Business rejections return HTTP 200 with `ok: false`; invalid JSON/schema returns
400, unauthorized access 401, browser-origin requests 403, and unavailable
authority or an uncertain commit 503. No CORS or redirects are provided.

`--api-address` and `--raft-address` default to numeric `127.0.0.1:0` loopback
listeners. A selected Raft address and node identity are persisted. Restarting
with the default ephemeral address reuses the saved address; it does not create
a new membership or bypass quorum. A port conflict fails startup rather than
silently rewriting peer configuration.

`--bootstrap` strictly requires no existing Raft state. `--bootstrap-if-new`
creates a single-member local workspace only when `raft.HasExistingState` is
false; otherwise it resumes the saved voter configuration. The two flags are
mutually exclusive. A cached data file without Raft state is not treated as an
existing cluster. Opening an existing two-voter workspace with one surviving
Mac cannot shrink its roster or authorize new work.

The original loopback mode has no network membership-management endpoint. Its
tests join real loopback peers through HashiCorp's membership API. LAN mode uses
the enrollment protocol below; neither mode implements a custom election.

## Authenticated LAN core

`--generate-lan-identity --workspace-id <id> --id <device>` generates an Ed25519
device identity and writes its private JSON to stdout for the supervising parent
to capture. Generation does not open a workspace. Each device owns its own
workspace-scoped CA and leaf keys; signing keys are never shared between Macs.
The parent encrypts its profile using OS-backed storage. Private keys and entered
passwords reach the helper through one bounded JSON line on a private pipe with
`--lan-config-stdin`; they are not arguments, environment variables, Raft entries,
or readiness fields. The exact configuration types live in `lan_identity.go`.

Workspace and device IDs are lowercase DNS labels. The selected listen address
is a numeric unicast private/link-local/loopback address, with explicit control
and Raft ports (zero selects ephemeral ports). Public readiness adds
`lan: {workspaceId,deviceId,controlUrl,raftEndpoint,caCertPEM,fingerprint}` to the
existing private `{url,token}` envelope. The bearer credential remains loopback
only. Public LAN metadata does not contain a password/verifier or private key.

The creator explicitly bootstraps only during initial workspace creation.
Existing LAN profiles reopen without a bootstrap flag. Missing creator Raft
state is an error. A joining directory persists its origin and rejects both
bootstrap flags even when it has not received a Raft log yet. A saved creator
whose Raft configuration already exists may finish interrupted identity
initialization after a fresh quorum check; this does not bootstrap new voters.

An invitation supplies a selected device's public CA/fingerprint through an
explicit out-of-band confirmation. Standard TLS 1.3 chain, date, hostname, and
EKU verification happens before a password-bearing HTTP request is sent. No
insecure TLS option or automatic trust from discovery is used. Leaf CN and its
single DNS SAN are `<device>.<workspace>.agent-pr-monitor.invalid`; leaves have
client/server authentication EKUs. Generated leaf certificates last one year,
device CAs ten years. Certificate renewal is not yet exposed; expired identities
fail authentication while saved history remains readable.

Password verification uses standard scrypt N=16384,r=8,p=1,keyLen=32 with a
16-byte salt and unpadded base64url fields. Each peer stores its own verifier;
the verifier is not replicated. Enrollment verifies the leaf chain and a signed
CSR binding the request ID, logical identity, and leaf public key. A successful
grant binds the device CA in a committed public roster, with at most ten
members including pending ones. Password enrollment is one explicit attempt;
the plaintext password is cleared after that attempt. `joinAttempt` is
`none`, `pending`, `verified`, or `failed`. Pending/failed local attempts cannot
accept new members. Only a validated successful grant replaces the runtime
password verifier; retries preserve device identity and enrollment request ID.

The joiner's listeners/Raft start before enrollment. The grant supplies public
trust before the leader waits for catchup. Pending peers may replicate but may
not submit task commands. The leader serializes AddNonvoter, a committed FSM
sync marker plus authenticated applied-index confirmation, AddVoter, and final
activation. AddVoter alone is not treated as catchup evidence. Interrupted
stages resume from the committed roster/configuration; a timeout never causes
membership reset or removal. Connections cannot be revoked safely by deleting
an address hint: member removal and password rotation are deliberately not
exposed in this core.

Raft addresses are stable device IDs. A custom TLS StreamLayer resolves their
current numeric endpoint hints and verifies the expected peer certificate.
Local hints and authenticated peer hint exchange affect reachability only, not
identity, votes, or authorization. Discovery is not a trust source. New work
requires the configured voter majority, including after all-offline restart;
one survivor of two never becomes a new single-voter workspace. Heartbeat loss
does not remove a voter or release offline task reservations.

Followers forward task commands and authoritative reads over member TLS to the
current leader without redirects. The leader verifies quorum for each request
and binds task mutations and deduplication records to the authenticated device.
Only the registered Mac may change its task execution state. `authoritySource`
distinguishes `local`, `forwarded`, and `cached` snapshots; cached data never
provides new approvals. Raft assumes enrolled processes follow its protocol;
this is not a Byzantine consensus system for compromised device keys.

Authenticated loopback LAN endpoints are `GET /v1/lan/status` and
`PUT /v1/lan/peer-hints` with `{peerHints:[...]}`. Status distinguishes starting,
pending, nonvoter, and active; a successful password check alone is not complete
enrollment. Peer HTTPS routes are internal to the native helper, not bearer APIs.

## Repository binding and execution receipts

`bind_repository` commits one immutable `{owner,repo}` GitHub identity into the
public workspace state. ASCII owner/repo identities are canonicalized to lower
case. The same binding succeeds without another activity event; another binding
is rejected permanently. LAN task registration requires this binding. The app
and agent gate must verify the selected clone's GitHub origin matches it; the
native coordinator does not run Git or infer a local filesystem origin. Legacy
loopback-only task fixtures can remain unbound.

`link_pull_request` records an owner/device-bound positive PR number at an exact
task revision. First linking increments the revision; repeating the same number
is idempotent. Replacement requires a stop acknowledgement and clears earlier
merge evidence. A scope revision clears the link and merge observation. LAN
`mark_pr_merged` requires a link. The desktop must observe the exact PR in the
bound repository through GET-only GitHub requests and submit its observation
against the still-matching task revision/link. Native task metadata alone is not
proof of a GitHub merge. A merge still cannot release active/offline work until
explicit completion and stop acknowledgement are also recorded.

`GET /v1/task-receipt?taskId=<id>&revision=<n>` is loopback bearer authenticated
and available only in LAN mode. It requires fresh quorum-backed state, an exact
active revision with no conflicts/stop acknowledgement, and immutable local
device ownership. It rechecks authority and active-task equivalence after any
ownership catchup wait and serializes signing with newer locally applied task
changes. Pending, blocked, stopped, other-device, unbound, or cached-only work
cannot receive a new receipt.

The response is `{payload,signature,certPEM}`. `payload` is unpadded base64url of
the exact UTF-8 JSON `{version:1,workspaceId,issuerDeviceId,task,commitIndex,
repository}`. The existing device Ed25519 leaf key signs those decoded JSON
bytes; `signature` is unpadded base64url. No reserialization is required to
verify. Decoded payloads are bounded to 266240 bytes. The agent context must pin
the workspace/device CA and repository, verify leaf identity/chain/dates and the
signature, and bind task/session/revision/scopes before offline continuation.
New tasks and expanded scopes still require authority. Receipts are prior
approvals, not revocation notifications: reconnecting gates must invalidate them
when they learn of a block, stop, revision, or cancellation. No process-preemption
or in-flight-write guarantee is implied.

## Durable state and task decisions

Every command is independently validated at the HTTP boundary and in the FSM.
Task scopes use repository-relative canonical Unicode/case-folded paths;
traversal, absolute paths, ambiguous separators, missing identifiers, unknown
fields, duplicate JSON fields, and incomplete symbol scopes are rejected.
Qualified symbols remain case-sensitive. An explicit whole-file scope is the
parser fallback. Symlink/physical-file aliases need the later local clone index;
lexical path normalization alone does not prove filesystem identity.

Canonical path identities must be idempotent and fit the same byte limit after
normalization. The pinned Unicode library toggles Cherokee case, so these
unqualified names are rejected rather than accepted as conflicting aliases.
TypeScript uses matching versioned Unicode 15 data and the same conservative
qualification boundary. Requalify these names before enabling them.

The deterministic FSM serializes checking and reservation creation. Different
qualified functions can coexist; identical/containing symbols or whole-file
scopes conflict. An overlapping registration is recorded as blocked and blocks
existing holders atomically. One earlier registration may have started before
the later overlap commits. A result's `ok: true` means the request was recorded,
not that the task is permitted to edit.

Cancellation and scope replacement require matching owner/revision and an
acknowledgement that admitted/background writes have stopped. Acknowledging an
active task stops it (`blocked`); revision creates a new execution revision.
Reporting completion moves it to `awaiting-merge`. Only completion plus stop
acknowledgement plus an observed merge releases it as `completed`. A merge alone
never releases an active/offline reservation. Cancellation releases stopped
work. Removing a competing reservation does not automatically restart another
blocked task; its owner must revise it.

Raft logs, snapshots, successful-request deduplication, and a persisted committed
FSM projection survive restart. Snapshot copies are immutable and state access
is synchronized. The projection records its applied index so replay cannot
re-execute rejected old commands against newer task state. Cached history does
not confer authority. A historical accepted request returns current state and
`STALE_RETRY` after that task revision changes; clients must revalidate state
before writing. Storage-projection failure blocks future authority rather than
pretending a committed entry was rolled back.

`hasAuthority` requires fresh `VerifyLeader` quorum confirmation and a Raft
barrier; a remembered leader flag or cached peer count is insufficient. New
commands also require a successful Raft commit. A timed-out request can already
have committed, so retry the same request ID and inspect current task state.
Do not submit a new request ID merely because a response was lost.

## Verification and current limits

`npm run test:native` runs the Go suite. The race-enabled suite covers the FSM,
snapshots, actual TCP Raft replication, two-voter loss, three-voter leader loss,
returning-peer catch-up, simultaneous registration intermediate/final states,
normal restart, stale receipts, retained offline scopes, and the HTTP boundary.
LAN tests also cover TLS pinning, authenticated forwarding, device-bound task
ownership, creator/nonvoter recovery, interruption after committed promotion,
signed receipt verification, immutable repository binding, and owned PR links.
The ten-peer scale test uses production Raft timers and ten separate persisted
TLS/Raft nodes on loopback. It verifies ten admitted voters, device-owned task
submissions and follower forwarding, majority leader replacement, concurrent
overlap blocking, refusal of new work with only five of ten voters, and recovery
through six voters back to all ten saved replicas without shrinking membership
or releasing offline reservations. Its focused race run passed in 33.65 seconds.
Peer losses in this test are controlled node shutdowns; they do not qualify
abrupt physical-Mac crashes, packet-loss behavior, discovery, or sleep/wake.
The sandbox may require permission to bind localhost for these real integration
tests; tests must not substitute a simulated Raft implementation when binding
is unavailable.

These tests run multiple real peers on one Mac. They are not evidence of
multi-Mac LAN security, macOS sleep/wake behavior, the full 2–10 participant
matrix, the full multi-Mac interrupted-membership matrix, or every supported OS.
The local bearer token protects the app API. Original loopback-mode Raft remains
unauthenticated against other local processes; LAN mode uses member TLS and
device-bound ownership. These modes must not be confused during qualification.

Existing data directories are checked for ownership and secured to mode0700
before opening stores. Accepted state, including activity and request records,
is bounded to the restore limit. The desktop uses `--exit-on-stdin-close` with a
parent-owned pipe so an Electron crash releases the helper's database lock.

No process-level kill or preemption guarantee is made. The native service cannot
prove an independent agent stopped or prevent an already-admitted shell process
from writing. Agent adapters and user acknowledgements must supply that proof.
The signed LAN receipt supplies the native authorization evidence for approved
offline continuation. The real two-peer bundled MCP/hook test independently
qualifies modeled adapter persistence and reconnect revocation; actual commercial
client enforcement still needs qualification. Loopback-only mode
cannot issue such a receipt. Reservations never expire through heartbeat loss.
