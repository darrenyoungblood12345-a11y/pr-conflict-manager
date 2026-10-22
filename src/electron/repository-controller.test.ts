import { describe, expect, it, vi } from 'vitest'
import { createRepositoryController, githubIdentity } from './repository-controller.js'
import type { GitHubSnapshot, GitHubPullRequestObservation, RepositorySnapshot } from '../repository/types.js'

const local = (root = '/repo'): RepositorySnapshot => ({
  root, origin: 'git@github.com:example/project.git', head: 'a'.repeat(40), branch: 'main',
  dirtyFiles: [], branches: [], commits: [], observedAt: '2026-10-20T00:00:00Z',
  limits: { commitLimit: 100, commitsAtLimit: false },
})

const remote: GitHubSnapshot = {
  repository: null, requestedRepository: { owner: 'example', repo: 'project' },
  observedAt: '2026-10-20T01:00:00Z', lastSuccessfulAt: '2026-10-20T01:00:00Z',
  status: 'fresh', stale: false, rateLimit: { remaining: 42, limit: 60, resetAt: null, retryAfterSeconds: null },
  branches: [], pullRequests: [], checks: [],
  coverage: { branchesTruncated: false, pullRequestsTruncated: false, checkHeadsObserved: 0, checkHeadsAvailable: 0, checkHeadsLimit: 10 },
}

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

const exactObservation: GitHubPullRequestObservation = {
  requestedRepository: { owner: 'example', repo: 'project' }, number: 7, observedAt: '2026-10-21T00:00:00Z',
  status: 'fresh', mergeVerified: true, rateLimit: remote.rateLimit,
}

describe('repository selection and observation boundary', () => {
  it('extracts identities without following credentialed, alternate-host, or malformed origins', () => {
    expect(githubIdentity('git@github.com:example/project.git')).toEqual({ owner: 'example', repo: 'project' })
    expect(githubIdentity('https://github.com/example/project')).toEqual({ owner: 'example', repo: 'project' })
    expect(githubIdentity('ssh://git@github.com/example/project.git')).toEqual({ owner: 'example', repo: 'project' })
    expect(githubIdentity('ssh://github.com/example/project.git')).toEqual({ owner: 'example', repo: 'project' })
    for (const origin of ['https://github.com.evil.test/a/b', 'https://token@github.com/a/b', 'https://github.com/a/b?token=x', 'https://github.com/a/%2e%2e', 'git@github.com:a/b/extra', 'https://github.com:443/a/b']) {
      // URL normalizes the default HTTPS port; that remains the same trusted origin.
      if (origin.includes(':443')) continue
      expect(githubIdentity(origin)).toBeNull()
    }
  })

  it('keeps credentials private, clears them on repository change, and retains stale local data on failure', async () => {
    const inspect = vi.fn().mockResolvedValue(local())
    const observe = vi.fn().mockResolvedValue(null)
    const controller = createRepositoryController({ inspect, observe })
    await controller.select('/repo')
    expect(controller.setSessionToken('secret-token').hasSessionToken).toBe(true)
    expect(JSON.stringify(controller.snapshot())).not.toContain('secret-token')
    await controller.refreshGitHub()
    expect(observe.mock.calls[0]?.[0].token).toBe('secret-token')
    inspect.mockRejectedValueOnce(new Error('private filesystem details'))
    expect((await controller.refreshLocal()).localError).not.toContain('private filesystem details')
    expect(controller.snapshot().local?.root).toBe('/repo')
    await controller.select('/other')
    expect(controller.snapshot().hasSessionToken).toBe(false)
    expect(() => controller.setSessionToken('x\nheader')).toThrow()
  })

  it('ignores an old in-flight observation after switching repositories', async () => {
    const pending = deferred<GitHubSnapshot>()
    const observe = vi.fn().mockReturnValue(pending.promise)
    const controller = createRepositoryController({ inspect: vi.fn(async root => local(root)), observe })
    await controller.select('/one')
    const remoteRequest = controller.refreshGitHub()
    await controller.select('/two')
    pending.resolve(remote)
    await remoteRequest
    expect(controller.snapshot().local?.root).toBe('/two')
    expect(controller.snapshot().github).toBeNull()
  })

  it('keeps the latest requested clone when selection reads finish out of order', async () => {
    const first = deferred<RepositorySnapshot>()
    const second = deferred<RepositorySnapshot>()
    const inspect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = createRepositoryController({ inspect, observe: vi.fn() })
    const older = controller.select('/one')
    const newer = controller.select('/two')
    second.resolve(local('/two'))
    await newer
    first.resolve(local('/one'))
    await older
    expect(controller.snapshot().local?.root).toBe('/two')
  })

  it('ignores an older local refresh and clears private remote state when the origin changes', async () => {
    const inspect = vi.fn().mockResolvedValue(local())
    const pendingRemote = deferred<GitHubSnapshot>()
    const controller = createRepositoryController({ inspect, observe: vi.fn().mockReturnValue(pendingRemote.promise) })
    await controller.select('/repo')
    controller.setSessionToken('private-session-token')
    const oldRemote = controller.refreshGitHub()
    const first = deferred<RepositorySnapshot>()
    const second = deferred<RepositorySnapshot>()
    inspect.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const older = controller.refreshLocal()
    const newer = controller.refreshLocal()
    second.resolve({ ...local(), head: 'b'.repeat(40), origin: 'https://github.com/another/repo.git' })
    await newer
    first.resolve(local())
    await older
    pendingRemote.resolve(remote)
    await oldRemote
    expect(controller.snapshot()).toMatchObject({ local: { head: 'b'.repeat(40) }, github: null, hasSessionToken: false })
  })

  it('does not repopulate observations fetched with a cleared token', async () => {
    const pending = deferred<GitHubSnapshot>()
    const controller = createRepositoryController({ inspect: vi.fn().mockResolvedValue(local()), observe: vi.fn().mockReturnValue(pending.promise) })
    await controller.select('/repo')
    controller.setSessionToken('old-private-session-token')
    const older = controller.refreshGitHub()
    controller.setSessionToken('')
    pending.resolve(remote)
    await older
    expect(controller.snapshot()).toMatchObject({ github: null, hasSessionToken: false })
  })

  it('observes a linked PR only after and before fresh actual-origin validation, with credentials kept out of view state', async () => {
    const inspect = vi.fn().mockResolvedValue(local())
    const observePullRequest = vi.fn().mockResolvedValue(exactObservation)
    const controller = createRepositoryController({ inspect, observe: vi.fn(), observePullRequest })
    await controller.select('/repo')
    controller.setSessionToken('private-exact-observation-token')
    expect(await controller.observeLinkedPullRequest({ owner: 'example', repo: 'project' }, 7)).toEqual(exactObservation)
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(observePullRequest).toHaveBeenCalledWith({ owner: 'example', repo: 'project', number: 7, token: 'private-exact-observation-token' })
    expect(JSON.stringify(controller.snapshot())).not.toContain('private-exact-observation-token')
    inspect.mockResolvedValueOnce({ ...local(), origin: 'https://github.com/other/project' })
    await expect(controller.observeLinkedPullRequest({ owner: 'example', repo: 'project' }, 7)).rejects.toThrow('does not match')
    expect(observePullRequest).toHaveBeenCalledTimes(1)
  })

  it('discards a linked-PR response if the selected clone, token, or actual origin changes while it is in flight', async () => {
    for (const changed of ['selection', 'token', 'origin'] as const) {
      const pending = deferred<GitHubPullRequestObservation>()
      const started = deferred<void>()
      const inspect = vi.fn().mockResolvedValue(local())
      const observePullRequest = vi.fn(async () => { started.resolve(); return pending.promise })
      const controller = createRepositoryController({ inspect, observe: vi.fn(), observePullRequest })
      await controller.select('/repo')
      const observation = controller.observeLinkedPullRequest({ owner: 'example', repo: 'project' }, 7)
      await started.promise
      if (changed === 'selection') await controller.select('/other')
      if (changed === 'token') controller.setSessionToken('new-session-token')
      if (changed === 'origin') inspect.mockResolvedValueOnce({ ...local(), origin: 'https://github.com/other/repository' })
      pending.resolve(exactObservation)
      await expect(observation).rejects.toThrow(changed === 'origin' ? 'does not match' : 'changed')
    }
  })

  it('does not start an exact request after selection changes during its initial Git inspection', async () => {
    const pending = deferred<RepositorySnapshot>()
    const inspect = vi.fn().mockResolvedValue(local())
    const observePullRequest = vi.fn().mockResolvedValue(exactObservation)
    const controller = createRepositoryController({ inspect, observe: vi.fn(), observePullRequest })
    await controller.select('/repo')
    inspect.mockReturnValueOnce(pending.promise)
    const observation = controller.observeLinkedPullRequest({ owner: 'example', repo: 'project' }, 7)
    controller.reset()
    pending.resolve(local())
    await expect(observation).rejects.toThrow('changed')
    expect(observePullRequest).not.toHaveBeenCalled()
  })
})
