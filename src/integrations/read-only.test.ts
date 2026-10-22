import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateGate } from './gate.js'
import { sampleContext } from './fixtures.test-support.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'planning-read-')))
  directories.push(root)
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(root, 'src', 'source.ts'), 'function run() { return true }')
  const context = { ...sampleContext(root), taskId: undefined, revision: undefined }
  const api = { snapshot: vi.fn(async () => { throw new Error('offline') }), command: vi.fn() }
  const invoke = (name: string, input: Record<string, unknown>) => evaluateGate(api, context, { name, input, cwd: root, sessionId: context.sessionId })
  return { root, context, api, invoke }
}

describe('bounded native planning reads', () => {
  it('permits documented Read, Glob and Grep source inspection before registration without authority', async () => {
    const { invoke, api } = await fixture()
    expect((await invoke('Read', { file_path: 'src/source.ts', offset: 1, limit: 20 })).allow).toBe(true)
    expect((await invoke('Glob', { pattern: 'src/**/*.ts' })).allow).toBe(true)
    expect((await invoke('Grep', { path: 'src', pattern: 'function', glob: '*.ts', output_mode: 'content', '-n': true })).allow).toBe(true)
    expect(api.snapshot).not.toHaveBeenCalled()
    expect(api.command).not.toHaveBeenCalled()
  })

  it('keeps safe source reads callable when task permission was revoked while requiring the native session', async () => {
    const { root, context, api } = await fixture()
    const invocation = { name: 'Read', input: { file_path: 'src/source.ts' }, cwd: root, sessionId: context.sessionId }
    expect((await evaluateGate(api, { ...context, taskId: 'task-a', revision: 1, offlineRevokedThrough: { 'task-a': 1 } }, invocation)).allow).toBe(true)
    expect((await evaluateGate(api, context, { ...invocation, sessionId: 'other' })).allow).toBe(false)
  })

  it.each([
    ['Read', { file_path: '../outside.ts' }],
    ['Read', { file_path: '.git/config' }],
    ['Read', { file_path: 'src/source.ts', filePath: 'src/source.ts' }],
    ['Read', { file_path: 'src/source.ts', command: 'touch elsewhere' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: 'src/{..,ok}/outside' }],
    ['Glob', { pattern: 'src/[.][.]/outside' }],
    ['Grep', { path: '../', pattern: 'text' }],
    ['Grep', { path: 'src', pattern: 'text', follow: true }],
  ])('refuses unsafe, ambiguous or unmodeled %s input %j', async (name, input) => {
    const { invoke } = await fixture()
    expect((await invoke(name, input)).allow).toBe(false)
  })

  it('refuses recursive searches containing any symlink or agent control subtree', async () => {
    const { root, invoke } = await fixture()
    await symlink(path.join(root, 'src', 'source.ts'), path.join(root, 'src', 'alias.ts'))
    expect((await invoke('Glob', { pattern: 'src/**/*.ts' })).allow).toBe(false)
    await rm(path.join(root, 'src', 'alias.ts'))
    await mkdir(path.join(root, 'src', '.claude'))
    expect((await invoke('Grep', { path: 'src', pattern: 'text' })).allow).toBe(false)
  })
})
