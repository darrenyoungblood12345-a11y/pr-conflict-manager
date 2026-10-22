---
name: agent-pr-monitor
description: >-
  Coordinate repository work through the Agent PR Monitor macOS app and its MCP
  tools: read the shared plan, reserve files or functions, resolve blocked work,
  and track task completion through an observed PR merge. Use when the app is
  part of the user's agent workflow.
---

# Agent PR Monitor

Use the app's `agent_pr_monitor` MCP server to coordinate the selected local clone with other agents. Each Mac keeps its own clone and branch. Reservations coordinate intended work; they are not filesystem locks or a substitute for code review.

## Connect through the app

If the tools are missing, direct the user to create, join, or reopen the workspace in **Workspace pool**, select this Mac's clone in **Worktree**, and open **Agents**. Prepare a separate setup for the actual running session using its native session ID: Codex/Claude Code `session_id`, Cursor `conversation_id`, or OpenCode `sessionID`. The app does not capture or invent that ID.

Use the MCP/hook snippets and instructions generated there. They must be reviewed and merged into existing project configuration, preserving other servers, rules, and hooks. Do not install software, replace configuration, or fabricate endpoint/session files as part of using this skill. Keep private endpoint credentials and session-context contents out of prompts, logs, repositories, and shared history; leave task bindings, receipts, and revocation fields under the bridge's control.

Use the client's actual exposed tool names; they may include a server prefix such as `mcp__agent_pr_monitor__read_plan`. There is no task-command CLI. The app supplies adapters for Codex, Claude Code, Cursor IDE Agent, and OpenCode, but detection or generated setup does not prove enforcement in the installed client. Follow the Agents panel's version and trust notices. In particular, Codex needs the exact project hook trusted through `/hooks`; Cursor Tab/CLI are outside the IDE Agent adapter.

## Plan and reserve before editing

1. Call `read_plan` and `list_tasks`. Read the requirements, current plan revision, other tasks' intent and actual scopes, conflicts, and stop acknowledgements. Use the returned `identity.ownerId`, `identity.sessionId`, and `identity.agent` unchanged for your task.
2. Call `repository_status` to inspect the selected clone's branch, HEAD, origin, and existing changes. Do not invent a branch or base commit, overwrite unrelated changes, or claim another repository's reservation. LAN workspaces bind immutably to one canonical GitHub.com repository; separate clones/branches of that repository are allowed.
3. Inspect relevant files with `list_symbols({ path })` or the client's supported bounded native `Read`/`Glob`/`Grep`. Use explicit safe source paths or subtrees. These planning reads can remain available before registration and while blocked; arbitrary shell commands are not a read-only exemption.
4. Describe the intended change, affected existing functions, additions/removals, shared interfaces, and verification needs. Declare every path the proposed edits will touch. Submit the complete proposal through `submit_task({ task })` using the current plan revision and the observed branch/base commit.
5. Inspect the resulting task, canonical scopes, and `scopeWarnings`. New editing requires a fresh accepted response with `hasAuthority: true`, `editingAllowed: true`, matching owner/session/agent and proposal, a current revision, `status: 'active'`, `stopAcknowledged: false`, and no conflicts. The bridge binds that acceptance into the private context; the native gate checks current permission again before each covered action.

`ok: true` only means the operation committed. An overlapping registration can return success with a **blocked** task and can block an existing task too. A historical acceptance, cached state, or a later `task_status` read never refreshes editing permission. If the plan or task revision changed, reread it and use the current revision rather than blindly retrying.

The task proposal has this shape; supply actual observed values, not the illustrative values below:

```json
{
  "id": "unique-task-id",
  "ownerId": "identity-from-read-plan",
  "sessionId": "actual-bound-session-id",
  "agent": "codex",
  "branch": "observed-branch",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "description": "Describe the intended behavior, affected code, and verification.",
  "planRevision": 1,
  "scopes": [
    { "path": "src/example.ts", "kind": "file" }
  ]
}
```

Use a unique identifier of at most 128 characters with letters, numbers, `_`, `.`, `:`, or `-`, beginning with a letter or number. The allowed agent values are `codex`, `cursor`, `opencode`, and `claude-code`. Paths must be unambiguous repository-relative paths with `/` separators; do not use absolute paths, traversal, symlink aliases, or agent/Git control files. Whole-file scopes omit `symbol`. A symbol scope is `{ "path": "src/store.ts", "kind": "symbol", "symbol": "Store.save" }`, using the exact unique qualified name returned by `list_symbols`.

## Match the reservation to the edit

- Supported native `Edit`, `Write`, and `MultiEdit` payloads can use symbol scope only when the actual change is proven strictly inside the same uniquely parsed existing function in both source versions. Class headers and changes spanning sibling functions do not pass that proof. Split independent interior edits or reserve the whole file.
- New files/functions, function additions/deletions/renames, function boundary changes, unsupported languages, syntax errors, and missing or ambiguous symbols require whole-file reservations. Submission can widen an unqualified symbol to a file scope; inspect the committed scope and conflicts rather than assuming a narrow grant. Unsafe paths are refused.
- Codex `apply_patch` requires whole-file scope for every add/update/delete/rename path, including both rename endpoints. A symbol claim does not authorize a Codex patch.
- Coordinate additional paths or broader scope **before** editing them. Stop all admitted/background writes, acknowledge the stop, reread the plan and task revision, and use `revise_task` with a complete replacement proposal. Retain task/owner/session/agent identity. A revision clears the previous PR link and merge evidence; inspect the fresh acceptance before resuming.

Arbitrary shell, delegation, unknown tools, and unrecognized edit payloads are denied even for active tasks. Do not route an edit through another tool, session, disabled hook, or modified context to bypass a refusal. Explain an unsupported verification or Git operation to the user; a reservation does not make that operation supported by the adapter. Already-running commands and external processes are not stopped by a gate denial.

## Handle a block or stop

Stop subsequent edits immediately when a gate refuses work, the task becomes blocked, or permission is stale. Use `task_status`, `read_plan`, and `list_tasks` to identify the current task revision, overlapping task IDs/owners, and scopes. Explain the exact conflict and affected paths to the user. Coordination tools remain available.

Wait for all already-admitted commands, background writes, and any previously delegated writers to finish or be stopped before `acknowledge_stop`. A pause request or tool denial is insufficient evidence. Acknowledgement is a durable stop, changes the task revision, and invalidates old local acceptance. Use the returned current revision for the next mutation.

Resolve your owned task by revising to coordinated scope or cancelling it after acknowledgement. Do not mutate another session's task, claim that the other owner stopped, or cancel someone else's reservation. Removing a conflict does not itself refresh permission: obtain a fresh accepted revision before resuming. Completed/cancelled tasks cannot resume; submit a new task if more work is needed.

## Work while disconnected

Already accepted LAN work may continue only when the native gate verifies the existing saved signed receipt for the exact workspace, device, repository, owner/session/agent, task revision, and reservation. `offlineContinuation: true` on an acceptance reports receipt availability; it is not a promise that later actions will be admitted. Do not create, copy, edit, or renew receipts yourself.

New tasks, revisions, PR links, plan changes, and scope expansion wait for fresh coordination authority. Local contexts without a valid receipt fail closed. A missing endpoint after app closure or genuine connection/quorum loss may qualify for receipt use; malformed configuration, authentication failures, and invalid responses do not. Observed stops, conflicts, cancellations, and incompatible revisions durably revoke old permission, even from an observation without quorum. An offline Mac cannot learn a new remote stop until reconnecting; retain the accepted reservation and do not promise immediate remote interruption or release.

## Finish and track the PR

Use the normal authorized Git/PR workflow for commits, pushes, PR creation, review, and merge; this coordination service performs none of them, and its adapter may refuse those tools. Link an **existing** PR with `link_pull_request` using the exact PR number in the workspace's bound repository. Linking changes the task revision and refreshes acceptance only if it remains active and eligible; reread the response before further edits. Replacing a link requires stopped-write acknowledgement and clears old merge evidence.

When editing is finished, call `report_completion`. Wait for all admitted/background writes to stop, then call `acknowledge_stop` with the current revision. Refresh `task_status` between mutations as necessary; lifecycle mutations can change the revision. If already acknowledged, report completion at that latest revision without resuming edits.

The reservation is released as completed only when editing completion, owner stop acknowledgement, and the app's verified observation of that exact linked PR's merge are all present. In the app's **Task details**, **Check GitHub** performs that observation. Passing checks, a closed unmerged PR, a cached PR list, or an agent's claim of a merge cannot release the scope. There is no agent-callable merge-assertion tool. Confirm `task_status` is `completed` before reporting the reservation released. To abandon work instead, acknowledge stopped writes and call `cancel_task` at the current revision.

## MCP tool reference

The server exposes exactly these 12 tools. Discover their live schemas; use the argument shapes below rather than inventing commands. `owned` means `{ taskId, ownerId, expectedRevision }` for this bridge's own task and its **current** revision.

| Tool | Arguments and effect |
| --- | --- |
| `read_plan` | `{}`; shared plan, authority, and configured identity. |
| `list_tasks` | `{}`; all task intentions, reservations, revisions, and conflicts. |
| `repository_status` | `{}`; selected clone's local Git observation; no fetch or writes. |
| `list_symbols` | `{ path }`; qualified function/container names and ranges for one safe source file; no reservation. |
| `task_status` | `{ taskId }`; current state and authority; does not refresh acceptance. |
| `set_plan` | `{ expectedRevision, markdown }`; replace the shared plan only when the user's task calls for it, preserving approved requirements. |
| `submit_task` | `{ task }`; register the full proposal; may commit as blocked. |
| `revise_task` | `{ ...owned, task }`; full replacement proposal after stopped-write acknowledgement. |
| `link_pull_request` | `{ ...owned, number }`; link an existing positive PR number; no GitHub mutation. |
| `acknowledge_stop` | `owned`; confirm all admitted/background writes have actually stopped. |
| `report_completion` | `owned`; editing finished; reservation held pending safe release. |
| `cancel_task` | `owned`; abandon owned work after stopped-write acknowledgement. |
