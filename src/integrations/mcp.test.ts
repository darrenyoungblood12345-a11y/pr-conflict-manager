import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scope, TaskProposal, WorkspaceApi } from '../shared/contracts.js'
import { createWorkspaceMcpServer } from './mcp.js'
import { sampleContext, sampleSnapshot, sampleTask } from './fixtures.test-support.js'
import { receiptContext, signedReceipt } from './receipt-fixtures.test-support.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('workspace MCP protocol', () => {
  const connections: Array<() => Promise<void>> = []
  const directories: string[] = []
  const connect = async (qualifyScopes?: (scopes: Scope[]) => Promise<{ scopes: Scope[]; warnings: string[] }>, options: Partial<Parameters<typeof createWorkspaceMcpServer>[1]> = {}) => {
    const snapshot = sampleSnapshot()
    const api: WorkspaceApi = {
      snapshot: vi.fn(async () => snapshot),
      command: vi.fn(async () => ({ ok: true, state: snapshot, taskId: 'task-a' })),
    }
    const onTaskAccepted = vi.fn(async () => undefined)
    const server = createWorkspaceMcpServer(api, { context: sampleContext('/tmp'), onTaskAccepted, qualifyScopes, ...options })
    const client = new Client({ name: 'phase-one-integration-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    connections.push(async () => { await client.close(); await server.close() })
    return { client, api, snapshot, onTaskAccepted }
  }
  const proposal = (): TaskProposal => {
    const { revision, status, stopAcknowledged, prMerged, conflicts, ...task } = sampleTask()
    return task
  }
  const parse = (response: Awaited<ReturnType<Client['callTool']>>) => {
    const content = response.content as Array<{ type: string; text: string }>
    return JSON.parse(content[0].text)
  }
  afterEach(async () => {
    await Promise.all(connections.splice(0).map(close => close()))
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('advertises coordination/resolution tools through the actual SDK without a merge command', async () => {
    const { client } = await connect()
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'acknowledge_stop', 'cancel_task', 'list_tasks', 'read_plan', 'report_completion',
      'revise_task', 'set_plan', 'submit_task', 'task_status',
      'link_pull_request', 'list_symbols', 'repository_status',
    ].sort())
    expect(tools.tools.find(tool => tool.name === 'submit_task')?.inputSchema.required).toContain('task')
  })

  it('reads a shared plan and its authority/identity without mutating anything', async () => {
    const { client, api } = await connect()
    const response = await client.callTool({ name: 'read_plan', arguments: {} })
    expect(parse(response)).toMatchObject({ plan: { revision: 1 }, hasAuthority: true, identity: { ownerId: 'owner-a', sessionId: 'session-a' } })
    expect(api.command).not.toHaveBeenCalled()
  })

  it('inspects local repository and parsed symbols while coordination is unavailable, without a mutation', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mcp-planning-')))
    directories.push(root)
    await promisify(execFile)('git', ['init', '--quiet', root])
    await writeFile(path.join(root, 'source.ts'), 'export function run() { return true }')
    const { client, api } = await connect(undefined, { repositoryRoot: root })
    vi.mocked(api.snapshot).mockRejectedValue(new Error('offline'))
    expect(parse(await client.callTool({ name: 'repository_status', arguments: {} }))).toMatchObject({ root })
    expect(parse(await client.callTool({ name: 'list_symbols', arguments: { path: 'source.ts' } }))).toMatchObject({ analysis: { qualified: true, symbols: [expect.objectContaining({ qualifiedName: 'run' })] } })
    expect((await client.callTool({ name: 'list_symbols', arguments: { path: '.git/config' } })).isError).toBe(true)
    expect(api.snapshot).not.toHaveBeenCalled()
    expect(api.command).not.toHaveBeenCalled()
  })

  it('links an existing PR through the owned revision protocol and refreshes active task context', async () => {
    const { client, api, onTaskAccepted } = await connect()
    const linked = sampleTask({ revision: 2, pullRequest: { number: 17 } })
    vi.mocked(api.snapshot).mockResolvedValueOnce(sampleSnapshot()).mockResolvedValue(sampleSnapshot(linked))
    vi.mocked(api.command).mockResolvedValue({ ok: true, taskId: linked.id, state: sampleSnapshot(linked) })
    const response = parse(await client.callTool({ name: 'link_pull_request', arguments: { taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 1, number: 17 } }))
    expect(api.command).toHaveBeenCalledWith({ type: 'link_pull_request', taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 1, number: 17 })
    expect(response).toMatchObject({ editingAllowed: true, task: { revision: 2, pullRequest: { number: 17 } } })
    expect(onTaskAccepted).toHaveBeenCalledWith(linked)
    expect((await client.callTool({ name: 'link_pull_request', arguments: { taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 2, number: 0 } })).isError).toBe(true)
  })

  it('forwards a registration and refreshes context only from matching authoritative current state', async () => {
    const { client, api, onTaskAccepted } = await connect()
    const response = await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })
    expect(api.command).toHaveBeenCalledWith({ type: 'register_task', task: proposal() })
    expect(parse(response).editingAllowed).toBe(true)
    expect(onTaskAccepted).toHaveBeenCalledWith(sampleTask())
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('does not bind stale accepted state to a later active revision', async () => {
    const { client, api, onTaskAccepted } = await connect()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ revision: 4 })))
    const response = await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })
    expect(parse(response).editingAllowed).toBe(false)
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('binds a verified exact receipt only after a final authoritative snapshot', async () => {
    const { client, api, onTaskAccepted } = await connect(undefined, { context: receiptContext('/tmp') })
    const receipt = signedReceipt()
    api.taskReceipt = vi.fn(async () => receipt)
    const response = parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } }))
    expect(response.offlineContinuation).toBe(true)
    expect(onTaskAccepted).toHaveBeenCalledWith(sampleTask(), receipt)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('cannot bind a receipt when stop acknowledgement arrives while it is being minted', async () => {
    const observed = vi.fn(async () => undefined)
    const { client, api, onTaskAccepted } = await connect(undefined, { context: receiptContext('/tmp'), onSnapshotObserved: observed })
    api.taskReceipt = vi.fn(async () => signedReceipt())
    vi.mocked(api.snapshot).mockResolvedValueOnce(sampleSnapshot()).mockResolvedValueOnce(sampleSnapshot(sampleTask({ stopAcknowledged: true })))
    const response = parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } }))
    expect(response).toMatchObject({ editingAllowed: false, offlineContinuation: false })
    expect(onTaskAccepted).not.toHaveBeenCalled()
    expect(observed).toHaveBeenLastCalledWith(sampleSnapshot(sampleTask({ stopAcknowledged: true })))
  })

  it('observes owned lifecycle result state for durable receipt revocation even before the final read', async () => {
    const observed = vi.fn(async () => undefined)
    const { client, api } = await connect(undefined, { onSnapshotObserved: observed })
    vi.mocked(api.command).mockResolvedValue({ ok: true, taskId: 'task-a', state: sampleSnapshot(sampleTask({ stopAcknowledged: true })) })
    await client.callTool({ name: 'acknowledge_stop', arguments: { taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 1 } })
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ tasks: { 'task-a': expect.objectContaining({ stopAcknowledged: true }) } }))
  })

  it('does not bind same-revision acceptance when the fresh reservation differs', async () => {
    const { client, api, onTaskAccepted } = await connect()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ scopes: [{ path: 'another.ts', kind: 'file' }] })))
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })).editingAllowed).toBe(false)
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('does not bind an unchanged revision when the server failed to commit qualified whole-file fallback', async () => {
    const { client, api, onTaskAccepted } = await connect(async () => ({ scopes: [{ path: 'source.ts', kind: 'file' }], warnings: ['Whole-file fallback'] }))
    const underscoped = sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] }))
    vi.mocked(api.command).mockResolvedValue({ ok: true, taskId: 'task-a', state: underscoped })
    vi.mocked(api.snapshot).mockResolvedValue(underscoped)
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })).editingAllowed).toBe(false)
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('compares normalized path sets and commit casing when checking authoritative scope equivalence', async () => {
    const { client, onTaskAccepted } = await connect()
    const task = { ...proposal(), baseCommit: 'A'.repeat(40), scopes: [{ path: 'SOURCE.TS', kind: 'file' as const }, { path: 'source.ts', kind: 'file' as const }] }
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task } })).editingAllowed).toBe(true)
    expect(onTaskAccepted).toHaveBeenCalledTimes(1)
  })

  it('does not bind another proposal that happens to share task identity and revision', async () => {
    const { client, api, onTaskAccepted } = await connect()
    const other = sampleSnapshot(sampleTask({ branch: 'feat/other-work' }))
    vi.mocked(api.command).mockResolvedValue({ ok: true, taskId: 'task-a', state: other })
    vi.mocked(api.snapshot).mockResolvedValue(other)
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })).editingAllowed).toBe(false)
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('sends conservative qualified scopes instead of an unverified symbol and reports the fallback', async () => {
    const scopes: Scope[] = [{ path: 'source.ts', kind: 'file' }]
    const { client, api } = await connect(async () => ({ scopes, warnings: ['Parser could not qualify the symbol; whole file reserved.'] }))
    const response = parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } }))
    expect(api.command).toHaveBeenCalledWith({ type: 'register_task', task: { ...proposal(), scopes } })
    expect(response.scopeWarnings).toEqual(['Parser could not qualify the symbol; whole file reserved.'])
  })

  it('does not submit any task when repository scope qualification fails', async () => {
    const { client, api, onTaskAccepted } = await connect(async () => { throw new Error('unsafe repository path') })
    const response = await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })
    expect(response.isError).toBe(true)
    expect(api.command).not.toHaveBeenCalled()
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('does not revive a cancelled task from a historical registration success', async () => {
    const { client, api, onTaskAccepted } = await connect()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ revision: 2, status: 'cancelled' })))
    const response = await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })
    expect(parse(response)).toMatchObject({ editingAllowed: false, task: { status: 'cancelled' } })
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('does not authorize a newly blocked registration or unauthoritative observation', async () => {
    const { client, api, onTaskAccepted } = await connect()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ status: 'blocked', conflicts: ['task-b'] })))
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })).editingAllowed).toBe(false)
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask(), { hasAuthority: false }))
    expect(parse(await client.callTool({ name: 'submit_task', arguments: { task: proposal() } })).editingAllowed).toBe(false)
    expect(onTaskAccepted).not.toHaveBeenCalled()
  })

  it('rejects malformed symbol scopes at the MCP boundary without sending a command', async () => {
    const { client, api } = await connect()
    const task = { ...proposal(), scopes: [{ kind: 'symbol', path: 'source.ts' }] }
    const response = await client.callTool({ name: 'submit_task', arguments: { task } })
    expect(response.isError).toBe(true)
    expect(api.command).not.toHaveBeenCalled()
  })

  it('rejects impersonation and revisions replacing another task identity', async () => {
    const { client, api } = await connect()
    const registration = await client.callTool({ name: 'submit_task', arguments: { task: { ...proposal(), ownerId: 'other' } } })
    expect(registration.isError).toBe(true)
    const revision = await client.callTool({ name: 'revise_task', arguments: { taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 1, task: { ...proposal(), id: 'another-task' } } })
    expect(revision.isError).toBe(true)
    expect(api.command).not.toHaveBeenCalled()
  })

  it.each(['acknowledge_stop', 'report_completion', 'cancel_task'] as const)('allows owned %s requests while a task is blocked and forwards exact revision', async type => {
    const { client, api } = await connect()
    vi.mocked(api.snapshot).mockResolvedValue(sampleSnapshot(sampleTask({ status: 'blocked', revision: 2 })))
    const input = { taskId: 'task-a', ownerId: 'owner-a', expectedRevision: 2 }
    await client.callTool({ name: type, arguments: input })
    expect(api.command).toHaveBeenCalledWith({ type, ...input })
  })

  it('returns a redacted protocol error when the coordinator is unavailable', async () => {
    const { client, api } = await connect()
    vi.mocked(api.snapshot).mockRejectedValue(new Error('a-secret-token-must-not-escape'))
    const response = await client.callTool({ name: 'read_plan', arguments: {} })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).not.toContain('a-secret-token')
    expect(parse(response)).toHaveProperty('error.code', 'unavailable')
  })
})
