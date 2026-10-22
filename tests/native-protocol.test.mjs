import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const waitFor = async predicate => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('The native coordinator did not establish authority')
}

const start = (directory, id = 'protocol-test') => {
  const child = spawn(resolve('native/coordinator/bin/coordinator'), [
    '--id', id, '--data-dir', directory, '--bootstrap-if-new',
    '--api-address', '127.0.0.1:0', '--raft-address', '127.0.0.1:0',
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Native readiness timed out')), 10000)
    const lines = createInterface({ input: child.stdout })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Native coordinator exited before readiness')) })
    lines.once('line', line => {
      clearTimeout(timer)
      lines.close()
      try { resolveReady(JSON.parse(line)) } catch { reject(new Error('Invalid native readiness')) }
    })
  })
  return { child, ready }
}

const stop = async child => {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}

test('native API, durable restart, and actual stdio MCP share current task state', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-pr-protocol-'))
  const data = join(directory, 'data')
  const instance = start(data)
  let child = instance.child
  let mcp
  try {
    let endpoint = await instance.ready
    const request = async (route, body) => {
      const response = await fetch(`${endpoint.url}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 200, `Unexpected HTTP status for ${route}`)
      return response.json()
    }
    const snapshot = () => request('/v1/snapshot')
    const command = async command => {
      const result = await request('/v1/commands', { requestId: randomUUID(), command })
      assert.equal(result.ok, true, result.error?.message)
      return result
    }
    await waitFor(async () => (await snapshot()).hasAuthority)
    await t.test('missing credentials are rejected', async () => {
      const response = await fetch(`${endpoint.url}/v1/snapshot`)
      assert.equal(response.status, 401)
    })
    await command({ type: 'set_plan', expectedRevision: 0, markdown: 'Coordinate parser and formatter work.' })
    const proposal = (id, symbol) => ({
      id, ownerId: 'alice', sessionId: 'session-a', agent: 'codex',
      branch: `agent/${id}`, baseCommit: 'a'.repeat(40),
      description: `Implement ${symbol} with isolated tests`, planRevision: 1,
      scopes: [{ path: 'src/service.ts', kind: 'symbol', symbol }],
    })
    await command({ type: 'register_task', task: proposal('parser', 'service.parse') })
    await command({ type: 'register_task', task: proposal('formatter', 'service.format') })
    await t.test('different functions coexist but overlapping registration blocks both holders', async () => {
      assert.equal((await snapshot()).tasks.formatter.status, 'active')
      await command({ type: 'register_task', task: { ...proposal('overlap', 'service.parse'), ownerId: 'bob', sessionId: 'session-b' } })
      const current = await snapshot()
      assert.equal(current.tasks.parser.status, 'blocked')
      assert.equal(current.tasks.overlap.status, 'blocked')
      assert.equal(current.tasks.formatter.status, 'active')
    })
    await t.test('a merged PR cannot release an active reservation before stopped completion', async () => {
      const current = (await snapshot()).tasks.formatter
      await command({ type: 'mark_pr_merged', taskId: current.id, expectedRevision: current.revision })
      assert.equal((await snapshot()).tasks.formatter.status, 'active')
    })

    const endpointFile = join(directory, 'endpoint.json')
    const contextFile = join(directory, 'session.json')
    await writeFile(endpointFile, JSON.stringify(endpoint), { mode: 0o600 })
    await writeFile(contextFile, JSON.stringify({
      repositoryRoot: directory, ownerId: 'charlie', sessionId: 'session-c', agent: 'codex',
    }), { mode: 0o600 })
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'src/independent.ts'), 'export const independent = true\n')
    mcp = new Client({ name: 'native-protocol-test', version: '1.0.0' })
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/integrations/cli.js'), 'mcp', '--endpoint-file', endpointFile, '--context-file', contextFile],
      stderr: 'pipe',
    }))
    await t.test('bundled MCP exposes planning and PR links without a merge-assertion tool', async () => {
      const names = (await mcp.listTools()).tools.map(tool => tool.name)
      assert.equal(names.length, 12)
      for (const name of ['repository_status', 'list_symbols', 'link_pull_request']) assert.ok(names.includes(name))
      assert.equal(names.includes('mark_pr_merged'), false)
    })
    await t.test('real stdio MCP reads the native plan and binds accepted scope to a private session', async () => {
      const planResult = await mcp.callTool({ name: 'read_plan', arguments: {} })
      const plan = JSON.parse(planResult.content[0].text)
      assert.equal(plan.plan.revision, 1)
      assert.equal(plan.hasAuthority, true)
      const result = await mcp.callTool({ name: 'submit_task', arguments: { task: {
        id: 'mcp-task', ownerId: 'charlie', sessionId: 'session-c', agent: 'codex',
        branch: 'agent/mcp', baseCommit: 'a'.repeat(40), description: 'Implement the independent module.',
        planRevision: 1, scopes: [{ path: 'src/independent.ts', kind: 'file' }],
      } } })
      const registered = JSON.parse(result.content[0].text)
      assert.equal(registered.editingAllowed, true)
      const context = JSON.parse(await readFile(contextFile, 'utf8'))
      assert.equal(context.taskId, 'mcp-task')
      assert.equal(context.revision, (await snapshot()).tasks['mcp-task'].revision)
    })
    await mcp.close()
    mcp = undefined

    await t.test('helper restart restores the same history and authority without replacing membership', async () => {
      await stop(child)
      const restarted = start(data)
      child = restarted.child
      endpoint = await restarted.ready
      await waitFor(async () => (await snapshot()).hasAuthority)
      const restored = await snapshot()
      assert.equal(restored.plan.revision, 1)
      assert.equal(restored.tasks.parser.status, 'blocked')
      assert.equal(restored.tasks.formatter.prMerged, true)
      assert.equal(restored.tasks['mcp-task'].status, 'active')
      assert.equal(restored.members.length, 1)
    })
  } finally {
    await mcp?.close()
    await stop(child)
    await rm(directory, { recursive: true, force: true })
  }
})
