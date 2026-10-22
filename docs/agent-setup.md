# Agent integration feasibility harness

This is Phase 1: a local MCP bridge and client-specific action gates. It is not yet a qualified LAN product. The tests exercise the adapters and the actual bundled stdio protocol; they do not establish that all four commercial clients honor these hooks in real sessions.

## Qualification status

| Client | Adapter | Qualification boundary |
| --- | --- | --- |
| Codex | MCP + project `PreToolUse` command hook | Installed version observed by the project: `0.163.0-alpha.10.2`. Hook definition must be explicitly trusted. Real-session edits, stop behavior, trust changes, and failures still need verification. |
| Claude Code | MCP + `PreToolUse` command hook | Installed version observed by the project: `2.1.285`. The generated failure-blocking setup requires **2.1.295 or later**; the installed version is below this requirement. |
| Cursor | MCP + IDE Agent `preToolUse` with `failClosed: true` | Client unavailable on this development machine. Exact MCP naming, native file payloads, and denied tool behavior remain unverified. Cursor CLI and Tab are separate surfaces and are not qualified here. |
| OpenCode | MCP + local `tool.execute.before` plugin | Client unavailable on this development machine. Plugin loading, session identity, tool naming, and thrown-error denial require real-client verification. |

The current [Claude Code hook reference](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) dates the `onFailure: "block"` option to 2.1.295. Explicit native denial works independently of that setting, but a crashing or missing hook on older versions can fail open. Do not mark the older installed client as fully supported.

## Build and local configuration

Build the application with `npm run build`. The integration entry is `dist/integrations/cli.js`. Start the desktop app and use the **private endpoint file path** shown in its connection details. The file contains the current loopback URL and bearer credential, is removed when its owning helper exits, and changes across app launches. Keep its contents out of logs, prompts, Git, and shared history.

Create a different private session-context file for each agent session, outside the repository. Use permission `0600`. A starting example is:

```json
{
  "repositoryRoot": "/absolute/path/to/your/local/clone",
  "ownerId": "your-stable-local-owner-id",
  "sessionId": "the-actual-native-agent-session-id",
  "agent": "claude-code"
}
```

Allowed agent values are `codex`, `cursor`, `opencode`, and `claude-code`. Set `sessionId` to the actual client session identity: Codex/Claude Code `session_id`, Cursor `conversation_id`, or OpenCode `sessionID`. Never copy another session's task context to bypass a refusal. Automatic native-session capture and setup health UI remain onboarding work; this feasibility setup deliberately fails when the identities do not match.

The MCP bridge binds `taskId` and `revision` into this file only after a successful submit/revise whose accepted task and fresh authoritative snapshot match the submitted, locally qualified proposal. This compares the owner/session/agent, revision, branch/base commit, description, plan revision, and canonical scopes; the same revision with different reservations is insufficient. Simply reading task status never refreshes an old acceptance. Native gates independently reread the file and current task before a covered action. Context files must be owned by the running user, regular files, and inaccessible to group/other users; symlink configuration files are rejected.

LAN setup also provisions `offlineAuthority` with the workspace ID, this Mac's device ID, and its pinned public CA certificate. The bridge requests a signed task receipt only after a fresh acceptance and checks authoritative state again before saving it. The private context stores `acceptedOfflineReceipt` and monotonic `offlineRevokedThrough` revision floors; leave these fields under the bridge's control. Never copy a receipt or replace its CA pin to bypass a refusal.

Generate reviewable project snippets:

```sh
node dist/integrations/cli.js snippets \
  --agent claude-code \
  --endpoint-file '/absolute/private/path/integration-endpoint.json' \
  --context-file '/absolute/private/path/session.json'
```

This prints JSON containing proposed relative file paths, their contents, instructions, and limitations. It does **not** write client configuration. Merge the fragments into existing files; preserve all existing servers, keys, hooks, and project instructions. Repeat with the agent's name for its format.

| Client | Proposed project files |
| --- | --- |
| Codex | `.codex/config.toml`, `.codex/hooks.json` |
| Claude Code | `.mcp.json`, `.claude/settings.json` |
| Cursor | `.cursor/mcp.json`, `.cursor/hooks.json` |
| OpenCode | `opencode.json`, `.opencode/plugins/agent-pr-monitor.mjs` |

The generated launch paths are absolute. Both MCP and hooks point to the same endpoint/session files. The native command wrapper converts a failed executable invocation to exit 2; Cursor also sets `failClosed`, and supported Claude Code versions set `onFailure`. Review and trust the project configuration in the client. In Codex, review the exact hook definition with `/hooks`; changed or untrusted hooks can be skipped. See the [official Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

To launch MCP manually for a protocol harness:

```sh
node dist/integrations/cli.js mcp \
  --endpoint-file '/absolute/private/path/integration-endpoint.json' \
  --context-file '/absolute/private/path/session.json'
```

This is a stdio MCP process, not an interactive shell. It writes protocol messages only to stdout. The equivalent optional environment variables are `AGENT_MONITOR_ENDPOINT_FILE` and `AGENT_MONITOR_CONTEXT_FILE`; bearer tokens are not accepted as command-line arguments.

## Agent workflow and tools

Add the generated `instructions` text to the project's existing agent instructions/rules after reviewing it. Ask the agent to read the shared plan and document its intended functions/files before starting work.

| MCP tool | Purpose |
| --- | --- |
| `read_plan` | Read versioned Markdown, authority availability, and the bridge's configured owner/session identity. |
| `list_tasks` | Read task intent, scopes, revisions, status, conflicts, and stop acknowledgement. |
| `task_status` | Fetch one task's current state without refreshing local editing permission. |
| `repository_status` | Inspect the selected clone's local Git state without fetching, writing, or requiring task permission. |
| `list_symbols` | Inspect qualified function/container names and source ranges in one safe local source file before proposing scopes. |
| `set_plan` | Replace the shared plan using its current expected revision. |
| `submit_task` | Register the task description, branch/base commit, current plan revision, owner/session, and file/symbol scopes. |
| `revise_task` | Replace owned task scope using the current task revision after all admitted/background writes have stopped. |
| `link_pull_request` | Associate an existing PR number with an owned task at its exact revision; refresh active acceptance after the link revision. |
| `acknowledge_stop` | Explicitly confirm all writes for the current task revision have stopped. A pause request alone is insufficient. |
| `report_completion` | Report editing complete while retaining the reservation for integration/merge. |
| `cancel_task` | Abandon owned work after the required stop acknowledgement. |

The native coordinator validates state transitions independently of MCP. Owned mutations are also limited to the bridge's configured owner/session/agent. `link_pull_request` records an existing PR number; it does not write to GitHub. No PR-creation or merge tools are exposed, and there is deliberately no agent-callable `mark_pr_merged` tool. The app observes the exact linked PR in the bound repository; agents cannot assert that a PR merged to release their own reservations.

An overlap can commit a registration successfully while its task is **blocked**. `ok: true` means the operation committed. It does not mean editing may start. Responses include a fresh task/authority observation, but the gate remains the action admission point. Historical success after cancellation, a changed revision, or lost authority cannot refresh the session context.

For LAN workspaces, the first production CLI registration binds the selected clone's canonical GitHub origin to the workspace under fresh authority. The binding is immutable. Later registration and covered edits require that same repository; an identically named path in another GitHub repository cannot reuse the reservation. Local feasibility contexts without LAN authority retain their earlier unbound behavior.

When blocked, coordination tools stay callable so the agent can explain the conflict, read the other plans, and help its user cancel or revise. Acknowledgement must wait for commands already admitted, background writes, and delegated work to finish. The gate never claims to have stopped an already-running command.

## Current gate coverage

Every covered edit requires a matching native session, task owner/agent, current revision, active status, no conflicts, no stop acknowledgement, and either current authority or a valid existing offline receipt.

- Documented native `Read`, `Glob`, and `Grep` shapes can inspect safe selected-repository source paths before registration and while blocked, without a coordinator connection. `Read` requires one regular file. Searches audit every potential subtree entry, refusing symlinks, agent/Git control directories, more than 4,096 entries, or more than 64 levels. Glob syntax excludes traversal, brace/extglob expansions, and ambiguous hidden-path patterns. A root-wide recursive search containing `.git` is refused; use an explicit safe source subtree such as `src/**/*.ts`. This is a conservative adapter policy, with real-client behavior still unverified. The [official Claude hook reference](https://code.claude.com/docs/en/hooks#pretooluse-input) documents the native read/search fields.

- Exact supported native `Edit`, `Write`, and `MultiEdit` payloads are reconstructed against the current local file. A function reservation can admit the changed interval only when both versions parse and the change lies strictly inside the same uniquely identified existing reserved function. The gate also rechecks current authority after this proof. This tests the adapter's source model; it does not establish that every real client performs only that modeled edit.
- New files/functions, added or removed named functions, function boundary changes, missing or ambiguous symbols, and unsupported/errorful parsing require a whole-file reservation. Submission visibly widens an unqualified symbol scope to the whole file before committing it. Unsafe paths fail instead of widening. See the fixture-tested language matrix and limitations in [symbol coverage](symbol-coverage.md).
- Codex `apply_patch` still requires whole-file reservations and checks every declared add/update/delete/rename path, including both rename endpoints. Unrecognized patch metadata is refused.
- Relative paths resolve against the native action's working directory. Outside-repository paths, traversal, symlink aliases, ambiguous path fields, and agent/Git control files are refused.
- Path identity uses versioned [Unicode 15 C/F mapping data](https://github.com/node-unicode/unicode-15.0.0) followed by NFC. Newer/unassigned characters are refused so a newer Node runtime cannot introduce additional filename equivalences. Cherokee paths are also refused: exhaustive comparison found that the pinned native case folder toggles those aliases instead of producing an idempotent identity. They remain unqualified until both sides use a corrected mapping.
- Arbitrary shell, unknown tools, and delegation are refused even when a task is active. Calling a command “read-only” is not proof that it cannot write. A supervised shell policy and post-edit scope auditing are later work.
- Unavailable coordination permits only previously accepted LAN scope with a valid saved receipt. New tasks, revisions, and scope expansion still require fresh authority. Local feasibility contexts without a receipt fail closed. The current clone must match the receipt's signed repository binding, and function edits retain the same parser proof as online edits.
- There is no OS filesystem lock. Human edits, disabled hooks, clients that skip hooks, and external/background processes can bypass this cooperative integration.

Codex documents that hosted/specialized tool paths may bypass local hooks and that later `write_stdin` calls do not run `PreToolUse` again. Cursor documents [Agent `preToolUse` and fail-closed hook configuration](https://prod.cursor.com/docs/hooks); that does not prove Tab or CLI coverage. OpenCode documents [the local plugin callback](https://opencode.ai/docs/plugins/) used here. Real-client tests must verify these boundaries rather than generalizing adapter unit tests into client support claims.

## Accepted LAN work while disconnected

The enrolled Mac signs a receipt only for its own exact active task after a fresh quorum-backed check. Its payload includes the full task reservation, workspace/device identity, repository binding, and commit index. The bridge uses [Node's X.509 and Ed25519 APIs](https://nodejs.org/api/crypto.html#class-x509certificate) to verify the exact signed bytes, pinned CA and leaf signatures, certificate dates, exact logical name and single DNS SAN, key types, and TLS extended usages. A receipt from another session, Mac, workspace, repository, task revision, or reservation cannot authorize work.

A missing endpoint file after app closure and genuine transport/quorum loss can use that receipt. Malformed or unsafe endpoint configuration, authentication refusal, redirects, and malformed protocol responses fail closed. Any observed task stop, conflict, cancellation, or incompatible revision invalidates the receipt even if the observation is cached without current quorum. MCP lifecycle calls and native gates persist this revocation under a private context lock; an older in-flight acceptance cannot overwrite it. A crashed writer leaves the lock closed for review rather than guessing that it is stale.

An unreachable Mac cannot learn about a newly committed remote stop until it reconnects. Offline continuation therefore preserves the last accepted reservation; it does not claim immediate remote interruption. Already-admitted/background writes still require explicit stop acknowledgement before a reservation can be released. Real-client and multi-Mac failure qualification remain separate from these protocol tests.

## Verification

Colocated Vitest tests cover current revision/identity gates, stopped/cancelled/blocked tasks, stale or mismatched acceptance, unavailable authority, whole-file fallback, multi-path patches, symlink/traversal/control-file refusals, bounded planning reads/searches, exact coordination exemptions, native output formats, and OpenCode thrown denials. Receipt tests cover signature tampering, certificate and identity checks, bounded decoding, scope mismatch, expiry, concurrent accept/stop persistence, and revocation before an older acceptance completes. SDK in-memory protocol tests exercise actual tool discovery, schema validation, local planning observations, PR linking, and command forwarding. Subprocess tests bundle the entry with copied parser assets, perform real stdio MCP discovery/registration against a loopback mock coordinator, and invoke native hook stdin/error paths. They prove modeled Edit/Write/MultiEdit interior changes, sibling-function refusal, missing/ambiguous/new-file fallback mutations, private context binding, missing parser assets, automatic repository binding, app-closed signed continuation, malformed-endpoint refusal, and durable stop revocation. No commercial agent session is involved.

Run the adapter suite with:

```sh
npx vitest run src/integrations src/symbols
```

The subprocess fixture needs permission to bind an ephemeral **loopback-only** port. A sandbox that prohibits local listeners must run that test under an approved local-test permission; it is not silently skipped. No test invokes paid model sessions or edits the user's global agent settings.

Release checks still required: actual client version/trust/failure matrix, all supported editing and subagent paths, scope drift detection, real multi-Mac receipt/failure/sleep/wake sessions, and OS compatibility. Consult [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Cursor MCP](https://prod.cursor.com/docs/mcp), and [OpenCode MCP](https://opencode.ai/docs/mcp-servers/) when qualifying generated setup against each installed release.
