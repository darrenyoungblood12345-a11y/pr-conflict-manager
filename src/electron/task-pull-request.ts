import type { RepositoryIdentity, WorkspaceApi } from '../shared/contracts.js'
import type { GitHubPullRequestObservation } from '../repository/types.js'

interface TaskPullRequestOptions {
  api: WorkspaceApi
  taskId: string
  expectedRevision: number
  assertCurrent(): void
  observe(repository: RepositoryIdentity, number: number): Promise<GitHubPullRequestObservation>
}

/** Only a new, exact GitHub read may commit a merge observation. */
export const observeTaskPullRequest = async ({ api, taskId, expectedRevision, assertCurrent, observe }: TaskPullRequestOptions) => {
  assertCurrent()
  const initial = await api.snapshot()
  assertCurrent()
  const task = initial.tasks[taskId]
  if (!initial.hasAuthority || !initial.repository || !task?.pullRequest || task.revision !== expectedRevision) {
    throw new Error('Review the current task, linked PR, and workspace authority before checking its merge.')
  }
  const identity = initial.repository
  const number = task.pullRequest.number
  const observation = await observe(identity, number)
  assertCurrent()
  if (observation.status !== 'fresh' || !observation.mergeVerified) return observation
  if (observation.number !== number || observation.requestedRepository.owner !== identity.owner
    || observation.requestedRepository.repo !== identity.repo) {
    throw new Error('The GitHub observation did not match this task’s linked PR.')
  }
  const current = await api.snapshot()
  assertCurrent()
  const latest = current.tasks[taskId]
  if (!current.hasAuthority || current.repository?.owner !== identity.owner || current.repository?.repo !== identity.repo
    || latest?.revision !== expectedRevision || latest.pullRequest?.number !== number) {
    throw new Error('The task or workspace changed during the GitHub check. Review it and check again.')
  }
  if (!latest.prMerged) {
    const result = await api.command({ type: 'mark_pr_merged', taskId, expectedRevision })
    assertCurrent()
    if (!result.ok) throw new Error(result.error?.message ?? 'The workspace could not accept the merge observation.')
  }
  return observation
}
