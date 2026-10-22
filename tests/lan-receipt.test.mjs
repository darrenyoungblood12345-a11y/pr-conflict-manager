import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const execFileAsync = promisify(execFile)
const native = resolve('native/coordinator/bin/coordinator')
const integration = resolve('dist/integrations/cli.js')
const repository = { owner: 'acme', repo: 'project' }

const parseJson = (text, message) => {
  try { return JSON.parse(text) } catch { throw new Error(message) }
}

const waitFor = async (description, predicate) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(description)
}

const privateJson = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 })

const verifier = password => {
  const salt = randomBytes(16)
  return {
    salt: salt.toString('base64url'),
    key: scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url'),
  }
}

const generateIdentity = async (workspaceId, deviceId) => {
  try {
    const result = await execFileAsync(native, ['--generate-lan-identity', '--workspace-id', workspaceId, '--id', deviceId], { timeout: 10000 })
    return parseJson(result.stdout, 'Native identity output was invalid')
  } catch { throw new Error('Native identity generation failed') }
}

const startNative = async (directory, id, config, bootstrap = false) => {
  const child = spawn(native, [
    '--id', id, '--data-dir', directory, '--lan-config-stdin', '--exit-on-stdin-close',
    ...(bootstrap ? ['--bootstrap-if-new'] : []),
  ], { stdio: ['pipe', 'pipe', 'ignore'] })
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('LAN native readiness timed out')) }, 15000)
    const lines = createInterface({ input: child.stdout })
    const fail = () => { clearTimeout(timer); lines.close(); reject(new Error('LAN helper failed before readiness')) }
    child.once('error', fail)
    child.once('exit', fail)
    child.stdin.on('error', fail)
    lines.once('line', line => {
      clearTimeout(timer)
      lines.close()
      child.removeListener('error', fail)
      child.removeListener('exit', fail)
      child.stdin.removeListener('error', fail)
      try { resolveReady(parseJson(line, 'Invalid LAN readiness')) } catch { child.kill('SIGKILL'); reject(new Error('Invalid LAN readiness')) }
    })
    child.stdin.write(JSON.stringify(config) + '\n')
  }).catch(error => { child.kill('SIGKILL'); throw error })
  if (ready.lan?.deviceId !== id) { child.kill('SIGKILL'); throw new Error('Native readiness identity did not match') }
  return { child, ready }
}

const stopNative = async instance => {
  const child = instance?.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  child.stdin.end()
  try { await exited } finally { clearTimeout(timer) }
}

const api = ready => async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(ready.url + route, {
    method, headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(7000),
  })
  assert.equal(response.status, 200, `Unexpected native status for ${route}`)
  return response.json()
}

const command = async (request, value) => {
  const result = await request('/v1/commands', { requestId: randomUUID(), command: value })
  assert.ok(result.ok === true, 'Native command was rejected')
  return result
}

const hint = ready => ({ deviceId: ready.lan.deviceId, controlUrl: ready.lan.controlUrl, raftEndpoint: ready.lan.raftEndpoint })
const endpoint = ready => ({ url: ready.url, token: ready.token })

const hook = (endpointFile, contextFile, repositoryRoot, sessionId, edit) => new Promise((resolveHook, reject) => {
  const child = spawn(process.execPath, [integration, 'hook', '--agent', 'claude-code', '--endpoint-file', endpointFile, '--context-file', contextFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Bundled hook timed out')) }, 10000)
  child.once('error', () => { clearTimeout(timer); reject(new Error('Bundled hook could not start')) })
  child.stdin.on('error', () => undefined)
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  // A regression must not echo a context, receipt, or credential into test logs.
  child.stderr.resume()
  child.once('close', code => {
    clearTimeout(timer)
    try { resolveHook({ code, output: parseJson(stdout, 'Invalid bundled hook output') }) } catch { reject(new Error('Bundled hook did not return valid JSON')) }
  })
  child.stdin.end(JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit,
    session_id: sessionId, cwd: repositoryRoot,
  }))
})

const editFunction = name => ({
  file_path: 'src/service.ts',
  old_string: `export function ${name}() { return true }`,
  new_string: `export function ${name}() { return false }`,
})

const assertAllowed = result => {
  assert.equal(result.code, 0, 'Bundled hook refused an expected accepted-scope edit')
  assert.ok(result.output && Object.keys(result.output).length === 0, 'Allowed hook output unexpectedly contained fields')
}

const assertDenied = result => {
  assert.equal(result.code, 2)
  assert.ok(result.output?.hookSpecificOutput?.permissionDecision === 'deny', 'Denied hook output omitted its denial')
}

test('real LAN receipt crosses bundled MCP, offline gates, and durable revocation', { timeout: 90000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-pr-lan-receipt-')))
  const repositoryRoot = join(directory, 'clone')
  const endpointFile = join(directory, 'endpoint.json')
  const contextFile = join(directory, 'session.json')
  const password = randomBytes(32).toString('base64url')
  const workspaceId = randomUUID()
  const firstId = randomUUID()
  const secondId = randomUUID()
  const sessionId = randomUUID()
  const firstData = join(directory, 'first')
  const secondData = join(directory, 'second')
  const children = []
  let mcp
  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true })
    const source = 'export function save() { return true }\nexport function load() { return true }\n'
    await writeFile(join(repositoryRoot, 'src/service.ts'), source)
    const git = args => execFileAsync('git', [
      '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repositoryRoot, ...args,
    ], { timeout: 10000, env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    } })
    await git(['init', '--quiet', '--initial-branch=main'])
    await git(['remote', 'add', 'origin', 'https://github.com/acme/project.git'])
    await git(['add', 'src/service.ts'])
    await git(['-c', 'user.name=LAN receipt fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'test: initialize disposable fixture'])
    await git(['checkout', '--quiet', '-b', 'agent/receipt'])
    const baseCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()

    const firstIdentity = await generateIdentity(workspaceId, firstId)
    const secondIdentity = await generateIdentity(workspaceId, secondId)
    const firstConfig = { version: 1, workspaceId, identity: firstIdentity, passwordVerifier: verifier(password), listenHost: '127.0.0.1', controlPort: 0, raftPort: 0, peerHints: [] }
    const first = await startNative(firstData, firstId, firstConfig, true)
    children.push(first)
    const firstRequest = api(first.ready)
    await waitFor('Creator did not establish active LAN authority', async () => (await firstRequest('/v1/lan/status')).stage === 'active')
    const secondConfig = {
      ...firstConfig, identity: secondIdentity, passwordVerifier: verifier(password), peerHints: [hint(first.ready)],
      join: { controlUrl: first.ready.lan.controlUrl, deviceId: firstId, trustedCaCertPEM: firstIdentity.caCertPEM, password, requestId: randomUUID() },
    }
    let second = await startNative(secondData, secondId, secondConfig)
    children.push(second)
    let secondRequest = api(second.ready)
    await waitFor('Joining native Mac did not become a verified voter', async () => {
      const status = await secondRequest('/v1/lan/status')
      return status.stage === 'active' && status.joinAttempt === 'verified'
    })
    await waitFor('Follower did not forward quorum-backed reads', async () => (await secondRequest('/v1/snapshot')).hasAuthority)
    await privateJson(endpointFile, endpoint(second.ready))
    await privateJson(contextFile, {
      repositoryRoot, ownerId: 'receipt-owner', sessionId, agent: 'claude-code',
      offlineAuthority: { workspaceId, deviceId: secondId, caCertPEM: secondIdentity.caCertPEM, repository },
    })

    mcp = new Client({ name: 'real-lan-receipt-test', version: '1.0.0' })
    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [integration, 'mcp', '--endpoint-file', endpointFile, '--context-file', contextFile], stderr: 'pipe',
    }))
    const tool = async (name, argumentsValue = {}) => {
      const result = await mcp.callTool({ name, arguments: argumentsValue })
      const value = parseJson(result.content[0].text, 'MCP returned invalid JSON')
      assert.ok(result.isError !== true, 'Bundled MCP rejected its expected coordination call')
      return value
    }
    assert.ok((await tool('read_plan')).hasAuthority === true, 'MCP did not obtain authoritative plan state')
    await tool('set_plan', { expectedRevision: 0, markdown: 'Change save only; preserve load and coordinate scopes before editing.' })
    const task = {
      id: 'accepted-lan-task', ownerId: 'receipt-owner', sessionId, agent: 'claude-code', branch: 'agent/receipt', baseCommit,
      description: 'Update the save function while preserving load and all other functions.', planRevision: 1,
      scopes: [{ path: 'src/service.ts', kind: 'symbol', symbol: 'save' }],
    }
    const registered = await tool('submit_task', { task })
    assert.ok(registered.editingAllowed === true, 'MCP did not accept the active task')
    assert.ok(registered.offlineContinuation === true, 'Real native receipt was not qualified by bundled MCP')
    const accepted = parseJson(await readFile(contextFile, 'utf8'), 'Accepted context was invalid')
    const receipt = accepted.acceptedOfflineReceipt
    assert.ok(receipt, 'MCP did not persist the actual native receipt')
    assert.ok(receipt.certPEM === secondIdentity.certPEM, 'Receipt signing certificate did not match its native device')
    const payload = parseJson(Buffer.from(receipt.payload, 'base64url').toString('utf8'), 'Native receipt payload was invalid')
    assert.ok(payload.issuerDeviceId === secondId, 'Native receipt issuer did not match')
    assert.ok(payload.workspaceId === workspaceId, 'Native receipt workspace did not match')
    assert.ok(payload.repository?.owner === repository.owner && payload.repository?.repo === repository.repo, 'Receipt repository binding did not match')
    assert.ok(payload.task.scopes[0].symbol === 'save', 'Fixture unexpectedly fell back to whole-file scope')
    await mcp.close()
    mcp = undefined
    await stopNative(second)
    await assert.rejects(fetch(second.ready.url + '/v1/snapshot', { signal: AbortSignal.timeout(1000) }))

    const runHook = name => hook(endpointFile, contextFile, repositoryRoot, sessionId, editFunction(name))
    await t.test('exact native receipt permits only its existing function offline', async () => {
      assertAllowed(await runHook('save'))
      assertDenied(await runHook('load'))
      assert.ok(await readFile(join(repositoryRoot, 'src/service.ts'), 'utf8') === source, 'Gate execution unexpectedly edited the fixture')
    })
    await t.test('a changed GitHub origin is denied despite the valid native signature', async () => {
      await git(['remote', 'set-url', 'origin', 'https://github.com/different/project.git'])
      assertDenied(await runHook('save'))
      await git(['remote', 'set-url', 'origin', 'https://github.com/acme/project.git'])
      assertAllowed(await runHook('save'))
    })
    await t.test('a modified native receipt signature cannot authorize offline editing', async () => {
      const signature = Buffer.from(receipt.signature, 'base64url')
      signature[0] ^= 1
      await privateJson(contextFile, { ...accepted, acceptedOfflineReceipt: { ...receipt, signature: signature.toString('base64url') } })
      assertDenied(await runHook('save'))
      await privateJson(contextFile, accepted)
      assertAllowed(await runHook('save'))
    })

    const resumedConfig = { ...secondConfig, join: undefined, peerHints: [hint(first.ready)] }
    second = await startNative(secondData, secondId, resumedConfig)
    children.push(second)
    secondRequest = api(second.ready)
    await firstRequest('/v1/lan/peer-hints', { peerHints: [hint(second.ready)] }, 'PUT')
    await privateJson(endpointFile, endpoint(second.ready))
    await waitFor('Two-voter quorum did not recover after real helper restart', async () => (await secondRequest('/v1/snapshot')).hasAuthority)
    await command(firstRequest, { type: 'register_task', task: { ...task, id: 'overlapping-native-task', ownerId: 'another-owner', sessionId: 'another-session' } })
    await t.test('fresh native conflict revokes the receipt durably across another disconnect', async () => {
      assertDenied(await runHook('save'))
      const revoked = parseJson(await readFile(contextFile, 'utf8'), 'Revoked context was invalid')
      assert.ok(revoked.acceptedOfflineReceipt === undefined, 'Fresh conflict did not remove the accepted receipt')
      assert.ok(revoked.offlineRevokedThrough[task.id] >= accepted.revision)
      await stopNative(second)
      assertDenied(await runHook('save'))
      // A stale receipt copied back later must not erase the durable stop floor.
      await privateJson(contextFile, { ...revoked, acceptedOfflineReceipt: receipt })
      assertDenied(await runHook('save'))
    })
  } finally {
    await mcp?.close()
    await Promise.all(children.map(stopNative))
    await rm(directory, { recursive: true, force: true })
  }
})
