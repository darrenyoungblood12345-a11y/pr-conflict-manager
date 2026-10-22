# LAN agent collaboration app — planning

## Status

The user approved the plan on October 20, 2026. Implementation is authorized, beginning with phase 1 feasibility and compatibility proof.

## Confirmed requirements

- Build a macOS app with a visual interface.
- Allow multiple computers to connect over a LAN using a password.
- Provide a shared project workspace with documentation.
- Each participating computer has its own local Git clone or repository copy, starts from the main branch, and creates a separate branch for its work.
- The workspace model uses separate local repositories rather than multiple computers editing one physical working folder.
- The first release must support Codex, Cursor, OpenCode, and Claude Code.
- People run agents themselves in their existing terminal or app on their own computer.
- Agents are pointed at the collaboration app to check for potential PR conflicts before starting work.
- The collaboration app does not launch or manage agent execution in the first release.
- Before work, the user prompts their agent to read the app's shared plan and document its intended work to avoid conflicts.
- An agent's proposed work includes a good task description and function-level detail about what it will add or change; exact line-level edits are not required.
- When proposed work overlaps, both affected agents should stop and notify their users through the collaboration app or their agent's terminal/CLI interface.
- Both the user and an agent can create the shared project plan.
- Each affected user resolves overlapping work by asking their agent to abandon its plan or revise its approach around the other work.
- Repositories and pull requests are hosted on GitHub.
- All participating computers are Macs.
- The workspace can move between Macs; any Mac should be able to open the workspace.
- If the current host sleeps or disconnects, it leaves the pool and another participating Mac should automatically take over hosting.
- One shared password gives all participants equal access; no host/admin permission tier is requested.
- GitHub integration is observational: display what is happening without creating branches, opening PRs, or merging them.
- Support a participating pool of 2–10 Macs.
- During an uncertain disconnection, new agent work waits until authoritative coordination is restored rather than continuing with possible overlapping approvals.
- Every joined Mac saves shared plans and task history locally so a previously joined Mac can reopen the saved workspace after everyone closes the app.
- A loss of coordination blocks new tasks only; already-active agents may continue their existing work.
- Each workspace supports one GitHub repository for the first release.
- Function-level detection should cover as many programming languages as practical. If reliable function parsing is unavailable, reserve the whole file.
- Two agents may change different functions in the same file when their work does not overlap.
- The interface should be minimal, with Claude Code as a style reference, and include both a Git branch/commit graph and a file/function tree showing agent activity.
- Target Apple Silicon Macs (arm64) across M-series models rather than requiring Intel support.
- Include macOS Sequoia 15, Tahoe 26, and macOS 27 in the proposed compatibility matrix; Sequoia is the requested one-release-before-Tahoe baseline.
- Support both public and private GitHub repositories.
- Offline active tasks retain their existing function/file reservations; any additional functions require a new check after reconnecting.
- Support agents cooperating and announcing intended changes.
- Help prevent overlapping changes and conflicts when merging pull requests.
- Clarify requirements with the user rather than assuming product behavior.
- Submit the project plan and request approval before implementation.

## Planning checklist

- [x] Inspect the current project folder and existing instructions.
- [x] Clarify the working-copy model: a local repository and separate work branch on each computer.
- [x] Clarify supported agents and where they run.
- [x] Clarify the detail required in proposed agent work.
- [x] Clarify the desired overlap response: both affected agents stop and users are notified.
- [x] Clarify who can create the shared plan and how users resolve overlapping work.
- [x] Confirm the repository provider and participating platforms: GitHub and macOS.
- [x] Confirm equal password access, automatic host replacement, and read-only GitHub scope.
- [x] Confirm pool size, local replicated history, and waiting during uncertain disconnections.
- [x] Clarify already-active tasks during disconnection: they continue; new tasks wait.
- [x] Confirm one-repository scope, non-overlapping function sharing, minimal UI, and Apple Silicon target.
- [x] Clarify worktree visualization, language fallback, offline task reservations, and macOS targets.
- [x] Specify proposed approval authority after all-offline restart consistently with the wait-for-coordination rule.
- [x] Research documented pause/notification mechanisms for each agent and require runtime proof after approval.
- [x] Record conflict coordination and Git/PR responsibilities; label additional lifecycle/notification rules as proposals.
- [x] Record supported computers, access control, and hosting lifecycle.
- [x] Record first-release scope and interface expectations for plan review.
- [x] Research technical options against the confirmed requirements.
- [x] Write the proposed architecture, milestones, and verification criteria.
- [x] Review the plan for internal consistency and distributed/agent-enforcement limits.
- [x] Submit the complete plan for explicit approval.
- [x] Receive approval before starting implementation.

## Phase 1 implementation

- [x] Inspect installed runtimes and supported agent clients.
- [x] Initialize the TypeScript/Electron workspace and pin dependencies.
- [x] Implement the durable Go/Raft coordination harness and failure tests.
- [x] Implement task scopes, atomic conflicts, stop acknowledgements, and stale-retry protection.
- [x] Implement the common MCP interface and four client gate adapters.
- [ ] Exercise the protocol against installed clients; report unavailable clients honestly.
- [x] Build a minimal desktop feasibility interface and arm64 package.
- [x] Verify secure local transport/pairing approach and document remaining LAN/OS tests.
- [x] Run focused tests/type checks/build and record phase 1 results.

## Continued implementation

- [x] Observe a selected local Git repository without changing it.
- [x] Display actual commit ancestry, branches, and working-copy changes.
- [x] Observe GitHub branches, PRs, and checks through GET-only requests, with explicit stale/error states.
- [x] Load real Tree-sitter grammars and qualify function extraction with language fixtures.
- [x] Validate declared scopes against the local repository and fall back to whole-file reservations.
- [x] Add authenticated LAN transport, safe enrollment, and leader forwarding.
- [x] Exercise multi-peer membership, loss of quorum, host replacement, and restart recovery in native loopback tests.
- [x] Add workspace creation/joining and local clone mapping to the desktop interface.
- [x] Add private per-session setup and reviewable snippets without editing existing agent configurations.
- [x] Bind one GitHub repository to each shared workspace and reject mismatched clones.
- [x] Verify signed accepted-task receipts for offline work within existing scope.
- [x] Link tasks to exact PRs and record GET-only verified merge observations before releasing stopped, completed work.
- [x] Verify native-issued receipts through the built Node gate, including disconnect and revocation behavior.
- [ ] Qualify actual installed agent clients and offline accepted-scope continuation.
- [ ] Verify desktop editor/task workflows, signing/distribution, and the remaining OS matrix.

## October 22 verification and distribution

- [x] Exercise the maximum ten-peer pool, coordinator loss, safe majority behavior, and recovery with real local native peers.
- [x] Inspect packaged Mach-O architecture/deployment targets and required runtime resources without developer tooling dependencies.
- [x] Add reproducible local distribution output and a clear physical-Mac/client acceptance checklist.
- [x] Run the new focused checks, rebuild the development package if needed, and record evidence and outstanding release prerequisites.

## Reusable planning skill

- [x] Draft a general requirements-interview and plan-approval workflow from this conversation.
- [x] Validate its metadata and behavior for new projects, clarification-only replies, and existing approval.
- [x] Install the completed skill in the personal Codex skills directory and provide its invocation.

Skill review: `plan-with-approval` passed the bundled skill validator and an
independent three-scenario behavioral pass. New projects elicited requirements;
discovery answers did not authorize implementation; an explicit prior approval
allowed a later continuation to implement and verify the approved fixture.
Installed three verified matching files under `/Users/darren/.codex/skills/plan-with-approval`.

## Historical planning review

- The project folder was empty at inspection and is not yet a Git repository.
- The complete proposal is in `tasks/project-plan.md`; the user subsequently approved implementation.
- The intended entry point is a user-prompted shared-plan review followed by documented proposed work. Native gates, scope revision checks, and observational PR checks are specified in the proposal.
- Both-agent stopping is requested; the plan distinguishes committed blocking, next-tool enforcement, stop acknowledgement, and unreachable agents. Runtime compatibility remains a post-approval verification requirement.
- At plan submission, no application code had been written and no dependencies had been installed.
- Official-documentation research for all four agents is recorded in `tasks/planning-research.md`; runtime compatibility checks will require post-approval implementation.
- Offline reservation retention, scope checks after reconnection, both worktree visualizations, whole-file fallback, public/private repositories, and macOS 15/26/27 are now confirmed.
- Proposed implementation choices are explicitly labeled, including Electron/TypeScript plus a native Go/Raft helper, equal voting membership, credential setup, initial parser matrix, and distribution.
- Plan review addressed offline task reservations surviving PR merges, stop acknowledgements before release/revision, intermediate versus final concurrent-registration states, interrupted membership changes, and stale acceptance retries.
- The initial inventory contained only planning Markdown files. Implementation and verification began after approval.
- The user explicitly approved implementation. Phase 1 is now in progress; all later milestones remain subject to its compatibility gate.

## Phase 1 verification notes

- Host: Apple Silicon arm64, macOS 27.0.1; Node 26.2.0 and temporary checksum-verified Go 1.27.3.
- Installed clients: Codex 0.163.0-alpha.10.2 and Claude Code 2.1.285. Cursor and OpenCode are absent. Claude's documented fail-closed hook mode needs a newer version; native-client qualification remains open.
- Dependencies are pinned; the current package tree reports zero known npm vulnerabilities after replacing unnecessary packaging dependencies with Electron's official packager.
- Completed phase 1 check: 107 TypeScript tests, native Go race suite, and six actual native/MCP integration checks passed. Coverage included loopback quorum failures, atomic conflicts, stale retries, Unicode identity boundaries, bounded durable state, and parent-process death.
- Cross-language checks pass auth rejection, function-scope conflict outcomes, merge retention, actual stdio MCP context binding, and restart without losing reservations or replacing the persisted voter roster.
- Built an arm64 `.app` with minimum OS 15. The overview renders and its local coordinator reports fresh authority; UI automation currently loses its window handle before editor interactions, so that workflow remains unverified.
- Phase 1 did not qualify LAN enrollment/peer TLS, parser-backed edits, or offline receipts. Later implementation is tracked below; physical multi-Mac/client/OS release tests remain distinct.

## Continued implementation review

- Repository fixtures prove linked worktrees, newline rename paths, detached commits, disabled fsmonitor execution, and an unchanged Git index. GitHub requests are GET-only, bounded, redacted, and explicitly stale on failure.
- Fourteen real Tree-sitter grammars load. Parser and integration tests prove conservative scope fallback, interior-function edits, sibling/boundary refusal, and copied-asset ESM/CommonJS startup without development node_modules.
- Native LAN race tests passed pinned enrollment, mTLS actor/request ownership, follower forwarding, three-voter host replacement, two-voter quorum loss, endpoint changes, and interrupted membership recovery. These are processes on one Mac, not physical multi-Mac qualification.
- Desktop profiles use Keychain-backed encryption, private atomic files, per-workspace endpoint paths, and creation-only bootstrap. Join retries preserve device/request identities and do not persist plaintext passwords.
- The October 21 test environment reset cleared temporary tools. The official checksum-verified compiler and caches now live under ignored `.local/tools`; `npm run setup:go` reproduces setup.
- The complete check passed strict typechecking, the build, 306 TypeScript tests, the native race suite (48.3 seconds), and seven native/MCP protocol tests. The added real two-peer LAN receipt suite passed five tests twice and is included in `npm run check`.
- Actual packaged UI checks on macOS 27 verified plan editing, clone selection, observed commit ancestry, same-file independent functions, both-task overlap blocking, stop/cancel/revision, and persisted restart recovery. Private launcher/context files and actual stdio MCP startup also passed. The earlier phase 1 window-handle limitation is resolved.
- The rebuilt packaged app also verified immutable repository binding, observed branch/HEAD defaults, exact PR linking, unavailable-PR reservation retention, and stop/completion retention pending merge. The packaged launcher exposes all 12 MCP tools without a merge-assertion tool.
- Real native LAN peers and bundled MCP/hooks proved native-issued receipt interoperability, offline exact-function editing admission, denial for other functions/origins/signature changes, restart recovery, and durable revocation after a fresh conflict and subsequent disconnect. These fixtures do not invoke commercial clients or edit the source file themselves.
- Final focused review found and fixed a stop-first completion dead end and made command errors visible inside task/proposal dialogs. The last package recheck covers that sequence. Signing, physical multi-Mac behavior, other OS versions, and manual real-client hook trust remain separate release gates.

## October 22 evidence

- The user confirmed that only this Mac is available. Physical multi-Mac acceptance is unverified; local peers do not substitute for that evidence.
- The new ten-peer race test passed in 33.65 seconds with production Raft timers. Ten persisted TLS peers demonstrated device ownership/forwarding, majority leader replacement, atomic conflicts, five-of-ten refusal, six-voter recovery and convergence of all ten saved replicas.
- Fifteen package-inspection tests passed. Actual inspection found fifteen arm64 native binaries (all declare minimum macOS 13.0), an outer minimum OS 15.0, all external CLI/parser assets, safe framework aliases, and no prohibited private/development paths. Deployment declarations do not qualify actual macOS 15/26 execution.
- Repackaging originally left an invalid inherited resource signature. The development pipeline now explicitly ad-hoc signs nested code/resources and fails on signing errors. Its JIT-only entitlement and development runtime configuration were checked; publicly trusted Developer ID signing/notarization remain unavailable and unqualified.
- This Desktop workspace’s file provider adds signing-incompatible FinderInfo to `.app` directories after output. Distribution stages built bytes/modes/symlinks outside provider storage, verifies strict signatures, archives, extracts and verifies the exact ZIP again. No source xattrs or system security settings are changed by that workflow.
- Published local development ZIP, SHA-256 checksum, and portable inspection report. The archive checksum and strict signature round trip passed. A fresh isolated signed-app launch, coordinator authority, twelve MCP tools, Electron Node mode, and actual bundled function parsing passed on this Mac.
- Manual physical-Mac/OS/client steps and evidence templates are in `docs/acceptance-checklist.md`; development packaging and public-release prerequisites are in `docs/distribution.md`.
- Final October 22 `npm run check` passed: typecheck/build, 321 JavaScript/TypeScript tests across 34 files, the complete Go race suite including ten peers (80.5 seconds), seven native/MCP protocol tests, and five real LAN receipt tests. The development ZIP checksum is `5695a3a4697c66a9890d472c9c5f490fa075c99cdb9850e66bcfe5d495cbbb8d`.

## GitHub Pages landing page and downloadable skill — complete

The user requested a plan and explicit approval before implementation of this
new scope. The detailed proposal is in [landing-page-plan.md](landing-page-plan.md).

- [x] Inspect the app's current branding, integration workflow, release artifacts,
  and repository/deployment setup.
- [x] Independently review the proposed skill against actual MCP tools and task
  lifecycle requirements.
- [x] Write the proposed site, DMG, skill, publishing, and verification plan.
- [x] Receive the user's approval to implement the plan (October 22, 2026).
- [x] Confirm the intended GitHub owner/repository and working publishing access.
- [x] Build the responsive static landing page and product screenshot.
- [x] Create and validate the canonical agent skill and its downloadable files.
- [x] Add verified DMG packaging, checksums, and distribution documentation.
- [x] Configure GitHub Pages deployment and versioned release download links.
- [x] Run the planned checks, publish within the approved scope, and verify both
  downloads from the live page.
- [x] Record final implementation evidence and remaining limitations here.

Planning review: the current artifact is a development ZIP, not a DMG; this
folder is not a Git repository and has no remote. The proposal preserves the
development-build status and existing integration boundaries. Only planning
documents were changed before approval; no runtime checks or external mutations
were performed for this planning step.

Implementation review (before initial publication):

- The user approved this scope and selected the empty public repository
  `darrenyoungblood12345-a11y/pr-conflict-manager`, explicitly requesting its
  initial commit. Git was initialized on `main` with that origin.
- The static page uses the app's existing palette, an actual built-renderer
  capture backed by an isolated fictional workspace, responsive layouts, and
  ordinary installer/skill links. Browser QA passed at 1280px and 390px with no
  horizontal overflow, an image loaded, no unresolved metadata, and no browser
  warnings/errors. Keyboard skip navigation reached the main fragment.
- The canonical skill passed skill-creator validation and a blocked-task
  scenario review. The site emits both raw Markdown and a ZIP containing only
  `agent-pr-monitor/SKILL.md`; the ZIP downloaded through the browser.
- DMG creation now validates canonical mount paths (including the macOS
  `/var`/`/private/var` alias) while retaining exact attach/device evidence. An
  actual DMG passed compressed-image verification, mounted app/signature/resource
  inspection, Applications-link verification, checksum verification, and detach.
  One transient `hdiutil create` resource-busy failure did not recur; no retry
  workaround or security setting changes were introduced.
- The DMG is 142,312,823 bytes, SHA-256
  `18b1194f46d62b48a351ce0bab4e29152ff925b569179f8f175d19f9de2cfdfd`.
  It remains an ad-hoc signed development build without notarization.
- `npm run check` passed typecheck/build, 339 JavaScript/TypeScript tests across
  36 files, the complete Go race suite (84.7 seconds), seven native/MCP protocol
  checks, and five LAN receipt checks. The final focused distribution suite
  covers metadata/refused links, artifact evidence, image cleanup, and mount aliases.
- Both production and local site builds passed. Production deployment verifies
  remote DMG size, checksum, and matching inspection evidence before publishing.
  The installer lives in GitHub Releases; only the small page/skill output is
  uploaded as the Pages artifact.

Publication and final verification:

- Initial commit `9b458a8751508f770e01e02ec7643df2b566ae9a` was pushed to `main`
  using the account's GitHub noreply author address. The public prerelease is
  <https://github.com/darrenyoungblood12345-a11y/pr-conflict-manager/releases/tag/v0.1.0-development>.
  All eight assets uploaded successfully; GitHub's independently reported DMG
  digest matches the verified local SHA-256 above. The alternate ZIP digest
  matches its previously verified development artifact as well.
- A copy from the exact DMG passed isolated bundled-runtime checks after the
  image was detached: strict signature and all fifteen native binaries, bundled
  Electron/Node startup, native coordinator authority and 401 auth refusal,
  actual stdio MCP discovery of all twelve tools, and all fourteen packaged
  parsers with expected symbols. A function-qualified task was accepted and
  bound to the correct private session/revision. No UI or commercial client was
  launched for that packaged-runtime smoke; it is distinct from the actual
  renderer screenshot and from outstanding client/physical-Mac qualification.
- The initial release-triggered Pages build passed, but its deployment was
  rejected by the default main-only environment rule. The environment retains
  `main` and now permits `v*-development` tags. The corrected deployment
  succeeded: <https://github.com/darrenyoungblood12345-a11y/pr-conflict-manager/actions/runs/39831521108>.
- The live page returns HTTP 200 at
  <https://darrenyoungblood12345-a11y.github.io/pr-conflict-manager/>. Its CSS,
  JavaScript, screenshot, icon, release links, raw skill, and ZIP were checked
  from that project-site URL. Both skill formats byte-match the canonical skill
  (`74b8321316d527ccfa84e8b6d2013ea43a0df80576dca5201a8c3c76f2473820`).
  Public DMG size/checksum/inspection-report verification passed. Keyboard skip
  navigation focuses `MAIN`; the rendered page has been opened for the user.
- The final focused distribution run passed 33 tests. No app functionality or
  signing/OS/client support claims were expanded. Developer ID/notarization and
  the acceptance matrix remain the development release's stated limitations.
