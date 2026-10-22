# Phase 1 implementation contract

Approved scope: build a local feasibility harness before qualifying LAN operation.

`src/shared/contracts.ts` is the shared JSON contract. The native helper exposes
`GET /v1/snapshot` and `POST /v1/commands` on a loopback-only HTTP listener. Both
require `Authorization: Bearer <random local token>`. No browser CORS allowance.
The helper prints one JSON readiness line with `{url, token}` to its parent;
never print that line to user logs. UI accesses the service through Electron IPC.

Raft communication in the initial harness is local to test processes; it must
not be represented as password-authenticated LAN operation. Production peer
transport/pairing and real-client/OS tests remain release gates.

The helper CLI will accept `--id`, `--data-dir`, `--api-address` (default
`127.0.0.1:0`), `--raft-address` (default `127.0.0.1:0`), and `--bootstrap` for a
new single-member local workspace. `--bootstrap-if-new` supports desktop restart:
it creates a cluster only when no persisted Raft state exists, otherwise restores
the saved membership. Never bootstrap over existing persisted data.

Task reservations persist for active, blocked, and awaiting-merge tasks.
Overlapping registration is committed as a blocked task and blocks existing
holders, incrementing their revisions and clearing stop acknowledgements. New
task success is distinct from active permission. A stopped task's owner can
cancel it or replace its scope through revision-checked commands. Completion
holds scope until both stop acknowledgement and observed PR merge. Retrying a
request never revives a task: clients inspect current state before gate approval.

Plan changes increment the plan revision and preserve task reservations. Paths
are repository-relative, normalized with case-insensitive safety on macOS;
absolute/traversing/ambiguous paths are rejected. Missing/invalid symbol scope
falls back to a whole-file reservation only when explicitly normalized; no
silent underscoped grants.

Commands and scope data are validated by the native service, independent of UI
or MCP validation. Failed authorization/validation cannot mutate state. Reads
return `hasAuthority: false` when the node cannot verify leadership; a cached
state cannot authorize a new task or revision. Existing offline execution needs
an explicit durable receipt policy; until that is proven, this initial gate
fails closed on unavailable local service and labels offline continuation as
not yet qualified.
