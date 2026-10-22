import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceConnectionError } from '../shared/client.js'
import type { WorkspaceApi } from '../shared/contracts.js'
import { evaluateGate } from './gate.js'
import type { ToolInvocation } from './gate.js'
import { loadContext, observeContext } from './context-store.js'
import { receiptContext, signedReceipt } from './receipt-fixtures.test-support.js'
import { sampleSnapshot, sampleTask } from './fixtures.test-support.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'receipt-gate-')))
  directories.push(root)
  await execFileAsync('git', ['init', '--quiet', root])
  await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/project.git'])
  await writeFile(path.join(root, 'source.ts'), 'function save() { return true }\nfunction load() { return true }')
  const context = { ...receiptContext(root), acceptedOfflineReceipt: signedReceipt() }
  const file = path.join(root, 'private-session.json')
  await writeFile(file, JSON.stringify(context), { mode: 0o600 })
  const invocation: ToolInvocation = { name: 'Edit', input: { file_path: 'source.ts', old_string: 'save() { return true', new_string: 'save() { return false' }, sessionId: context.sessionId, cwd: root }
  const api: WorkspaceApi = { snapshot: vi.fn(async () => { throw new WorkspaceConnectionError('Disconnected', true, true) }), command: vi.fn() }
  return { root, file, context, invocation, api }
}

describe('accepted-scope offline action gate', () => {
  it('continues the signed existing reservation when the app is unavailable, without granting new scope', async () => {
    const { api, context, invocation } = await fixture()
    expect(await evaluateGate(api, context, invocation)).toMatchObject({ allow: true, reason: expect.stringContaining('signed offline receipt') })
    expect((await evaluateGate(api, context, { ...invocation, name: 'Write', input: { file_path: 'another.ts', content: 'new file' } })).allow).toBe(false)
    expect((await evaluateGate(api, { ...context, taskId: undefined }, invocation)).allow).toBe(false)
  })

  it('preserves parser proof for offline function reservations', async () => {
    const { api, context, invocation } = await fixture()
    const task = sampleTask({ scopes: [{ kind: 'symbol', path: 'source.ts', symbol: 'save' }] })
    const limited = { ...context, acceptedOfflineReceipt: signedReceipt(task) }
    expect((await evaluateGate(api, limited, invocation)).allow).toBe(true)
    expect((await evaluateGate(api, limited, { ...invocation, input: { ...invocation.input, old_string: 'load() { return true', new_string: 'load() { return false' } })).allow).toBe(false)
  })

  it('refuses auth/protocol failures rather than treating them as a disconnection', async () => {
    const { api, context, invocation } = await fixture()
    vi.mocked(api.snapshot).mockRejectedValue(new WorkspaceConnectionError('Unauthorized', false, false))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
    vi.mocked(api.snapshot).mockRejectedValue(new SyntaxError('Invalid JSON'))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })

  it('revokes durably from cached blocked state and cannot use it after a subsequent disconnection', async () => {
    const { api, context, invocation, file } = await fixture()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ status: 'blocked' }), { hasAuthority: false }))
    expect((await evaluateGate(api, context, invocation, { onSnapshotObserved: state => observeContext(file, context, state) })).allow).toBe(false)
    const revoked = await loadContext(file)
    expect(revoked.acceptedOfflineReceipt).toBeUndefined()
    vi.mocked(api.snapshot).mockRejectedValue(new WorkspaceConnectionError('Disconnected', true, true))
    expect((await evaluateGate(api, revoked, invocation)).allow).toBe(false)
  })

  it('accepts older cached history only with the newer signed reservation and matching clone origin', async () => {
    const { api, context, invocation, root } = await fixture()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ revision: 0, status: 'blocked' }), { hasAuthority: false, commitIndex: 1 }))
    expect((await evaluateGate(api, context, invocation)).allow).toBe(true)
    await execFileAsync('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://github.com/another/project.git'])
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })

  it('refuses a different repository even with a fresh active online task', async () => {
    const { api, context, invocation } = await fixture()
    vi.mocked(api.snapshot).mockResolvedValue({ ...sampleSnapshot(), repository: { owner: 'different', repo: 'project' } })
    expect((await evaluateGate(api, context, invocation)).allow).toBe(false)
  })
})
