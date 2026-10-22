# GitHub Pages landing page and agent skill — proposed plan

Date: October 22, 2026

Status: Completed and published on October 22, 2026 after the user's approval.
The user selected `darrenyoungblood12345-a11y/pr-conflict-manager` and requested
the initial commit there. Read-only checks confirmed an empty public repository
and working push/administration access.

## Requested outcome

Create a public landing page for Agent PR Monitor on GitHub Pages, with a working
Apple Silicon macOS `.dmg` download and a downloadable skill that teaches agents
how to use the app. Approval of this proposal precedes implementation.

## Findings at planning time

- The current app version is `0.1.0`, targeting Apple Silicon with a declared
  minimum macOS version of 15.0. Actual packaged execution has been verified on
  this development Mac's macOS 27; other OS and physical multi-Mac acceptance
  remain open in `docs/acceptance-checklist.md`.
- `npm run dist:mac` currently produces an ad-hoc signed development `.app`, ZIP,
  SHA-256 checksum, and inspection report. There is no DMG artifact or DMG script.
- Production Developer ID signing and notarization are not configured. A new DMG
  will retain the app's development-build status; its container does not change
  the trust or qualification of the application inside it.
- This folder is not a Git repository and has no configured GitHub remote. The
  intended GitHub owner/repository must be supplied before publishing.
- The app has a dark forest/charcoal interface, pale green accents, serif
  headings, and monospace operational details. These provide the page's visual
  direction without inventing unrelated branding.
- The existing Agents screen generates private, session-specific integration
  setup. The MCP bridge exposes 12 tools; it has no task-command CLI. The skill
  must describe this actual interface rather than invent commands.

## 1. Landing page

Build a lightweight static site under `site/` using HTML, CSS, and minimal
JavaScript. Keep its output separate from the Electron application's `dist/`.
Use relative asset paths so the site works beneath a GitHub project-site path.

Proposed visitor flow:

1. A concise hero explaining coordination before agents' edits overlap, with
   **Download for macOS (.dmg)** as the primary action and **Download agent skill**
   as the secondary action. Show the version, Apple Silicon architecture, and
   development-build status next to the download.
2. An actual app screenshot captured with disposable demonstration data, showing
   the shared plan, task reservations, and branch/function activity. Exclude
   private workspace names, credentials, and local user paths.
3. A short workflow: create or join a workspace, connect each agent through
   Agents, then read the shared plan and register intended work before editing.
4. A dedicated skill section with the ZIP download, a raw `SKILL.md` link, and
   brief installation/use guidance. Explain that the skill teaches the workflow;
   per-session MCP/hook setup still comes from the app.
5. Download details and a compact FAQ covering architecture, installation,
   checksums, the current development status, and integration coverage. Describe
   the four available adapters without claiming completed real-client testing.

Match the app's existing forest/charcoal palette and pale green accent. Use a
large product image, readable typography, restrained motion, visible keyboard
focus, and responsive layouts. Ground feature claims in the current app and docs.

## 2. Real DMG artifact

Extend the existing Mac distribution workflow rather than creating a separate
app build. Produce a versioned development DMG, for example
`Agent-PR-Monitor-0.1.0-mac-arm64-development.dmg`, containing the inspected app
and an Applications shortcut for drag-to-install.

- Reuse the temporary staging approach that avoids Desktop file-provider
  metadata invalidating the app's signature.
- Use the macOS disk-image tools to create and verify the DMG. Mount the exact
  resulting image read-only and run the existing package inspection against the
  enclosed app; always detach and clean up temporary staging.
- Generate a SHA-256 checksum and inspection evidence for the exact DMG bytes.
- Smoke-test the app copied from the image on this Mac with an isolated profile.
- Keep the existing ZIP distribution available. Document the new command and
  the remaining signing/qualification limits in `docs/distribution.md`.

Production signing/notarization and completion of the physical-Mac/client/OS
acceptance matrix remain separate work. The page must describe the artifact
actually offered and give accurate installation expectations.

## 3. Downloadable agent skill

Maintain one canonical, self-contained
`skills/agent-pr-monitor/SKILL.md` with valid `name` and `description` frontmatter.
Offer both raw Markdown and a ZIP containing `agent-pr-monitor/SKILL.md`, generated
from that same source. Include no private session files or generated user config.

The skill will cover:

- Creating/reviewing setup in Agents for each actual native agent session,
  preserving existing client configuration, and discovering the MCP tools.
- Reading `read_plan`, `list_tasks`, `repository_status`, and `list_symbols`
  before proposing work; using the bridge's configured identity and current
  branch/base commit, plan revision, task revision, and qualified scopes.
- Using `submit_task` and `revise_task`, including the difference between a
  committed operation and an active task with current editing permission.
- Whole-file fallback for additions, removals, boundary changes, uncertain
  parsing, and Codex patches; no work outside accepted scope.
- Stopping on conflicts, waiting for already-running writes to finish before
  `acknowledge_stop`, and resolving work through revision or cancellation.
- Linking an existing PR through `link_pull_request`, reporting completion, and
  retaining reservations until stopped writes and a fresh observed merge permit
  release. The app observes GitHub; it does not create or merge PRs.
- Offline continuation only within already accepted scope with a valid receipt;
  new work and scope expansion wait for coordination.
- A concise reference to all 12 existing tools, including `set_plan` and
  `task_status`, with their revision and ownership requirements.
- Current gate limits, including unsupported shell/delegation routes and
  unqualified client surfaces. Never alter credentials, receipts, or hooks to
  bypass a denial.

Use the skill-creator validator and compare the instructions against current
schemas, generated project instructions, and integration tests. Provide concise
guidance for skill-aware clients and for supplying the Markdown as instructions
when a client does not load this skill format directly.

## 4. GitHub Pages and release wiring

Host the static landing page on GitHub Pages and the large DMG/checksum/report
as GitHub Release assets. The skill downloads can be served directly by the page.

- Add a GitHub Actions workflow that prepares and deploys only the site output
  using the standard Pages actions and required Pages environment/permissions.
- Keep release metadata in one small configuration source: repository, exact
  release tag, version, architecture, DMG asset name, checksum, and build status.
- Use explicit versioned release URLs so development prereleases work too.
  Avoid depending on a changing filename or an automatic latest-release lookup.
- Generate the site's downloadable skill copies from the canonical skill and
  check configured release links and artifact metadata before deployment.
- Package binaries locally on the Apple Silicon Mac. The Pages workflow does not
  need to rebuild the Electron application or expose Apple signing credentials.
- Once the user has approved this scope and identified the destination
  repository, initialize/link Git as needed, upload the verified release assets,
  enable Pages, deploy, and verify the live URLs within that authorization.
  Resolve repository visibility/source-publication expectations before publishing
  if they are not clear from the chosen destination.

Expected changed/new areas: `site/`, `skills/agent-pr-monitor/`, the Pages
workflow, focused site/skill packaging and DMG scripts, relevant distribution
tests, package scripts, and usage/distribution documentation.

## 5. Verification and acceptance

- [x] Review the rendered page at desktop and mobile sizes and verify keyboard
  navigation, focus, text contrast, and absence of broken relative paths.
- [x] Download the skill through the local site, unpack it, and verify it matches
  the canonical validated skill with no private data or user-specific paths.
- [x] Check the skill against the real MCP schemas and task/PR lifecycle. Exercise
  a disposable protocol example without claiming commercial-client qualification.
- [x] Build, verify, mount, inspect, and smoke-test the exact DMG; validate its
  checksum and confirm its contents retain the expected app signature/resources.
- [x] Run focused tests for new distribution/site packaging behavior and the
  existing required app checks if distribution/application build inputs change.
- [x] Confirm the release asset URLs return the expected versioned files and the
  published GitHub Pages site serves both requested downloads.
- [x] Record evidence and remaining qualification limits in `tasks/todo.md` and
  the relevant docs. Report a live URL only after deployment is verified.

## Approval and destination

The user approved this scoped plan and supplied the public destination
`darrenyoungblood12345-a11y/pr-conflict-manager`, requesting its initial commit.
The initial commit is `9b458a8`; the development release is
`v0.1.0-development`. The published landing page is
<https://darrenyoungblood12345-a11y.github.io/pr-conflict-manager/>.
Verification evidence and the remaining product qualification limits are
recorded in [todo.md](todo.md).

## Planning review

Read-only inspection covered the current README, package scripts, Mac packaging
and inspection code, app styling, agent setup documentation, integration schemas,
MCP tool registration, and task/PR lifecycle. An independent read-only agent
review checked the proposed skill against the existing integration contract.
No runtime tests were needed for this documentation-only planning change.

GitHub workflow and release-link behavior were checked against the official
[Pages custom-workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
and [release-link documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).
