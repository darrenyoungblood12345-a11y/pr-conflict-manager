import { mkdtemp, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from '../shared/contracts.js'
import { evaluateGate, isCoordinationTool } from './gate.js'
import type { ToolInvocation } from './gate.js'
import { sampleContext, sampleSnapshot, sampleTask } from './fixtures.test-support.js'

describe('current workspace action gate', () => {
  const temporary: string[] = []
  const environment = async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-gate-')))
    temporary.push(root)
    await writeFile(path.join(root, 'source.ts'), 'export const save = () => true\n')
    const context = sampleContext(root)
    const invocation: ToolInvocation = { name: 'Edit', input: { file_path: path.join(root, 'source.ts'), old_string: 'true', new_string: 'false' }, sessionId: context.sessionId, cwd: root }
    const api: WorkspaceApi = { snapshot: vi.fn(async () => sampleSnapshot()), command: vi.fn() }
    return { root, api, context, invocation }
  }

  afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

  it('admits a native edit only with current identity, active revision, authority and whole-file scope', async () => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, invocation)).allow).toBe(true)
  })

  it.each([
    ['Straße.ts', 'strasse.ts'],
    ['Σ.ts', 'σ.ts'],
    ['ς.ts', 'σ.ts'],
    ['ﬃ.ts', 'ffi.ts'],
    ['Cafe\u0301.ts', 'café.ts'],
  ])('admits %s when the native coordinator holds canonical path %s', async (file, claim) => {
    const { root, api, context, invocation } = await environment()
    await writeFile(path.join(root, file), 'export const value = true\n')
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: claim, kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, input: { ...invocation.input, file_path: file } })).allow).toBe(true)
  })

  it('fails closed for filenames whose Unicode version is not qualified by native coordination', async () => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: '\u1c89.ts', kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, input: { file_path: '\u1c89.ts' } })).allow).toBe(false)
  })

  it.each([['Ꭰ.ts', 'ꭰ.ts'], ['ꭰ.ts', 'Ꭰ.ts']])('refuses unqualified Cherokee edit %s even with native claim %s', async (file, claim) => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: claim, kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, input: { file_path: file } })).allow).toBe(false)
  })

  it('rechecks current state after an earlier successful edit instead of reusing acceptance', async () => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, invocation)).allow).toBe(true)
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ revision: 2, status: 'blocked', conflicts: ['task-b'] })))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('rejects an old revision even if the task becomes active again', async () => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ revision: 3 })))
    expect(await evaluateGate(api, context, invocation)).toMatchObject({ allow: false, reason: expect.stringContaining('revision changed') })
  })

  it.each(['blocked', 'cancelled', 'completed', 'awaiting-merge'] as const)('blocks future edits for a %s task', async status => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ status })))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })

  it.each([{ ownerId: 'other' }, { sessionId: 'other' }, { agent: 'codex' as const }, { stopAcknowledged: true }])('rejects changed task identity or stopped status: %j', async override => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask(override)))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })

  it('cannot use a task context from a different native session', async () => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, { ...invocation, sessionId: 'resumed-elsewhere' })).allow).toBe(false)
  })

  it('denies unavailable service and minority authority without authorizing cached offline work', async () => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockRejectedValueOnce(new Error('connection lost'))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
    vi.mocked(api.snapshot).mockResolvedValueOnce(sampleSnapshot(sampleTask(), { hasAuthority: false }))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })

  it.each(['Bash', 'Shell', 'bash', 'Agent', 'Task', 'Skill', 'TodoWrite', 'ToolSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'unrecognized'])('leaves %s to the client permission policy without a task, session match, or coordinator', async name => {
    const { api, context, invocation } = await environment()
    const unbound = { ...invocation, name, input: { command: 'npm test' }, sessionId: 'another-session' }
    expect((await evaluateGate(api, { ...context, taskId: undefined, revision: undefined }, unbound)).allow).toBe(true)
    expect(api.snapshot).not.toHaveBeenCalled()
  })

  it('still requires a bound session and registered task for native edits', async () => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, { ...invocation, sessionId: 'another-session' })).allow).toBe(false)
    expect(await evaluateGate(api, { ...context, taskId: undefined, revision: undefined }, invocation)).toMatchObject({ allow: false, reason: expect.stringContaining('register a task') })
  })

  it('requires whole-file claims when a native edit cannot prove symbol-level scope', async () => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] })))
    expect(await evaluateGate(api, context, { ...invocation, input: { ...invocation.input, old_string: 'absent' } })).toMatchObject({ allow: false, reason: expect.stringContaining('cannot be proven inside a reserved function') })
  })

  it('admits a reconstructed edit inside a parsed reserved function and refuses neighboring changes', async () => {
    const { root, api, context, invocation } = await environment()
    await writeFile(path.join(root, 'source.ts'), 'export function save() { return true }\nexport function load() { return true }\n')
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] })))
    const edit = { ...invocation, input: { ...invocation.input, old_string: 'save() { return true', new_string: 'save() { return false' } }
    expect((await evaluateGate(api, context, edit)).allow).toBe(true)
    expect((await evaluateGate(api, context, { ...edit, input: { ...edit.input, old_string: 'load() { return true', new_string: 'load() { return false' } })).allow).toBe(false)
    expect((await evaluateGate(api, context, { ...edit, name: 'Write', input: { ...invocation.input, content: 'export function save() { return false }\nexport function load() { return false }\n' } })).allow).toBe(false)
  })

  it('refuses a task blocked while its proposed symbol edit was being parsed', async () => {
    const { root, api, context, invocation } = await environment()
    await writeFile(path.join(root, 'source.ts'), 'function save() { return true }')
    const task = sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] })
    vi.mocked(api.snapshot).mockResolvedValueOnce(sampleSnapshot(task)).mockResolvedValueOnce(sampleSnapshot({ ...task, revision: 2, status: 'blocked', conflicts: ['other'] }))
    expect(await evaluateGate(api, context, { ...invocation, input: { ...invocation.input, old_string: 'true', new_string: 'false' } })).toMatchObject({ allow: false, reason: expect.stringContaining('changed during symbol validation') })
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('refuses a directory target even if an older whole-file reservation has that path', async () => {
    const { root, api, context, invocation } = await environment()
    await mkdir(path.join(root, 'folder'))
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'folder', kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, name: 'Delete', input: { path: 'folder' } })).allow).toBe(false)
  })

  it('refuses conflicting client path aliases instead of authorizing the wrong write target', async () => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, { ...invocation, input: { file_path: 'source.ts', filePath: 'unclaimed.ts' } })).allow).toBe(false)
  })

  it.each([
    ['Write', { content: 'x', append: true }],
    ['Edit', { old_string: 'true', new_string: 'false', edits: [{ file_path: 'unclaimed.ts' }] }],
    ['MultiEdit', { edits: [{ old_string: 'true', new_string: 'false', file_path: 'unclaimed.ts' }] }],
    ['Delete', { recursive: true }],
  ])('refuses unknown %s payload modes even with a whole-file reservation', async (name, input) => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, { ...invocation, name, input: { file_path: 'source.ts', ...input } })).allow).toBe(false)
  })

  it('checks every patch source and rename destination against reservations', async () => {
    const { api, context, invocation } = await environment()
    const patch = { ...invocation, name: 'apply_patch', input: { command: '*** Begin Patch\n*** Update File: source.ts\n*** Move to: other.ts\n@@\n-old\n+new\n*** End Patch\n' } }
    expect((await evaluateGate(api, context, patch)).allow).toBe(false)
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'file' }, { path: 'other.ts', kind: 'file' }] })))
    expect((await evaluateGate(api, context, patch)).allow).toBe(true)
  })

  it.each(['../source.ts', './source.ts', '/tmp/outside.ts', 'folder\\source.ts', '.git/config', '.cursor/hooks.json'])('rejects unsafe or control path %s', async filePath => {
    const { api, context, invocation } = await environment()
    expect((await evaluateGate(api, context, { ...invocation, input: { file_path: filePath } })).allow).toBe(false)
  })

  it('refuses symlink aliases even with a matching lexical file claim', async () => {
    const { root, api, context, invocation } = await environment()
    await symlink(path.join(root, 'source.ts'), path.join(root, 'alias.ts'))
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'alias.ts', kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, input: { file_path: 'alias.ts' } })).allow).toBe(false)
  })

  it('resolves relative paths against the native working directory', async () => {
    const { root, api, context, invocation } = await environment()
    await mkdir(path.join(root, 'src'))
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'src/new.ts', kind: 'file' }] })))
    expect((await evaluateGate(api, context, { ...invocation, name: 'Write', cwd: path.join(root, 'src'), input: { file_path: 'new.ts', content: 'new content' } })).allow).toBe(true)
  })

  it('recognizes only exact workspace coordination tools while blocked without needing service reachability', async () => {
    const { api, context, invocation } = await environment()
    vi.mocked(api.snapshot).mockRejectedValue(new Error('offline'))
    expect(await evaluateGate(api, context, { ...invocation, name: 'mcp__agent_pr_monitor__read_plan' })).toMatchObject({ allow: true, reason: expect.stringContaining('coordination') })
    expect(api.snapshot).not.toHaveBeenCalled()
    expect(await evaluateGate(api, context, { ...invocation, name: 'mcp__evil__agent_pr_monitor__read_plan' })).toMatchObject({ allow: true, reason: expect.stringContaining('client permission policy') })
    expect(isCoordinationTool({ ...invocation, name: 'mcp__agent_pr_monitor__read_plan', serverName: 'evil' })).toBe(false)
    expect(isCoordinationTool({ ...invocation, name: 'read_plan', serverName: 'agent_pr_monitor', serverSource: 'sdk' })).toBe(false)
  })
})
