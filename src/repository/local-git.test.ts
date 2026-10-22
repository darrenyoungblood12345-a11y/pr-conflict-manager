import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRepository } from './local-git.js'

const execute = promisify(execFile)
const directories: string[] = []
const git = async (root: string, ...args: string[]) => (await execute('git', [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'user.name=Observation Fixture', '-c', 'user.email=fixture@example.invalid',
  '-C', root, ...args,
], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout

const fixture = async (committed = true) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-pr-git-'))
  directories.push(directory)
  const root = path.join(directory, 'repository with spaces')
  await mkdir(root)
  await git(root, 'init', '-b', 'main')
  if (committed) {
    await writeFile(path.join(root, 'old name\nline.ts'), 'export const value = 1\n')
    await writeFile(path.join(root, 'tracked.ts'), 'export const tracked = true\n')
    await git(root, 'add', '--all')
    await git(root, 'commit', '-m', 'Initial fixture')
  }
  return { root: await realpath(root), directory }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('read-only local Git observation', () => {
  it('preserves newline/space filenames and staged rename pairs without changing the index', async () => {
    const { root } = await fixture()
    await rename(path.join(root, 'old name\nline.ts'), path.join(root, 'new name\nline.ts'))
    await git(root, 'add', '--all')
    await writeFile(path.join(root, 'tracked.ts'), 'export const tracked = false\n')
    await writeFile(path.join(root, 'untracked file\nnext.txt'), 'local only\n')
    const indexFile = path.join(root, '.git', 'index')
    const before = await readFile(indexFile)
    const beforeMetadata = await stat(indexFile)

    const snapshot = await inspectRepository(root)

    expect(snapshot.root).toBe(root)
    expect(snapshot.branch).toBe('main')
    expect(snapshot.head).toMatch(/^[a-f0-9]{40}$/)
    expect(snapshot.dirtyFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'new name\nline.ts', originalPath: 'old name\nline.ts', kind: 'renamed', indexStatus: 'R' }),
      expect.objectContaining({ path: 'tracked.ts', kind: 'modified', worktreeStatus: 'M' }),
      expect.objectContaining({ path: 'untracked file\nnext.txt', kind: 'untracked' }),
    ]))
    expect(await readFile(indexFile)).toEqual(before)
    expect((await stat(indexFile)).mtimeMs).toBe(beforeMetadata.mtimeMs)
    expect(snapshot.commits[0]).toMatchObject({ subject: 'Initial fixture', parentHashes: [] })
    expect(snapshot.branches).toEqual([expect.objectContaining({ name: 'main', current: true, remote: false })])
  })

  it('supports a .git-file worktree and reads its own branch rather than its parent checkout', async () => {
    const { root, directory } = await fixture()
    const worktree = path.join(directory, 'linked worktree')
    await git(root, 'worktree', 'add', '-b', 'feat/parallel', worktree)
    expect((await stat(path.join(worktree, '.git'))).isFile()).toBe(true)
    const snapshot = await inspectRepository(worktree)
    expect(snapshot.root).toBe(await realpath(worktree))
    expect(snapshot.branch).toBe('feat/parallel')
    expect(snapshot.dirtyFiles).toEqual([])
  })

  it('includes actual detached-HEAD commits and their parents without inventing a branch', async () => {
    const { root } = await fixture()
    const base = (await git(root, 'rev-parse', 'HEAD')).trim()
    await git(root, 'checkout', '--detach', 'HEAD')
    await writeFile(path.join(root, 'detached.txt'), 'unattached commit\n')
    await git(root, 'add', '--all')
    await git(root, 'commit', '-m', 'Detached progress')
    const snapshot = await inspectRepository(root)
    expect(snapshot.branch).toBeNull()
    expect(snapshot.commits[0]).toMatchObject({ hash: snapshot.head, subject: 'Detached progress', parentHashes: [base] })
    expect(snapshot.commits).toHaveLength(2)
  })

  it('handles an unborn repository and refuses a nested selection that would inspect outside it', async () => {
    const { root } = await fixture(false)
    const snapshot = await inspectRepository(root)
    expect(snapshot.head).toBeNull()
    expect(snapshot.branch).toBe('main')
    expect(snapshot.commits).toEqual([])
    await mkdir(path.join(root, 'nested'))
    await expect(inspectRepository(path.join(root, 'nested'))).rejects.toThrow('root itself')
  })

  it('redacts HTTP remote credentials and disables configured fsmonitor execution', async () => {
    const { root } = await fixture()
    await git(root, 'remote', 'add', 'origin', 'https://private-user:private-token@github.com/acme/project.git?access_token=private-token')
    const marker = path.join(root, 'unexpected-hook.txt')
    const hook = path.join(root, '.git', 'fsmonitor-fixture')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
    await git(root, 'config', 'core.fsmonitor', hook)
    const snapshot = await inspectRepository(root)
    expect(snapshot.origin).toBe('https://github.com/acme/project.git')
    expect(JSON.stringify(snapshot)).not.toContain('private-token')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await git(root, 'remote', 'set-url', 'origin', 'username:second-private-token@github.com:acme/project.git')
    const scpSnapshot = await inspectRepository(root)
    expect(scpSnapshot.origin).toBe('git@github.com:acme/project.git')
    expect(JSON.stringify(scpSnapshot)).not.toContain('second-private-token')
  })
})
