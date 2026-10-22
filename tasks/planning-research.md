# Planning research

Research only. These findings do not authorize implementation or select final product behavior.

## Codex integration

Official documentation checked during planning on October 20, 2026:

- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local clients support stdio and Streamable HTTP MCP servers, server instructions, and configuration shared across local Codex surfaces. A local integration can expose shared-plan and proposed-work tools without launching Codex itself.
- [Hooks](https://learn.chatgpt.com/docs/hooks): trusted lifecycle hooks can check supported tool calls before execution and deny calls with a reason. This covers shell commands, file edits through `apply_patch`, and MCP tools. Some specialized paths bypass hooks; sending input to an existing shell session does not rerun the pre-tool hook.

Planning inference: MCP can carry plans and coordination decisions; hooks can gate subsequent supported actions. This does not establish a guarantee that an arbitrary already-running command will stop immediately when another computer reports overlap. Integration verification must distinguish registered coordination state, pending pause, and an acknowledged stop.

## Other supported agents

Official documentation checked during planning on October 20, 2026:

| Client | Connection and instructions | Gate and notification findings |
| --- | --- | --- |
| Cursor | [MCP](https://cursor.com/docs/mcp) supports local stdio and remote HTTP. [Rules](https://cursor.com/docs/rules) can describe the coordination workflow. | [Hooks](https://cursor.com/docs/hooks) document `preToolUse` denial, user/model messages, and `failClosed`. A session-start hook alone does not enforce the gate. No common in-flight cancellation guarantee was established. |
| Claude Code | [MCP](https://code.claude.com/docs/en/mcp) supports local stdio and remote HTTP. [Instructions](https://code.claude.com/docs/en/memory) can use `CLAUDE.md` importing `AGENTS.md`; direct `AGENTS.md` behavior is version/settings dependent. | [Hooks](https://code.claude.com/docs/en/hooks) document `PreToolUse` denial and model-visible reasons. The documented `onFailure: block` behavior requires v2.1.295 or later. Post-tool hooks cannot prevent effects that already occurred. |
| OpenCode | [MCP servers](https://opencode.ai/docs/mcp-servers/) and [rules](https://opencode.ai/docs/rules/) support coordination tools and project instructions. | [Plugins](https://opencode.ai/docs/plugins/) can block execution through `tool.execute.before`. The [SDK](https://opencode.ai/docs/sdk/) includes session abort and TUI notifications, without a guarantee that every already-started write immediately stops or is undone. |

Research inference for the proposal, not a selected architecture: a common MCP interface can carry shared plans and task registrations. Client-specific adapters can check task status before supported actions. Both tasks can be marked blocked in one coordinator transaction; actual agent stopping must be tracked separately and verified after implementation is approved. Keep coordination read/revise/cancel tools available while ordinary work is paused.

Compatibility checks after approval must cover each actual client/version, hook installation and trust, native edits, shell writes, other MCP tools, parallel actions, subagents, disconnects, and hook failures. No integration code or compatibility prototype has been built during planning.

Cursor caveat: verified hook coverage is for its IDE Agent. Cursor CLI modes must be verified separately. No minimum Cursor or OpenCode version was established by the checked pages.

## Automatic host replacement

Primary sources checked during planning:

- The [etcd failure-tolerance table](https://etcd.io/docs/v3.7/faq/#what-is-failure-tolerance) requires both votes for a two-member cluster, tolerating zero failures; three members require two votes and tolerate one failure.
- The [Raft paper](https://raft.github.io/raft.pdf), sections 5.2 and 6, describes majority elections and membership changes.
- [etcd runtime configuration](https://etcd.io/docs/v3.7/op-guide/runtime-configuration/) requires current-cluster agreement for membership changes; dropping unreachable members on a timeout is not a safe replacement for that process.
- [etcd network-partition behavior](https://etcd.io/docs/v3.7/op-guide/failures/#network-partition) allows the majority side to progress and stops approvals on the minority side.

Planning inference: unexpected loss of one of two voting Macs cannot both preserve partition safety and allow the survivor to approve new work automatically. Graceful handoff differs from abrupt loss. A local saved replica can show history after all peers stop, but reopening history alone does not establish current approval authority. Product decisions on pool size, partition behavior, and recovery are required before selecting a replication protocol.

## Open product decisions

- Movable hosting and automatic replacement are confirmed. Pool size is 2–10 Macs, each retaining plans/history. New work waits during uncertain disconnections; already-active tasks continue. Approval authority after all-offline restart must follow the wait-for-coordination rule.
- Equal access with one shared password is confirmed.
- GitHub monitoring only is confirmed.
- New functions require a coordinated scope check after reconnecting; current offline scope remains reserved.
- One repository per workspace, minimal interface with both branch/commit and file/function visuals, and Apple Silicon hardware are confirmed. The proposed macOS matrix includes Sequoia 15, Tahoe 26, and macOS 27.
- Broad language coverage is desired, and non-overlapping functions in one file may be shared. Unreliable/unsupported parsing falls back to whole-file reservations. The precise initial verified grammar matrix remains a proposal.

## Desktop framework options researched

No framework is selected. The eventual proposal should account for interface expectations and the user's TypeScript/JavaScript preferences.

- [Electron](https://www.electronjs.org/docs/latest/) embeds Chromium and Node.js for a JavaScript/HTML/CSS desktop application. Planning inference: this allows UI, local coordination, and integration adapters to share TypeScript types. Its [notification documentation](https://www.electronjs.org/docs/latest/tutorial/notifications) describes macOS signing requirements that need to be included in distribution and notification verification.
- [Tauri](https://v2.tauri.app/start/) supports web frontends with native/backend logic in languages including Rust. Planning inference: it is an alternative to evaluate if native integration and package size justify another backend language or a sidecar.

## Concrete coordination implementation recommendation

Research recommendation: bundle an Apple Silicon Go helper using [HashiCorp Raft](https://github.com/hashicorp/raft), the [raft-boltdb v2 durable store](https://github.com/hashicorp/raft-boltdb/blob/master/v2/go.mod), and a file snapshot store. The [Raft API](https://pkg.go.dev/github.com/hashicorp/raft) covers restored state, staged voter catch-up, snapshots, leadership transfer, and manual recovery. The app still supplies its task state machine, authenticated transport, membership lifecycle, and recovery UX; Mac reliability requires runtime tests.

Packaged etcd was considered, but its [platform support matrix](https://etcd.io/docs/v3.7/op-guide/supported-platform/) classifies Darwin ARM64 as Tier 3. A dedicated helper is a product-fit recommendation, not a claim that it is already implemented or proven on Macs.

Proposed voting policy: each fully joined, synchronized Mac is an equal eligible voting member, with membership changed through the committed protocol. This is simple for 2–10 participants but needs six voters for a ten-member configuration. Online presence is separate from configured voting membership.

## Code parsing, GitHub, and OS support

- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) provides embedded syntax parsing with Node/Wasm bindings and many grammars. [Queries](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html) operate on grammar-specific node types. Inference: each claimed function adapter needs its own fixtures; the existence of a grammar alone does not prove correct symbol conflict detection.
- [GitHub pull request APIs](https://docs.github.com/en/rest/pulls/pulls) document read-only permissions for viewing PRs. Credential permissions should match observation-only behavior; the app should never call branch/PR creation or merge endpoints.
- [Apple's version list](https://support.apple.com/en-us/109033) identifies Sequoia as macOS 15, Tahoe as 26, and the following release as macOS 27. The requested compatibility matrix is explicit OS testing on Apple Silicon, not a list of chip marketing names.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) documents macOS Keychain-backed protection for local secrets. This is a candidate credential-storage mechanism; secrets must not be included in shared agent instructions, logs, or replication payloads.
