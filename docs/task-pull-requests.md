# Task and pull-request lifecycle

A workspace is bound to one canonical GitHub.com repository. The desktop and
production LAN integration verify the actual selected clone’s origin before
registering work. Other branches and separate local clones of that repository
are allowed. A different repository cannot reuse its file/function reservations.

An owner can link an existing PR number through Task details or the MCP
`link_pull_request` tool. The link does not create or modify anything on GitHub.
Its revision changes, so the MCP bridge refreshes active acceptance before the
agent can continue. Replacing a link requires stopped-write acknowledgement and
clears prior merge evidence. Revising the task’s scope clears its old PR link.

In Task details, **Check GitHub** requests the exact linked PR from the bound
repository using the app session’s optional private-repository token. It never
infers a link from branch names. The main process verifies the returned number,
base repository, canonical PR URL, merged flag, closed state, merge timestamp,
and merge commit hash. It checks current workspace authority and task revision
again before committing the observation. Repository/credential/workspace changes
during the request invalidate it. Cached PR lists, failed/rate-limited reads,
closed unmerged PRs, and passing checks cannot release reservations.

Reservations release as completed only when all three conditions hold:

1. The owner reported editing complete.
2. The owner acknowledged that all admitted and background writes have stopped.
3. The app observed that exact linked PR merged.

Observing a merge while an agent is still active retains its reservation. A
disconnected active agent can therefore keep its previously accepted scope
without another task being admitted into it. Cancellation instead requires an
owner stop acknowledgement and explicitly abandons the task.

The sandboxed renderer cannot submit `mark_pr_merged` directly. No agent-callable
MCP merge-assertion tool is exposed. These are cooperative coordination controls;
they do not audit whether a manually linked PR contains every intended change or
replace normal code review. Equal workspace participants are trusted users.

The [official GitHub Get a pull request reference](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request)
describes the read response. An unmerged PR’s `merge_commit_sha` can identify a
test merge, so a hash alone is deliberately insufficient evidence.
