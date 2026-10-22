# Manual release acceptance

This is an execution plan, not a record of passing manual tests. Every unchecked
case below is **UNVERIFIED**. Record failures and unavailable equipment/clients;
do not substitute same-Mac processes for physical Macs or adapter tests for an
actual client session. Use a disposable GitHub repository and separate local
clones/branches. The app must remain observational toward Git and GitHub.

## Existing evidence

The project handoff reports these completed proofs for its current candidate:

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| 321 JavaScript/TypeScript tests | Tested validation, adapters, parsers, desktop controllers, storage fixtures and package inspection. | Actual client enforcement or physical LAN behavior. |
| Native race suite | Real Raft/TLS peers, lifecycle, durability and failure handling on one Mac. | Physical sleep, multicast, firewall or multi-Mac performance. |
| Ten-peer focused race test | Production-timer leader replacement, five-of-ten refusal and recovery of ten persisted local TLS peers. | Ten physical Macs, abrupt crashes or LAN performance. |
| Bundled MCP and real two-peer receipt integration | Packaged protocol path, native-issued signed receipt verification and tested offline revocation. | An agent client honoring hooks or two physical Macs. |
| Packaged UI checks on macOS 27 | Exercised desktop workflows, including task/conflict and persisted-state flows. | macOS 15/26, native notifications, real Keychain prompts or distribution trust. |
| Development ZIP inspection and extraction | Fifteen arm64 binaries, required assets, strict ad-hoc signature round trip and checksum. | Developer ID trust, notarization or an actual install on other OS versions. |

Preserve the original logs and candidate hash. Rerun `npm run check` for a changed
candidate; the historical count is not an acceptance result for another build.
See [desktop boundaries](desktop.md), [agent setup](agent-setup.md),
[native behavior](native-phase1.md), [symbol coverage](symbol-coverage.md), and
[PR lifecycle](task-pull-requests.md).

## Equipment and run matrix

Use the same arm64 candidate on every Mac. Record exact hardware and OS builds;
an M-series architecture target does not qualify untested chips. Use normal
installation and macOS permission flows, without disabling system protections.

| Run | Physical Macs | Required OS coverage | Available majority | New work must pause when |
| --- | --- | --- | --- | --- |
| P2-15 / P2-26 / P2-27 | 2 per run | Repeat with both Macs on 15, then 26, then 27. | 2 | Either voter is unavailable. |
| P3 | 3 | One each on 15, 26, 27; rotate the current leader. | 2 | Only one remains, or no partition has two. |
| P5 | 5 | Mixed fleet containing all three OS versions. | 3 | Three are unavailable, or no partition has three. |
| P10 | 10 | Mixed fleet containing all three OS versions. | 6 | Five are unavailable, including a 5/5 partition. |

Create a fresh workspace for each pool size; member removal is not an available
way to shrink a previous roster. Confirm all intended members are active voters
before failure tests. These runs qualify only their recorded OS/hardware mixes.
Run the client matrix below on **each OS version**. Wait up to 60 seconds per
recovery attempt and record elapsed time; retain a timeout as a failure to
investigate, not a reason to retry until the result appears successful.

## Physical Mac cases

- [ ] **L1 — Pair and discover.** Create on Mac A, select its real LAN interface,
  and join peers with the shared password after comparing public fingerprints
  directly. Check wrong password and wrong pin refusal, pending/nonvoter
  inability to register work, active membership on every Mac, and rejection of
  an eleventh enrolled identity in P10. Editing the reviewed invitation/pin must
  invalidate its previous confirmation.
- [ ] **L2 — macOS networking.** On each OS, exercise the normal local-network
  and firewall prompts if presented. First deny, then allow through normal
  settings: a Mac without a reachable majority must show unavailable new
  approvals; allowing must restore authenticated discovery/connection. Repeat with Bonjour
  multicast unavailable; a discovered name or changed address must never replace
  certificate trust. Record Wi-Fi/Ethernet, guest isolation and interface changes.
- [ ] **L3 — Keychain and installation.** On each OS, create, quit and reopen a
  workspace using real OS-backed profile encryption. Exercise any Keychain
  allow/deny/locked-session prompts that appear. Decryption failure must not
  produce plaintext storage, lost history or a fresh bootstrap. Repeat a normal
  update using the intended signing identity; signing/Keychain identity behavior
  remains unverified if only an unsigned development candidate is available.
- [ ] **L4 — Shared intent and conflicts.** On different Macs reserve different
  existing functions in one file, then propose the same function and a whole-file
  overlap. Check identical plan/task revisions and final conflicts everywhere.
  Both reachable agents must deny subsequent edits. A disappearing peer must
  retain its reservations; canceling one task must not silently restart another.
- [ ] **L5 — Native notifications.** With notifications allowed, put the app in
  the background and trigger L4 remotely. Check the macOS banner and the agent's
  terminal/app reason identify actionable conflicting work. Repeat with app
  notifications denied and with Focus enabled: record suppression, while the
  in-app conflict and next-tool refusal must still work. Do not count a rendered
  web banner as a delivered macOS notification.
- [ ] **L6 — Sleep, failover and partitions.** Sleep the current leader, then
  disconnect it separately. In P3/P5/P10, a surviving majority must eventually
  coordinate new nonoverlapping work; P2 must pause new approvals after one loss.
  Repeat the majority-loss boundary in the table, plus a 2/1, 3/2 and 5/5 split
  respectively. A minority/cached view cannot register or expand work. Wake and
  reconnect peers: histories converge without lost claims or duplicate tasks.
  Repeat through Wi-Fi off/on and an address/interface change.
- [ ] **L7 — All close and reopen.** Quit every app, rather than only closing
  windows. Reopen one saved profile first: history is visible but an old
  multi-voter roster grants no new authority. Open enough original peers for a
  majority; verify plan, repository binding, tasks, revisions, PR links and
  conflicts converge. Reopen the rest. No app may create a replacement workspace
  or shrink voters. Also force-quit one app and confirm its helper releases the
  database lock before reopening; do not delete state to make recovery pass.
- [ ] **L8 — Interrupted join.** Interrupt a join before activation, restart both
  sides and explicitly retry the saved enrollment with the reviewed pin/password.
  Verify the same device/request identity resumes once, without duplicate voters
  or approvals from a pending/failed attempt.

## Actual agent-client matrix

Use generated **project** snippets in the disposable clone, preserve existing
configuration, and follow normal human review/trust flows. Do not change global
settings, bypass trust or copy another native session context. The following
sessions have not been run by this checklist's author.

| Client | Required setup and known boundary | macOS 15 | macOS 26 | macOS 27 |
| --- | --- | --- | --- | --- |
| Codex | Project/exact hook reviewed through `/hooks`; observed CLI `0.163.0-alpha.10.2`. Specialized/hosted paths and later `write_stdin` can bypass hooks. See [native feasibility](codex-native-qualification.md). | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Claude Code | `PreToolUse` with `onFailure: "block"` needs **2.1.295+**. Previously observed `2.1.285` is version-blocked for that qualification. | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Cursor | Trusted IDE Agent workspace and `failClosed: true`; Cursor CLI/Tab are separate, unqualified surfaces. Previously unavailable locally. | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| OpenCode | Project `tool.execute.before` plugin; verify actual loading, native session ID, MCP names and thrown-error denial. Previously unavailable locally. | UNVERIFIED | UNVERIFIED | UNVERIFIED |

For **each client/OS cell**, record the actual version and execute C1–C7. Capture
native hook/tool events and before/after file hashes or Git diffs. An agent merely
saying it stopped, a normal permission dialog, or the model declining a request
does not prove that the coordination gate blocked an attempted edit.

- [ ] **C1 — Plan before writes.** Use actual MCP discovery, `read_plan`,
  `list_tasks`, `repository_status` and `list_symbols`. Before registration,
  attempt a native edit and prove denial with unchanged files; safe source reads
  must remain possible. Register the description, branch/base and intended scopes
  under the actual native session identity, then perform one allowed edit.
- [ ] **C2 — Scope proof and fallback.** Reserve `save` in a source file also
  containing `load`. Change only the interior of `save`, then attempt `load`, a
  function addition and a boundary/rename change: refuse the latter actions
  until fresh whole-file approval. Test the client's actual Edit/Write/MultiEdit
  paths where available. Codex `apply_patch` requires whole-file scope, including
  every add/delete/rename endpoint. Missing/ambiguous/unsupported symbols must
  visibly reserve the whole file. Check another clone/repository and a symlink
  cannot reuse the reservation.
- [ ] **C3 — Unsupported routes.** Attempt arbitrary shell, delegation/subagent
  creation and an unknown/specialized write tool against disposable marker files.
  Verify denial before execution and unchanged markers. Probe background commands,
  resumed commands and child-agent writes separately; an already-admitted process
  is not preempted by a later refusal. Any route that bypasses the hook remains
  explicitly UNQUALIFIED, even if the normal native edit test passed.
- [ ] **C4 — Trust and hook failures.** In the test project only, change the hook
  definition and exercise untrusted/disabled state, missing launcher, crash,
  malformed output and timeout. Re-review changed definitions through the normal
  client flow before testing trusted failure handling. A write proceeding on a
  required denial/failure is a failed qualification. Known skip/fail-open paths
  must be recorded as unqualified; do not silently bypass or re-trust to erase
  that result. Restore/review the original project configuration afterward.
- [ ] **C5 — Offline accepted scope.** Obtain a signed function-scoped acceptance online,
  then disconnect the Mac and separately quit the app. Existing accepted scope
  may continue; a new task, revision or function/file outside that reservation
  must wait. Malformed endpoint configuration must deny. While disconnected, commit
  a conflict/stop from reachable peers where quorum permits; reconnect and prove
  the next edit is denied. Disconnect again: the revoked receipt must stay denied.
  Do not expect an unreachable Mac to learn a remote stop before reconnecting.
- [ ] **C6 — Stop and resolution.** Trigger a remote overlap during an active
  session. Deny subsequent edits, keep coordination tools callable, and wait for
  admitted/background writes to finish before acknowledging stop. Cancel one
  owned task, revise the other at its current revision, and prove the old revision
  and a canceled context cannot edit. Repeat after client/app restart.
- [ ] **C7 — PR completion, both orders.** Link an existing PR in the bound
  repository and confirm acceptance refreshes after the task revision changes.
  Test completion-before-stop and stop-before-completion. Use tasks without prior
  merge evidence for negative checks: passing checks, closed unmerged PRs,
  mismatched PR/repository responses, unavailable/rate-limited GitHub, stale revision
  and a workspace switch during the check must not release claims. A merge while
  still active must retain them. Only editing-complete + stopped acknowledgement
  + a fresh exact linked-PR merge observation may complete/release the task.
  Any PR creation/merge is performed separately by the test operator; verify the
  app issued no GitHub writes and exposes no agent merge-assertion command.

## Evidence and disposition

Copy this record for every case/client/OS combination. Keep credentials, private
context contents, passwords and private profile material out of captured evidence.

```text
Case ID / UTC start and finish:
Candidate version / source revision or source manifest:
Distributable SHA-256 (or complete app-bundle manifest hash):
Participants: Mac label, exact model/chip, OS version/build, app hash:
Client: name/version, terminal or IDE surface, native session label:
Network: interfaces, subnet/isolation, firewall/local-network permission state:
Workspace: redacted label, configured voters, leader, observed authority:
Steps and injected failure / elapsed recovery time:
Expected result:
Observed result: task/revision/status, file hashes/diff, notification outcome:
Evidence paths: redacted transcript/screenshots/logs, before/after snapshots:
Result: PASS / FAIL / BLOCKED / NOT RUN
Failure or limitation / issue link / retest candidate and evidence:
Operator and reviewer:
```

An unavailable client, unsigned-distribution limitation or missing Mac is
BLOCKED/NOT RUN, never PASS. Support claims must name the verified OS, hardware,
client versions and tool surfaces. Leave unresolved bypasses and missing matrix
cells visible in the release decision.
