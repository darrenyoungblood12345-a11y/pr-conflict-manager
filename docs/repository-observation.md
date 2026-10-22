# Read-only repository observation

## API contract

`inspectRepository(selectedRoot)` in `src/repository/local-git.ts` returns a
`RepositorySnapshot`: canonical root, optional origin, current branch/head,
dirty paths and rename sources, local/remote branches, a bounded actual commit
graph, observation time, and limits. Select the repository/worktree root itself;
a subfolder cannot silently expand observation into a parent repository.
The graph is topologically ordered and includes detached HEAD when present.
Its maximum is 100 commits; `commitsAtLimit` indicates that more may exist.
HTTP/SSH origin credentials and query strings are removed before returning it.

`observeGitHubRepository({ owner, repo, token?, previous? }, fetchImpl?)` in
`src/repository/github.ts` returns a `GitHubSnapshot` for one GitHub.com
repository. It observes repository identity, branches, recent PRs, check runs,
and commit-status contexts using GET requests only. Its injected fetch supports
offline tests. The token is a function argument and never appears in returned
snapshots, error text, or replicated history.

The shared types live in `src/repository/types.ts`. Electron wiring is separate
from this module: no renderer receives GitHub credentials or executable paths.

## Safety and bounded observations

Local inspection uses `execFile` without a shell, optional locks disabled,
fsmonitor/hooks disabled, a timeout, and an output limit. It never fetches,
checks out, stages, commits, or modifies repository configuration. File paths
are parsed from NUL-delimited Git output, including whitespace/newlines and
rename source/destination pairs. Git worktrees with a `.git` file are supported.

GitHub requests use fixed `https://api.github.com` URLs with encoded owner,
repository, and ref components, redirect rejection, bounded pages/response size,
and timeouts. Fine-grained credentials remain local. Public requests omit the
authorization header. Missing permissions, rate limits, inaccessible resources,
and network failures are unknown states; they are never reported as passing
checks or clean mergeability. A previous observation can be retained with an
explicit stale flag and its last successful time.
Native fetch uses an eight-second per-request timeout and a thirty-second
overall observation deadline. Responses are capped at four MiB each.

Branch/PR lists and checks are bounded, with truncation/coverage recorded in the
snapshot. Individual check/status failures stay attached to the affected commit;
they do not erase otherwise useful repository data. This module does not decide
whether a reservation is safe to release or whether a branch can merge.

Limits are two pages of 100 branches and recent PRs (PR state `all`, newest
updates first), plus the first 10 distinct open-PR heads. Each observed head
includes up to 100 latest check runs and 100 status contexts. Pagination is
reported explicitly. A check endpoint's missing permission produces partial or
unavailable check data; zero contexts produce `combinedState: 'unknown'`.
`status: 'fresh'` means the repository/branch/PR lists were refreshed: callers
must inspect each check head's status/errors and coverage before describing CI.
No list response is used to infer mergeability, which remains `unknown`.

The API uses the pinned `2026-03-10` version. Official references:

- [Git porcelain output and optional-lock considerations](https://git-scm.com/docs/git-status)
- [GitHub check runs for a Git reference](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#list-check-runs-for-a-git-reference)
- [GitHub combined commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)
- [GitHub pull-request listing](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests)

## Verification

Colocated tests create actual temporary Git repositories, including linked
worktrees, and inspect ordinary/renamed/newline paths without changing the Git
index. GitHub tests use injected HTTP responses and assert GET-only requests,
fixed origin, absent public authentication, private-token redaction, failure and
rate-limit behavior, and explicit stale observations. No network is used by
these tests.
