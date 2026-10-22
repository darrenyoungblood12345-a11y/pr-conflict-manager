# Desktop feasibility harness

Historical phase 1 notes. The current desktop has additional repository,
parser, agent-setup, and LAN surfaces; see [desktop operation](desktop.md).

The Electron application is a real client of the local native coordinator. It
starts one loopback-only helper and presents its persisted state. An empty new
workspace has no sample tasks, peers, or commits. This is phase 1 of the approved
plan, not a qualified LAN workspace or a conflict-free merge guarantee.

## Build and process boundary

- Renderer: root `index.html` and `src/renderer/main.tsx`.
- Main/preload: `src/electron/main.ts` and `src/electron/preload.ts`, bundled to
  `dist/electron/main.cjs` and `dist/electron/preload.cjs`.
- Production renderer: `dist/renderer/index.html`.
- Native helper: development `native/coordinator/bin/coordinator`, with
  `dist/native/coordinator` fallback; packaged `resources/native/coordinator`.
- Development renderer uses `VITE_DEV_SERVER_URL`, restricted to loopback HTTP.
- Development URLs must use `127.0.0.1` or `localhost` on port 5173, without
  credentials, alternate paths, queries, or fragments. Packaged builds ignore
  the variable and load only the bundled renderer.
- Native data is kept under Electron's user-data directory in
  `workspaces/local`. Normal Mac window close retains the running application;
  Quit terminates the helper with SIGTERM, then SIGKILL after a bounded timeout.
- A kept-open stdin pipe and `--exit-on-stdin-close` make the native helper exit
  when Electron crashes or is abruptly killed. The resulting EOF releases the
  helper's database lock; regular shutdown still uses SIGTERM.
- The helper starts with `--bootstrap-if-new`: it creates an initial local
  membership only if no Raft state exists, and preserves existing membership on
  restart. Startup never deletes workspace data or resets persisted membership.

The renderer is sandboxed with context isolation, without Node integration. Its
preload exposes only snapshot, command, and runtime calls. IPC validates the
calling window/main frame and command shapes before calling the service. The
native service independently validates authoritative commands. Its readiness
bearer token is retained only in the main process, with stdout/stderr excluded
from renderer and user logs. New windows/navigation are denied.

## Local agent connection

When the native helper becomes ready, the main process atomically writes its
private connection details to Electron's app-specific user-data directory:

```text
<app.getPath('userData')>/integration-endpoint.json
```

On macOS the app-specific directory is under `~/Library/Application Support`.
The actual directory follows `app.getPath('userData')`; `runtime()` can reveal
the endpoint-file path for setup, never its content or bearer credential. The
file is mode 0600, its app-owned parent is mode 0700, and its content is only
`{url, token}`. Keep it out of repositories, prompts, and configuration exports.
Agent configuration refers to its path. This file is local access to this
single-Mac harness, not a LAN join password or a shared credential.

The application owns a single-instance lock. It removes stale handoff files
before starting, and removes its own handoff when the helper stops or the app
quits. Cleanup compares the saved token and URL so an older instance does not
delete a replacement instance's credential. Abrupt termination can leave a
stale handoff, which the next startup removes before creating a new one.

For the development bridge, use the generated private endpoint-file path with
the integrations CLI's `--endpoint-file` option. Session contexts remain
separate private files supplied through `--context-file`; each agent session
must use its own context. Run the CLI's `snippets` mode to generate the selected
agent's MCP and gate configuration rather than copying bearer tokens.

For example, after building the development bridge:

```sh
node dist/integrations/cli.js snippets \
  --agent codex \
  --endpoint-file '/actual/app-user-data/integration-endpoint.json' \
  --context-file '/private/session-directory/codex-session.json'
```

Replace the two paths with the local generated handoff path and that session's
private context file. The endpoint handoff rotates on every app/helper restart.

## Functional surface

- Edit the versioned shared plan with optimistic revision checking. A concurrent
  plan change preserves the unsaved local draft and requires reviewing it again.
- Propose work with owner/session metadata, supported-agent identity, branch,
  base SHA, task description, and declared file/symbol scopes.
- Show actual coordinator task states, conflicts, stop acknowledgement,
  registered scope, leader authority, voter count, and committed-log index.
- Acknowledge that writes have stopped, revise held scope, abandon work, or
  report editing complete. Lifecycle rules are enforced by the service.
- Display held file/symbol reservations, declared branch/base relationships,
  and committed activity. No fabricated Git history or remote observations.
- Request native notifications for newly observed blocked task revisions with
  actual conflicting task references. A voluntary stop alone is not labeled
  as an overlap or sent as an overlap notification.
  Actual notification delivery depends on macOS permission and packaging.

The desktop's local owner field is a feasibility control, not authenticated
agent-session ownership. Parser qualification, GitHub merge observations,
password pairing, multi-Mac membership, and client-hook qualification remain
separate release gates. Function scopes entered here are explicitly declared,
not parser-verified. The UI cannot stop an already-running agent command.

## Failure presentation

Missing/stopped helper, loss of snapshot access, and absent Electron preload
produce visible unavailable states. Cached snapshots remain labeled as saved
views, and mutations are disabled until live authoritative state returns.
Browser-only previews always show that the native bridge is unavailable and do
not simulate service state. A browser preview can validate layout, but cannot
prove IPC, persistence, notifications, or helper lifecycle.

## Verification

`src/electron/validation.test.ts` checks IPC rejection of malformed, unbounded,
unsupported, and identity-switching commands. Type checking covers the desktop
and shared API. Runtime verification must additionally use Electron and the
real helper: save a plan, register overlapping/non-overlapping tasks, inspect
the scope and branch views, resolve a conflict, restart for persistence, and
quit to inspect child cleanup. Native macOS notification delivery requires a
manual OS check; lack of a delivery test must not be reported as passed.
