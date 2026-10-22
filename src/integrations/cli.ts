import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createWorkspaceClient, WorkspaceConnectionError } from '../shared/client.js'
import type { AgentKind, EndpointConfig, WorkspaceApi } from '../shared/contracts.js'
import { createWorkspaceMcpServer } from './mcp.js'
import { agentKindSchema } from './schemas.js'
import { createOpenCodeGate, nativeHookOutput, runNativeHook } from './hooks.js'
import { generateSetupSnippets } from './setup.js'
import { qualifyTaskScopes } from './scope-qualification.js'
import { acceptContext, loadContext, observeContext, readPrivateJson } from './context-store.js'
import { ensureRepositoryBinding } from './repository-guard.js'

const endpointSchema = z.object({ url: z.string().url(), token: z.string().min(32) }).strict()
const loadEndpoint = async (file: string): Promise<EndpointConfig> => endpointSchema.parse(await readPrivateJson(file))
const parserOptions = () => ({ assetDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'parser-assets') })
const loadApi = async (file: string): Promise<WorkspaceApi> => {
  try { return createWorkspaceClient(await loadEndpoint(file)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const unavailable = async (): Promise<never> => { throw new WorkspaceConnectionError('The local app is closed', true, true) }
    return { snapshot: unavailable, command: unavailable }
  }
}

export const createOpenCodePluginFromFiles = async (options: { endpointFile: string; contextFile: string; cwd: string }) => {
  const context = await loadContext(options.contextFile)
  const api = await loadApi(options.endpointFile)
  return createOpenCodeGate(api, () => loadContext(options.contextFile), options.cwd, {
    ...parserOptions(), onSnapshotObserved: state => observeContext(options.contextFile, context, state),
  })
}

const readInput = async () => {
  const timeout = setTimeout(() => process.stdin.destroy(new Error('Hook input timed out')), 3000)
  try {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      chunks.push(chunk)
      if (chunks.reduce((size, item) => size + item.byteLength, 0) > 1024 * 1024) throw new Error('Hook input too large')
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

const parseArguments = (args: string[]) => {
  const [mode, ...rest] = args
  const pairs = rest.reduce<Record<string, string>>((all, item, index) => {
    if (index % 2 !== 0) return all
    if (!['--agent', '--endpoint-file', '--context-file'].includes(item) || !rest[index + 1] || rest[index + 1].startsWith('--') || all[item] !== undefined) throw new Error('Invalid arguments')
    return { ...all, [item]: rest[index + 1] }
  }, {})
  return { mode, pairs }
}

export const runIntegrationCli = async (args: string[]) => {
  const { mode, pairs } = parseArguments(args)
  const endpointFile = pairs['--endpoint-file'] ?? process.env.AGENT_MONITOR_ENDPOINT_FILE
  const contextFile = pairs['--context-file'] ?? process.env.AGENT_MONITOR_CONTEXT_FILE
  if (!endpointFile || !contextFile) throw new Error('Provide private endpoint-file and context-file paths')
  if (mode === 'snippets') {
    const agent = agentKindSchema.parse(pairs['--agent'])
    process.stdout.write(JSON.stringify(generateSetupSnippets(agent, {
      cliPath: path.resolve(process.argv[1]), endpointFile: path.resolve(endpointFile),
      contextFile: path.resolve(contextFile), nodePath: process.execPath,
    }), null, 2) + '\n')
    return
  }
  const context = await loadContext(contextFile)
  const api = await loadApi(endpointFile)
  if (mode === 'mcp') {
    const server = createWorkspaceMcpServer(api, {
      context,
      repositoryRoot: context.repositoryRoot,
      symbolOptions: parserOptions(),
      qualifyScopes: scopes => qualifyTaskScopes(context.repositoryRoot, scopes, parserOptions()),
      onTaskAccepted: (task, receipt) => acceptContext(contextFile, context, task, receipt).then(() => undefined),
      onSnapshotObserved: state => observeContext(contextFile, context, state),
      validateRepository: state => ensureRepositoryBinding(api, context.repositoryRoot, state, Boolean(context.offlineAuthority)),
    })
    await server.connect(new StdioServerTransport())
    return
  }
  if (mode === 'hook') {
    const agent = agentKindSchema.exclude(['opencode']).parse(pairs['--agent'])
    const { decision, output } = await runNativeHook(agent, api, context, await readInput(), {
      ...parserOptions(), onSnapshotObserved: state => observeContext(contextFile, context, state),
    })
    process.stdout.write(JSON.stringify(output) + '\n')
    if (!decision.allow) {
      process.stderr.write(decision.reason + '\n')
      process.exitCode = 2
    }
    return
  }
  throw new Error('Use mcp, hook, or snippets')
}

const main = () => runIntegrationCli(process.argv.slice(2)).catch(() => {
  // Never echo a token, endpoint file body, arbitrary payload, or parser error.
  const args = process.argv.slice(2)
  if (args[0] === 'hook') {
    const agentIndex = args.indexOf('--agent')
    const agent = args[agentIndex + 1] as Exclude<AgentKind, 'opencode'>
    if (['codex', 'cursor', 'claude-code'].includes(agent)) {
      process.stdout.write(JSON.stringify(nativeHookOutput(agent, { allow: false, reason: 'Agent PR Monitor setup or coordination is unavailable. Work is blocked.' })) + '\n')
    }
  }
  process.stderr.write('Agent PR Monitor setup or coordination is unavailable. No editing permission was granted.\n')
  process.exitCode = 2
})

const isEntrypoint = () => {
  try {
    return Boolean(process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1])))
  } catch {
    return false
  }
}

if (isEntrypoint()) void main()
