# Agent PR Monitor

A macOS app for coordinating user-run Codex, Cursor, OpenCode, and Claude Code
sessions before their proposed changes overlap. Each Mac keeps its own Git
clone and branch. The approved design is in [the project plan](tasks/project-plan.md).

[Download the Mac app and agent skill](https://darrenyoungblood12345-a11y.github.io/pr-conflict-manager/).
The skill source is [SKILL.md](skills/agent-pr-monitor/SKILL.md); site and release
updates are described in [landing-page maintenance](docs/landing-page.md).

## Development build

The app uses real persisted coordinator state, Git observations, and parser
output. New workspaces begin empty. Current functionality includes:

- A shared Markdown plan, detailed task proposals, file/function reservations,
  atomic conflict decisions, stop acknowledgements, scope revisions, and history.
- A read-only local Git commit graph, branch heads, and working-copy changes.
  GitHub observation shows branches, PRs, and checks with explicit freshness,
  failure, and coverage limits. It never commits, pushes, opens, or merges PRs.
- Tree-sitter analysis for 14 language adapters. Uncertain declarations reserve
  the whole file; covered native text edits can prove changes stay inside a
  reserved function. Codex patches still require whole-file reservations.
- LAN workspace creation, pinned invitations, password enrollment, encrypted
  local identity profiles, replicated history, and automatic leader election.
  A majority of configured voters is required for new approvals. Two voters
  therefore need both Macs online; sleeping peers retain their reservations.
- An Agents screen that creates private session contexts and displays setup
  snippets for review. Existing agent/project configuration is never replaced.
- An immutable GitHub repository binding per workspace, with mismatched clones
  rejected. Tasks link to exact PR numbers; a fresh GET-only merge check, reported
  completion, and stop acknowledgement are required before releasing their scopes.
- Signed accepted-task receipts for disconnected work within existing scope.
  Observed stops, conflicts, and revisions durably revoke old local permission.
  New work and scope changes still require current coordination authority.

This is a development build, not a qualified production release. Actual-client
hook enforcement, physical multi-Mac sleep/wake and firewall tests, macOS 15/26
verification, and production signing/notarization remain release gates. The
build runs on the development machine's Apple Silicon macOS 27 system. See
[agent coverage](docs/agent-setup.md), [parser coverage](docs/symbol-coverage.md),
and [repository observations](docs/repository-observation.md) for precise limits.
See [task and PR lifecycle](docs/task-pull-requests.md) for merge release rules.

## Develop

Use an Apple Silicon Mac, Node.js 22.12 or later, Go 1.26 or later, and OpenSSL
for the transport fixtures. The packaged app does not need these development tools.

```sh
npm ci
npm run setup:go  # Optional: checksum-verified official compiler in .local/tools
npm run dev
```

If Go is already on PATH, the setup step is unnecessary. You can also set
`AGENT_PR_GO` to its executable. Compiler/module caches under `.local/tools`
are ignored project files and do not alter the system installation.

```sh
npm run check
npm run dist:mac
```

`check` type-checks and builds the app/helper, runs TypeScript tests, Go race
tests, native/MCP protocol tests, and a real two-peer LAN/offline receipt test. Local loopback sockets
are required. `package:mac` creates an ad-hoc signed arm64 development `.app`
under `release/`, including the native helper, integration bridge, and parser
assets. `dist:mac` also creates ZIP and DMG downloads, checksums, and inspection
reports, then verifies the extracted ZIP and the app mounted from the exact DMG.
See [distribution checks](docs/distribution.md).

## Try the interface

Open the built app, then choose **Workspace pool** to create or join a LAN
workspace. On another Mac, review the invitation and compare its fingerprint
directly with the inviting Mac before entering the shared password. A pending
join is not an active voter. Interrupted joins use the saved identity and request
ID when explicitly retried; saved workspaces never bootstrap a new cluster on
reopen.

Choose this Mac's clone in **Worktree**, write the shared plan in **Overview**,
and prepare a separate setup in **Agents** for each actual agent session. Ask
your agent to read the plan and register its intended work before editing.
The app coordinates the tools you run; it does not launch agent model sessions.

GitHub tokens are optional for public repositories and needed for private ones.
The current token field keeps credentials in memory for that app session only,
clears them when switching clones/workspaces, and sends them only to
`api.github.com`. Persistent GitHub credential storage remains future work.
Workspace identity secrets use macOS Keychain-backed encryption with no
plaintext fallback. Development builds can require renewed Keychain permission
after rebuilding; a consistently signed release is required for distribution.

Closing the window keeps the Mac app running. Quitting stops its helper. Agent
configuration references private per-workspace endpoint/session files; never
copy their bearer credentials into prompts, repositories, or shared history.
