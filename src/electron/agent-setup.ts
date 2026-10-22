import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { agentContextSchema, agentKindSchema } from '../integrations/schemas.js'
import { generateSetupSnippets } from '../integrations/setup.js'
import type { AgentKind, OfflineAuthority } from '../shared/contracts.js'
import type { AgentInstallation, AgentSetupEnvironment, PreparedAgentSetup } from '../shared/agent-setup.js'

interface AgentSetupOptions {
  userDataDirectory: string
  cliPath: string
  electronPath: string
  getRepositoryRoot(): string | undefined
  getEndpointFile(): string | undefined
  getOfflineAuthority?(): OfflineAuthority | undefined
  probeInstallations?: () => Promise<AgentInstallation[]>
}

const agentCommands: Record<AgentKind, string> = { codex: 'codex', cursor: 'cursor', opencode: 'opencode', 'claude-code': 'claude' }
const agents = agentKindSchema.options
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const requireAbsolutePath = (value: string) => {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Agent setup requires absolute, single-line local paths.')
}

const canonicalFuturePath = async (target: string): Promise<string> => {
  try { return await realpath(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.join(await canonicalFuturePath(path.dirname(target)), path.basename(target))
  }
}

const privateDirectory = async (directory: string) => {
  requireAbsolutePath(directory)
  if (directory === homedir() || directory === path.parse(directory).root) throw new Error('Select an app-specific private storage directory.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error('Agent setup storage must be an owned local directory.')
  await chmod(directory, 0o700)
}

const privateFile = async (file: string, executable = false) => {
  const metadata = await lstat(file)
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.() &&
    (metadata.mode & 0o077) === 0 && (!executable || (metadata.mode & 0o100) !== 0)
}

/** Hard-link publication is atomic and refuses an existing destination. */
const writeNewPrivateFile = async (file: string, contents: string, mode: number) => {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', mode)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.chmod(mode)
      await handle.sync()
    } finally { await handle.close() }
    await link(temporary, file)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
}

export const describeAgentInstallation = (agent: AgentKind, installation: AgentInstallation['installation'], version: string | null): AgentInstallation => {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)
  const belowClaudeMinimum = agent === 'claude-code' && parts && (
    parts[0] < 2 || (parts[0] === 2 && (parts[1] < 1 || (parts[1] === 1 && (parts[2] < 295 || (parts[2] === 295 && version?.includes('-'))))))
  )
  const limitations: Record<AgentKind, string[]> = {
    codex: ['Trust the exact project hook through /hooks.', 'Hosted/specialized tools and already-admitted commands may bypass subsequent gates.'],
    cursor: ['IDE Agent hooks need a trusted workspace and real-client verification.', 'Cursor CLI and Tab are not qualified surfaces.'],
    opencode: ['Plugin loading, native session identity, MCP names, and thrown-error denial need real-client verification.'],
    'claude-code': ['Failure blocking requires Claude Code 2.1.295 or later.', 'Native edits, hook trust, errors, and timeouts still need real-client verification.'],
  }
  return {
    agent, installation, version, qualification: belowClaudeMinimum ? 'version-blocked' : 'unverified',
    summary: belowClaudeMinimum ? 'Detected CLI is below the failure-blocking minimum.'
      : installation === 'detected' ? 'CLI detected; actual-client enforcement is unverified.'
        : installation === 'not-found' ? 'No CLI found in the inspected local installation paths.' : 'CLI exists, but its version could not be verified.',
    limitations: [...limitations[agent], 'No agent is certified fully supported by this setup panel. Shell/delegation, offline continuation, and all-client enforcement remain release gates.'],
  }
}

const readVersion = (executable: string): Promise<string | null> => new Promise(resolve => {
  execFile(executable, ['--version'], { timeout: 2000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    if (error) return resolve(null)
    // Display only the version token, never arbitrary client stdout/stderr.
    resolve(stdout.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] ?? null)
  })
})

export const probeAgentInstallations = async (excludedRepository?: string): Promise<AgentInstallation[]> => {
  const directories = [...new Set([
    ...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.opencode', 'bin'),
  ].filter(directory => path.isAbsolute(directory) && !/[\r\n\0]/.test(directory) &&
    (!excludedRepository || !isInside(excludedRepository, directory))))]
  const results = await Promise.allSettled(agents.map(async agent => {
    const candidates = [
      ...directories.map(directory => path.join(directory, agentCommands[agent])),
      ...(agent === 'codex' ? ['/Applications/Codex.app/Contents/Resources/codex'] : []),
    ]
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK)
        const canonical = await realpath(candidate)
        if (excludedRepository && isInside(excludedRepository, canonical)) continue
        const version = await readVersion(canonical)
        return describeAgentInstallation(agent, version ? 'detected' : 'unknown', version)
      } catch {
        // An absent installation does not justify guessing an installed version.
      }
    }
    return describeAgentInstallation(agent, 'not-found', null)
  }))
  return results.map((result, index) => result.status === 'fulfilled' ? result.value : describeAgentInstallation(agents[index], 'unknown', null))
}

export const createAgentSetupService = (options: AgentSetupOptions) => {
  const inspect = async (): Promise<AgentSetupEnvironment> => {
    const repositoryRoot = options.getRepositoryRoot() ?? null
    const endpointFile = options.getEndpointFile() ?? null
    const bridgeExists = await access(options.cliPath, constants.R_OK).then(() => true, () => false)
    const endpointReady = endpointFile ? await privateFile(endpointFile).catch(() => false) : false
    const reason = !repositoryRoot ? 'Choose this Mac’s clone in Worktree first.' : !endpointReady
      ? 'Start the coordination workspace before preparing agent setup.' : !bridgeExists
        ? 'The built integration bridge is missing. Build or reinstall the app.' : null
    return {
      repositoryRoot, endpointFile, ready: !reason, reason,
      agents: await (options.probeInstallations?.() ?? probeAgentInstallations(repositoryRoot ?? undefined)),
    }
  }

  const prepare = async (request: unknown): Promise<PreparedAgentSetup> => {
    const repositoryRoot = options.getRepositoryRoot()
    const endpointFile = options.getEndpointFile()
    if (!repositoryRoot || !endpointFile) throw new Error('Choose a clone and start the coordination workspace before preparing setup.')
    if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('Review the selected clone and agent session before preparing setup.')
    const { expectedRepositoryRoot, expectedEndpointFile, ...identity } = request as Record<string, unknown>
    if (expectedRepositoryRoot !== repositoryRoot || expectedEndpointFile !== endpointFile) throw new Error('The clone or workspace changed. Refresh setup before continuing.')
    const context = agentContextSchema.pick({ agent: true, ownerId: true, sessionId: true }).strict().safeParse(identity)
    if (!context.success) throw new Error('Use a supported agent and nonempty owner/session identifiers up to 128 characters (letters, numbers, _, ., :, -).')
    const paths = [options.userDataDirectory, options.cliPath, options.electronPath, repositoryRoot, endpointFile]
    paths.forEach(requireAbsolutePath)
    if (!await privateFile(endpointFile).catch(() => false)) throw new Error('The private integration endpoint is not ready.')
    await access(options.cliPath, constants.R_OK).catch(() => { throw new Error('The integration bridge is missing. Build or reinstall the app.') })
    const root = await realpath(repositoryRoot)
    if (isInside(root, await canonicalFuturePath(options.userDataDirectory))) throw new Error('Private agent setup storage must be outside the repository.')
    await privateDirectory(options.userDataDirectory)
    const storage = await realpath(options.userDataDirectory)
    if (isInside(root, storage)) throw new Error('Private agent setup storage must be outside the repository.')
    const sessionDirectory = path.join(storage, 'sessions')
    const launcherDirectory = path.join(storage, 'agent-launchers')
    await privateDirectory(sessionDirectory)
    await privateDirectory(launcherDirectory)
    const launcherContents = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(options.electronPath)} "$@"\n`
    const digest = createHash('sha256').update(launcherContents).digest('hex').slice(0, 24)
    const launcherFile = path.join(launcherDirectory, `electron-node-${digest}.sh`)
    try {
      await writeNewPrivateFile(launcherFile, launcherContents, 0o700)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await privateFile(launcherFile, true) || await readFile(launcherFile, 'utf8') !== launcherContents) {
        throw new Error('The private agent launcher could not be prepared safely.')
      }
    }
    const contextFile = path.join(sessionDirectory, `${randomUUID()}.json`)
    const snippets = generateSetupSnippets(context.data.agent, {
      nodePath: launcherFile, cliPath: options.cliPath, endpointFile, contextFile,
    })
    const offlineAuthority = options.getOfflineAuthority?.()
    const boundContext = agentContextSchema.parse({ ...context.data, repositoryRoot: root,
      ...(offlineAuthority ? { offlineAuthority } : {}),
    })
    const contents = `${JSON.stringify(boundContext, null, 2)}\n`
    // Verify the workspace/clone did not change while private setup was being prepared.
    if (options.getRepositoryRoot() !== repositoryRoot || options.getEndpointFile() !== endpointFile) {
      throw new Error('The clone or workspace changed. Review it before preparing agent setup again.')
    }
    await writeNewPrivateFile(contextFile, contents, 0o600)
    if (options.getRepositoryRoot() !== repositoryRoot || options.getEndpointFile() !== endpointFile) {
      await unlink(contextFile)
      throw new Error('The clone or workspace changed. Review it before preparing agent setup again.')
    }
    return { ...snippets, repositoryRoot: root, contextFile, endpointFile, launcherFile }
  }

  return { inspect, prepare }
}
