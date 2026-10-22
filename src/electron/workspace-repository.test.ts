import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ensureWorkspaceRepository } from './workspace-repository.js'
import type { Snapshot, WorkspaceApi } from '../shared/contracts.js'
import type { RepositorySnapshot } from '../repository/types.js'

const identity = { owner: 'example', repo: 'project' }
const local: RepositorySnapshot = {
  root: '/selected/clone', origin: 'git@github.com:Example/Project.git', branch: 'feat/work', head: 'a'.repeat(40),
  dirtyFiles: [], branches: [], commits: [], observedAt: '2026-10-21T00:00:00Z', limits: { commitLimit: 100, commitsAtLimit: false },
}
const snapshot = (repository?: Snapshot['repository'], hasAuthority = true): Snapshot => ({
  repository, hasAuthority, nodeId: 'local', leaderId: 'local', commitIndex: 1, members: [],
  plan: { revision: 0, markdown: '' }, tasks: {}, events: [],
})
const fixture = () => {
  const api = { snapshot: vi.fn().mockResolvedValue(snapshot(identity)), command: vi.fn().mockResolvedValue({ ok: true }) } satisfies WorkspaceApi
  return { api, inspect: vi.fn().mockResolvedValue(local), assertCurrent: vi.fn() }
}

describe('desktop immutable workspace repository binding', () => {
  it('reads the selected actual Git origin without contacting it or exposing embedded credentials', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-workspace-bind-')))
    const execute = promisify(execFile)
    try {
      await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'init'])
      await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'remote', 'add', 'origin', 'https://local-fixture:never-render-this@github.com/Example/Project.git'])
      const { api, assertCurrent } = fixture()
      api.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(identity))
      expect(await ensureWorkspaceRepository({ api, root, assertCurrent })).toEqual(identity)
      expect(JSON.stringify(api.command.mock.calls)).not.toContain('never-render-this')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses an observed canonical GitHub origin and confirms a new binding through a fresh reread', async () => {
    const { api, inspect, assertCurrent } = fixture()
    api.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(identity))
    expect(await ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).toEqual(identity)
    expect(inspect).toHaveBeenCalledWith(local.root)
    expect(api.command).toHaveBeenCalledWith({ type: 'bind_repository', repository: identity })
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('revalidates an existing binding without changing it and rejects a mismatched actual clone', async () => {
    const { api, inspect, assertCurrent } = fixture()
    await ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)
    expect(api.command).not.toHaveBeenCalled()
    inspect.mockResolvedValueOnce({ ...local, origin: 'https://github.com/other/repository.git' })
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('does not match')
    expect(api.command).not.toHaveBeenCalled()
  })

  it('cannot bind or authorize work from unavailable authority, unsupported origins, or an unconfirmed accepted response', async () => {
    const { api, inspect, assertCurrent } = fixture()
    api.snapshot.mockResolvedValueOnce(snapshot(undefined, false))
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('Fresh workspace authority')
    expect(api.command).not.toHaveBeenCalled()
    inspect.mockResolvedValueOnce({ ...local, origin: 'https://github.com.attacker.invalid/example/project' })
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('supported github.com origin')
    api.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(identity, false))
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('could not be confirmed')
  })

  it('rejects a concurrently chosen different binding or changed workspace before submitting more mutations', async () => {
    const { api, inspect, assertCurrent } = fixture()
    api.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ owner: 'other', repo: 'project' }))
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('could not be confirmed')
    api.command.mockClear()
    assertCurrent.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('Workspace changed') })
    await expect(ensureWorkspaceRepository({ api, root: local.root, assertCurrent }, inspect)).rejects.toThrow('Workspace changed')
    expect(api.command).not.toHaveBeenCalled()
  })
})
