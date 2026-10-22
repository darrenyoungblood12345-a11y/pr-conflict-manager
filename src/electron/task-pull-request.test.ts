import { describe, expect, it, vi } from 'vitest'
import type { Snapshot, WorkspaceApi } from '../shared/contracts.js'
import type { GitHubPullRequestObservation } from '../repository/types.js'
import { observeTaskPullRequest } from './task-pull-request.js'

const snapshot = (): Snapshot => ({
  nodeId: 'mac-a', leaderId: 'mac-a', hasAuthority: true, commitIndex: 10, members: [],
  repository: { owner: 'acme', repo: 'app' }, plan: { revision: 1, markdown: 'Plan' }, events: [],
  tasks: { work: {
    id: 'work', ownerId: 'alice', sessionId: 'session', agent: 'codex', branch: 'feat/save',
    baseCommit: 'a'.repeat(40), description: 'Save safely', planRevision: 1,
    scopes: [{ path: 'store.ts', kind: 'symbol', symbol: 'save' }], revision: 3,
    status: 'awaiting-merge', stopAcknowledged: true, prMerged: false, conflicts: [], pullRequest: { number: 42 },
  } },
})
const observation = (): GitHubPullRequestObservation => ({
  requestedRepository: { owner: 'acme', repo: 'app' }, number: 42, observedAt: new Date().toISOString(),
  status: 'fresh', mergeVerified: true,
  rateLimit: { remaining: 20, limit: 60, resetAt: null, retryAfterSeconds: null },
})
const fixture = () => {
  const api: WorkspaceApi = {
    snapshot: vi.fn().mockImplementation(async () => snapshot()), command: vi.fn().mockResolvedValue({ ok: true }),
  }
  return { api, taskId: 'work', expectedRevision: 3, assertCurrent: vi.fn(), observe: vi.fn().mockResolvedValue(observation()) }
}

describe('task PR merge observation', () => {
  it('commits an exact newly verified observation after a second authoritative task check', async () => {
    const options = fixture()
    await observeTaskPullRequest(options)
    expect(options.observe).toHaveBeenCalledWith({ owner: 'acme', repo: 'app' }, 42)
    expect(options.api.snapshot).toHaveBeenCalledTimes(2)
    expect(options.api.command).toHaveBeenCalledWith({ type: 'mark_pr_merged', taskId: 'work', expectedRevision: 3 })
  })

  it.each([
    { status: 'unavailable', mergeVerified: false },
    { status: 'rate-limited', mergeVerified: false },
    { status: 'fresh', mergeVerified: false },
  ] as const)('retains claims for an unverified observation %j', async override => {
    const options = fixture()
    options.observe.mockResolvedValue({ ...observation(), ...override })
    await observeTaskPullRequest(options)
    expect(options.api.command).not.toHaveBeenCalled()
  })

  it.each(['authority', 'revision', 'number', 'repository'] as const)('rejects changed %s during a remote read', async change => {
    const options = fixture()
    const current = snapshot()
    if (change === 'authority') current.hasAuthority = false
    if (change === 'revision') current.tasks.work.revision += 1
    if (change === 'number') current.tasks.work.pullRequest = { number: 43 }
    if (change === 'repository') current.repository = { owner: 'other', repo: 'app' }
    vi.mocked(options.api.snapshot).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(current)
    await expect(observeTaskPullRequest(options)).rejects.toThrow('changed')
    expect(options.api.command).not.toHaveBeenCalled()
  })

  it('rejects workspace switch, mismatched response, and stale task before committing', async () => {
    const switched = fixture()
    switched.assertCurrent.mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined)
      .mockImplementation(() => { throw new Error('switched') })
    await expect(observeTaskPullRequest(switched)).rejects.toThrow('switched')
    expect(switched.api.command).not.toHaveBeenCalled()
    const mismatch = fixture()
    mismatch.observe.mockResolvedValue({ ...observation(), number: 99 })
    await expect(observeTaskPullRequest(mismatch)).rejects.toThrow('did not match')
    expect(mismatch.api.command).not.toHaveBeenCalled()
    const stale = fixture()
    stale.expectedRevision = 1
    await expect(observeTaskPullRequest(stale)).rejects.toThrow('current task')
    expect(stale.observe).not.toHaveBeenCalled()
  })

  it('does not recommit an already observed merge and surfaces rejected state changes', async () => {
    const options = fixture()
    const current = snapshot()
    current.tasks.work.prMerged = true
    vi.mocked(options.api.snapshot).mockResolvedValue(current)
    await observeTaskPullRequest(options)
    expect(options.api.command).not.toHaveBeenCalled()
    const rejected = fixture()
    vi.mocked(rejected.api.command).mockResolvedValue({ ok: false, error: { code: 'stale', message: 'Task changed' } })
    await expect(observeTaskPullRequest(rejected)).rejects.toThrow('Task changed')
  })
})
