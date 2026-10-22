import { build } from 'esbuild'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CommandRequest, Scope, TaskProposal } from '../shared/contracts.js'
import { symbolAssetPaths } from '../symbols/index.js'
import { sampleContext, sampleSnapshot, sampleTask } from './fixtures.test-support.js'
import { receiptContext, signedReceipt } from './receipt-fixtures.test-support.js'

describe('bundled integration process', () => {
  const state = {
    directory: '', repository: '', bundle: '', assets: '', endpointFile: '', contextFile: '', url: '',
    snapshot: sampleSnapshot(), commands: [] as CommandRequest[],
  }
  const source = 'export function save() { const value = true; return value }\nexport function load() { return true }\n'
  const token = 'test_private_local_token_'.repeat(2)
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/snapshot') {
      response.end(JSON.stringify(state.snapshot))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/task-receipt?taskId=task-a&revision=1') {
      response.end(JSON.stringify(signedReceipt(state.snapshot.tasks['task-a'])))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/commands') {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.once('end', () => {
        const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CommandRequest
        state.commands.push(submitted)
        if (submitted.command.type === 'bind_repository') {
          state.snapshot = { ...state.snapshot, repository: submitted.command.repository }
          response.end(JSON.stringify({ ok: true, state: state.snapshot }))
          return
        }
        if ('task' in submitted.command) {
          const task = { ...sampleTask(), ...submitted.command.task }
          state.snapshot = sampleSnapshot(task, { repository: state.snapshot.repository })
          response.end(JSON.stringify({ ok: true, taskId: task.id, state: state.snapshot }))
          return
        }
        response.end(JSON.stringify({ ok: true, state: state.snapshot }))
      })
      return
    }
    response.writeHead(404).end()
  })

  beforeAll(async () => {
    state.directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-cli-')))
    state.repository = path.join(state.directory, 'repository')
    state.bundle = path.join(state.directory, 'dist', 'integrations', 'cli.mjs')
    state.assets = path.join(state.directory, 'dist', 'parser-assets')
    state.endpointFile = path.join(state.directory, 'endpoint.json')
    state.contextFile = path.join(state.directory, 'session.json')
    await Promise.all([mkdir(state.repository), mkdir(state.assets, { recursive: true })])
    const parserAssets = symbolAssetPaths('typescript')
    await Promise.all([
      copyFile(parserAssets.binding, path.join(state.assets, 'web-tree-sitter.mjs')),
      copyFile(parserAssets.runtime, path.join(state.assets, 'web-tree-sitter.wasm')),
      copyFile(parserAssets.grammar, path.join(state.assets, 'tree-sitter-typescript.wasm')),
    ])
    await build({
      entryPoints: ['src/integrations/cli.ts'], outfile: state.bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      banner: { js: 'import { createRequire as __testCreateRequire } from "node:module"; const require = __testCreateRequire(import.meta.url);' },
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test service address')
    state.url = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    state.snapshot = sampleSnapshot()
    state.commands = []
    await writeFile(state.endpointFile, JSON.stringify({ url: state.url, token }), { mode: 0o600 })
    await writeFile(state.contextFile, JSON.stringify(sampleContext(state.repository)), { mode: 0o600 })
    await writeFile(path.join(state.repository, 'source.ts'), source)
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(state.directory, { recursive: true, force: true })
  })

  const run = (agent: string, input: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [state.bundle, 'hook', '--agent', agent, '--endpoint-file', state.endpointFile, '--context-file', state.contextFile], { cwd: state.directory })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(input)
  })

  const nativeInput = (tool: string, input: Record<string, unknown>, cwd = state.repository) => JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 'session-a', cwd, tool_name: tool, tool_input: input,
  })

  const submit = async (scopes: Scope[], lan = false) => {
    await writeFile(state.contextFile, JSON.stringify({ ...(lan ? receiptContext(state.repository) : sampleContext(state.repository)), taskId: undefined, revision: undefined }))
    state.snapshot = { ...state.snapshot, tasks: {} }
    const client = new Client({ name: 'stdio-test', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath, args: [state.bundle, 'mcp', '--endpoint-file', state.endpointFile, '--context-file', state.contextFile], stderr: 'pipe' })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools).toHaveLength(12)
      const { revision, status, stopAcknowledged, prMerged, conflicts, ...task } = sampleTask()
      return await client.callTool({ name: 'submit_task', arguments: { task: { ...task, scopes } satisfies TaskProposal } })
    } finally {
      await client.close()
    }
  }

  const responseValue = (response: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((response.content as Array<{ text: string }>)[0].text)

  it('runs real stdio MCP and binds the exact parser-qualified accepted task context', async () => {
    const response = await submit([{ path: 'source.ts', kind: 'symbol', symbol: 'save' }])
    expect(response.isError).toBe(false)
    expect(responseValue(response)).toMatchObject({ editingAllowed: true, scopeWarnings: [], task: { scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] } })
    expect(state.commands[0].command).toMatchObject({ type: 'register_task', task: { scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] } })
    expect(JSON.parse(await readFile(state.contextFile, 'utf8'))).toMatchObject({ repositoryRoot: state.repository, taskId: 'task-a', revision: 1 })
  })

  it.each(['missing', 'ambiguous', 'new-file'] as const)('commits explicit whole-file scope for a %s symbol instead of silently preserving its requested scope', async kind => {
    if (kind === 'ambiguous') await writeFile(path.join(state.repository, 'source.ts'), 'function run(value: string): string;\nfunction run(value: number): number;\nfunction run(value: any) { return value }')
    const file = kind === 'new-file' ? 'planned.ts' : 'source.ts'
    const response = responseValue(await submit([{ path: file, kind: 'symbol', symbol: kind === 'ambiguous' ? 'run' : 'plannedAddition' }]))
    expect(response).toMatchObject({ editingAllowed: true, task: { scopes: [{ path: file, kind: 'file' }] } })
    expect(response.scopeWarnings).toHaveLength(1)
    expect(state.commands[0].command).toMatchObject({ task: { scopes: [{ path: file, kind: 'file' }] } })
  })

  it('sends no mutation when selected-repository scope inspection rejects a symlink alias', async () => {
    await symlink(path.join(state.repository, 'source.ts'), path.join(state.repository, 'alias.ts'))
    const response = await submit([{ path: 'alias.ts', kind: 'symbol', symbol: 'save' }])
    expect(response.isError).toBe(true)
    expect(state.commands).toEqual([])
    expect(JSON.parse(await readFile(state.contextFile, 'utf8'))).not.toHaveProperty('taskId')
  })

  it('admits actual bundled native Edit/Write/MultiEdit payloads only inside the parsed reserved function', async () => {
    state.snapshot = sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] }))
    for (const [tool, input] of [
      ['Edit', { old_string: 'const value = true', new_string: 'const value = false' }],
      ['Write', { content: source.replace('const value = true', 'const value = false') }],
      ['MultiEdit', { edits: [{ old_string: 'const value', new_string: 'const answer' }, { old_string: 'return value', new_string: 'return answer' }] }],
    ] as const) {
      const result = await run('claude-code', nativeInput(tool, { file_path: path.join(state.repository, 'source.ts'), ...input }))
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({})
    }
    const outside = await run('claude-code', nativeInput('Edit', { file_path: path.join(state.repository, 'source.ts'), old_string: 'load() { return true', new_string: 'load() { return false' }))
    expect(outside.code).toBe(2)
    expect(JSON.parse(outside.stdout)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny')
    expect(await readFile(path.join(state.repository, 'source.ts'), 'utf8')).toBe(source)
  })

  it('refuses an identically named file from another clone and a symbol edit with missing packaged parser assets', async () => {
    state.snapshot = sampleSnapshot(sampleTask({ scopes: [{ path: 'source.ts', kind: 'symbol', symbol: 'save' }] }))
    const other = path.join(state.directory, 'other-clone')
    await mkdir(other)
    await writeFile(path.join(other, 'source.ts'), source)
    const foreign = await run('claude-code', nativeInput('Edit', { file_path: path.join(other, 'source.ts'), old_string: 'const value = true', new_string: 'const value = false' }, other))
    expect(foreign.code).toBe(2)
    const binding = path.join(state.assets, 'web-tree-sitter.mjs')
    await rename(binding, `${binding}.missing`)
    try {
      const unavailable = await run('claude-code', nativeInput('Edit', { file_path: path.join(state.repository, 'source.ts'), old_string: 'const value = true', new_string: 'const value = false' }))
      expect(unavailable.code).toBe(2)
    } finally {
      await rename(`${binding}.missing`, binding)
    }
  })

  it('prints one native JSON denial and exits 2 for malformed stdin without leaking credentials', async () => {
    const result = await run('claude-code', '{broken JSON')
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny')
    expect(result.stdout + result.stderr).not.toContain(token)
  })

  it('keeps coordination callable as a real hook process with an unbound task', async () => {
    await writeFile(state.contextFile, JSON.stringify({ ...sampleContext(state.repository), taskId: undefined, revision: undefined }))
    const result = await run('claude-code', nativeInput('mcp__agent_pr_monitor__read_plan', {}))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })

  it('fails closed when its endpoint setup file cannot be read', async () => {
    await rm(state.endpointFile)
    const result = await run('cursor', '{}')
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toHaveProperty('permission', 'deny')
  })

  it('binds the actual clone origin, persists a signed receipt, continues with the app closed, and remembers a later stop', async () => {
    const git = promisify(execFile)
    await git('git', ['init', '--quiet', state.repository])
    await git('git', ['-C', state.repository, 'remote', 'add', 'origin', 'https://github.com/acme/project.git'])
    const response = responseValue(await submit([{ path: 'source.ts', kind: 'symbol', symbol: 'save' }], true))
    expect(response).toMatchObject({ editingAllowed: true, offlineContinuation: true })
    expect(state.commands.map(request => request.command.type)).toEqual(['bind_repository', 'register_task'])
    expect(JSON.parse(await readFile(state.contextFile, 'utf8')).acceptedOfflineReceipt).toBeDefined()
    const input = nativeInput('Edit', { file_path: 'source.ts', old_string: 'const value = true', new_string: 'const value = false' })
    await rm(state.endpointFile)
    expect((await run('claude-code', input)).code).toBe(0)
    await writeFile(state.endpointFile, '{invalid endpoint', { mode: 0o600 })
    expect((await run('claude-code', input)).code).toBe(2)
    await writeFile(state.endpointFile, JSON.stringify({ url: state.url, token }), { mode: 0o600 })
    state.snapshot = { ...state.snapshot, hasAuthority: false, tasks: { 'task-a': { ...state.snapshot.tasks['task-a'], status: 'blocked', conflicts: ['other'] } } }
    expect((await run('claude-code', input)).code).toBe(2)
    expect(JSON.parse(await readFile(state.contextFile, 'utf8')).acceptedOfflineReceipt).toBeUndefined()
    await rm(state.endpointFile)
    expect((await run('claude-code', input)).code).toBe(2)
  })
})
