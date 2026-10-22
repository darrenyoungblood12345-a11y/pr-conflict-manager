# Desktop operation and boundaries

The Electron renderer uses a sandboxed preload with context isolation and no
Node integration. Main-process IPC checks the sender/main frame, validates
payloads, and delegates decisions to the native coordinator. It never passes
bearer tokens, workspace private keys, password verifiers, or native readiness
output to the renderer. External navigation and new windows are denied.

## Workspaces

The initial local development workspace is separate from LAN profiles. In
Workspace pool, a user can create a workspace, review a pinned public invitation
and join, or reopen saved replicated history. A new workspace alone may
bootstrap. Reopening a saved LAN profile never bootstraps or resets a voter
roster; loss of persisted creator data requires recovery, not an invented quorum.

Every Mac has a separate workspace-scoped CA and leaf private key. Public
identity fingerprints are compared before sending a join password. Public
invitations contain no signing key or password. Private profiles are encrypted
with Electron's asynchronous OS-backed safeStorage API, stored atomically in
owner-only files, and have no plaintext fallback. See the official
[safeStorage security model](https://www.electronjs.org/docs/latest/api/safe-storage).
Consistent signing is required for reliable Keychain identity across releases.

Enrollment is asynchronous: pending/nonvoter stages cannot authorize tasks.
Interrupted attempts retain their device identity, request ID, and public pin.
An explicit retry supplies the password again. Passwords are startup-pipe and
memory data, never profile fields or Raft entries. A verified enrollment must
save its accepted verifier before its recovery marker is cleared. Failed or
unconfirmed attempts remain saved for explicit recovery.

Bonjour advertises public endpoint hints for the selected LAN interface. Hints
can update addresses for known roster devices; they cannot enroll a new identity,
change certificate trust, remove voters, or grant task permission. TLS and the
committed roster remain authoritative. Loopback-only test profiles do not
advertise themselves to the LAN. Physical multicast/firewall behavior remains a
release test.

## Local clone and agent setup

Worktree selects this Mac's clone. Git operations read branches, parent hashes,
status, and redacted origin metadata without fetching, checking out, or writing
the index. Graph edges are actual parent relationships, with bounds and omitted
ancestry explicit. GitHub requests use only the fixed official API origin and
GET methods; private tokens are held only for the current app session.

Scopes are verified against the selected clone with Tree-sitter. Unavailable,
unsupported, new, or ambiguous symbols become whole-file reservations. Unsafe
paths fail. A broader resulting reservation is shown in the committed task;
function-level descriptions never override the actual reserved scope.

Agents prepares a distinct private context for each native session. It displays
mergeable MCP/hook snippets and instructions; it never overwrites existing
project/global agent configuration. A private owner-executable launcher starts
the packaged Electron binary in Node mode so no separate Node installation is
needed. The integration bundle and parser assets are outside app.asar for
external client/plugin loading. Version detection is not client qualification.

Each workspace has its own private endpoint file. Renderer mutations carry the
workspace key they reviewed; stale requests are rejected across workspace
switches. Setup also checks the expected clone and endpoint path before and
after publishing its context. Prior helper processes cannot remove a replacement
endpoint or mark its runtime unavailable.

## Process lifecycle and verification

Closing a Mac window leaves the application running. Quit stops discovery and
the native helper. A kept-open stdin pipe makes a helper shut down after parent
death and release its durable database lock. Helpers use bounded shutdown and
readiness deadlines, and credentials never enter stdout/stderr logs.

Colocated tests cover command bounds, private storage, setup preservation,
invitation validation, selection races, graph ancestry, exact-PR observation,
and native/parser protocol behavior. Actual packaged UI checks on macOS 27
verified plan editing, clone selection, commit graph display, function-task
registration, conflict blocking, stop/cancel/revision, and persisted restart.
Notification delivery, Keychain prompts, physical Mac failover/sleep, and the
other supported OS/client versions still need separate runtime checks. Missing
verification is not reported as a passed release criterion.
