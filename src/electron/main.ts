import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createWorkspaceClient, validateEndpoint } from '../shared/client.js'
import type { EndpointConfig, Snapshot, WorkspaceApi } from '../shared/contracts.js'
import { isCommand, observedTaskSchema } from './validation.js'
import { observeTaskPullRequest } from './task-pull-request.js'
import { removeOwnedEndpointFile, removeStaleEndpointFile, writeEndpointFile } from './endpoint-file.js'
import { createRepositoryController } from './repository-controller.js'
import { qualifyTaskScopes } from '../integrations/scope-qualification.js'
import type { LanConfig, LanIdentity, WorkspaceProfile } from '../shared/lan.js'
import { createWorkspaceProfileStore, lanPasswordVerifier } from './workspace-profiles.js'
import { createWorkspacePool } from './workspace-pool.js'
import { createLanClient } from './lan-client.js'
import type { DesktopRuntime } from '../shared/desktop.js'
import { parseLanInvitation } from './lan-invitation.js'
import { createAgentSetupService } from './agent-setup.js'
import { ensureWorkspaceRepository } from './workspace-repository.js'
import { startLanDiscovery } from './lan-discovery.js'
import { githubIdentity } from '../shared/github-identity.js'

// The build emits a CommonJS Electron entry beside preload.cjs.
const directory = __dirname
const runtime: DesktopRuntime = {
  status: 'starting',
  message: 'Starting the local coordination helper…',
  workspaceKey: 'local', workspaceName: 'Local workspace', mode: 'local',
}
let window: BrowserWindow | null = null
let helper: ChildProcess | undefined
let client: WorkspaceApi | undefined
let ownedEndpoint: { file: string; config: EndpointConfig } | undefined
let shuttingDown = false
let helperGeneration = 0
let activeProfile: WorkspaceProfile | undefined
let lanClient: ReturnType<typeof createLanClient> | undefined
let initialStartup: Promise<void> = Promise.resolve()
let endpointPublication: Promise<void> = Promise.resolve()
let stopDiscovery: (() => void) | undefined
let lanMonitor: ReturnType<typeof setInterval> | undefined
const notifiedConflicts = new Set<string>()
const ownsApplicationLock = app.requestSingleInstanceLock()
const repository = createRepositoryController()

const removeEndpoint = async () => {
  const owned = ownedEndpoint
  ownedEndpoint = undefined
  delete runtime.endpointFile
  if (owned) await removeOwnedEndpointFile(owned.file, owned.config)
}

const unavailable = (message: string) => {
  runtime.status = 'unavailable'
  runtime.message = message
  client = undefined
  lanClient = undefined
}

const nativeExecutable = () => [
  path.join(process.resourcesPath, 'native', 'coordinator'),
  path.join(app.getAppPath(), 'native', 'coordinator', 'bin', 'coordinator'),
  path.join(app.getAppPath(), 'dist', 'native', 'coordinator'),
].find(existsSync)

const stopHelper = async () => {
  helperGeneration += 1
  stopDiscovery?.()
  stopDiscovery = undefined
  if (lanMonitor) clearInterval(lanMonitor)
  lanMonitor = undefined
  client = undefined
  lanClient = undefined
  await removeEndpoint()
  const child = helper
  helper = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

const startHelper = async (profile?: WorkspaceProfile, initialJoin?: LanConfig['join'], bootstrapNewWorkspace = false) => {
  const generation = ++helperGeneration
  const isCurrent = () => !shuttingDown && generation === helperGeneration
  let child: ChildProcess | undefined
  let startupEndpoint: EndpointConfig | undefined
  const withEndpointLock = <T>(work: () => Promise<T>) => {
    const pending = endpointPublication.then(work)
    endpointPublication = pending.then(() => undefined, () => undefined)
    return pending
  }
  runtime.status = 'starting'
  runtime.workspaceKey = profile?.id ?? 'local'
  runtime.workspaceName = profile?.name ?? 'Local workspace'
  runtime.mode = profile ? 'lan' : 'local'
  runtime.message = profile ? 'Connecting to the LAN workspace…' : 'Starting the local coordinator…'
  const dataDir = path.join(app.getPath('userData'), 'workspaces', profile?.id ?? 'local')
  const endpointFile = profile ? path.join(dataDir, 'integration-endpoint.json') : path.join(app.getPath('userData'), 'integration-endpoint.json')
  try {
    // The single-instance lock ensures this cannot remove an active app's handoff.
    await withEndpointLock(async () => { if (isCurrent()) await removeStaleEndpointFile(endpointFile) })
  } catch {
    if (isCurrent()) unavailable('The previous integration handoff could not be removed. Check app-directory permissions.')
    return
  }
  if (!isCurrent()) return
  const executable = nativeExecutable()
  if (!executable) {
    unavailable('The native coordinator is missing. Build the helper, then reopen the app.')
    return
  }

  try {
    const endpoint = await new Promise<EndpointConfig>((resolve, reject) => {
      child = spawn(executable, [
        ...(!profile || bootstrapNewWorkspace ? ['--bootstrap-if-new'] : []),
        ...(profile ? ['--lan-config-stdin'] : []),
        '--exit-on-stdin-close', '--id', profile?.deviceId ?? 'local',
        '--data-dir', dataDir,
        '--api-address', '127.0.0.1:0', '--raft-address', '127.0.0.1:0',
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      helper = child
      // Keep stdin open for the process lifetime. If Electron crashes, pipe EOF
      // tells the helper to shut down and release its persistent database lock.

      let buffer = ''
      let settled = false
      const finish = (error?: Error, value?: EndpointConfig) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else if (value) resolve(value)
      }
      const timeout = setTimeout(() => finish(new Error('The local coordinator did not become ready.')), 20000)
      child.on('error', () => finish(new Error('The local coordinator could not start.')))
      child.stdin?.on('error', () => finish(new Error('The local coordinator could not read its private startup configuration.')))
      child.on('exit', () => {
        finish(new Error('The local coordinator exited before becoming ready.'))
        if (!shuttingDown && generation === helperGeneration) {
          unavailable('The local coordinator stopped. Reopen the app to reconnect.')
          void removeEndpoint().catch(() => undefined)
        }
      })
      // Readiness contains a bearer credential. Never forward stdout or stderr to the UI/logs.
      child.stderr?.on('data', () => undefined)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        buffer += chunk.toString('utf8')
        if (buffer.length > 65536) {
          finish(new Error('The local coordinator returned an invalid readiness response.'))
          return
        }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          try {
            const value: unknown = JSON.parse(line)
            if (typeof value !== 'object' || value === null) return
            const config = value as Partial<EndpointConfig>
            if (typeof config.url !== 'string' || typeof config.token !== 'string') return
            const endpoint = { url: config.url, token: config.token }
            try {
              validateEndpoint(endpoint)
            } catch {
              finish(new Error('The local coordinator returned an unsafe endpoint.'))
              return
            }
            finish(undefined, endpoint)
          } catch {
            // Non-readiness lines are deliberately not logged.
          }
        })
      })
      if (profile) child.stdin?.write(JSON.stringify({ ...profile.config, ...(initialJoin ? { join: initialJoin } : {}) }) + '\n')
    })
    startupEndpoint = endpoint
    const published = await withEndpointLock(async () => {
      if (!isCurrent() || !child || child.exitCode !== null || child.signalCode !== null) return false
      await writeEndpointFile(endpointFile, endpoint)
      if (!isCurrent() || child.exitCode !== null || child.signalCode !== null) {
        await removeOwnedEndpointFile(endpointFile, endpoint)
        return false
      }
      ownedEndpoint = { file: endpointFile, config: endpoint }
      return true
    })
    if (!published || !isCurrent() || helper !== child || !child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The local coordinator stopped before integration setup completed.')
    }
    client = createWorkspaceClient(endpoint)
    lanClient = profile ? createLanClient(endpoint) : undefined
    runtime.endpointFile = endpointFile
    runtime.status = 'ready'
    runtime.message = profile ? 'LAN workspace · new work requires quorum' : 'Local development workspace · single-node coordination'
    if (profile && lanClient) {
      const target = lanClient
      let members: string[] = []
      let polling = false
      const monitor = async () => {
        if (polling || !isCurrent()) return
        polling = true
        try {
          const status = await target.status()
          if (!isCurrent()) return
          if (status.workspaceId !== profile.config.workspaceId || status.deviceId !== profile.deviceId) throw new Error('LAN identity mismatch')
          members = status.members.filter(member => member.stage !== 'removed').map(member => member.deviceId)
          if (!stopDiscovery) stopDiscovery = startLanDiscovery(status.public, () => members, hints => target.updateHints(hints), () => {
            if (isCurrent()) runtime.message = 'LAN workspace · discovery unavailable; saved peer addresses remain in use'
          })
        } catch {
          if (isCurrent()) runtime.message = 'LAN workspace · connection status is unavailable'
        } finally { polling = false }
      }
      void monitor()
      lanMonitor = setInterval(() => void monitor(), 2000)
    }
  } catch (error) {
    child?.kill('SIGTERM')
    if (startupEndpoint) await removeOwnedEndpointFile(endpointFile, startupEndpoint).catch(() => undefined)
    if (generation !== helperGeneration) return
    unavailable(error instanceof Error ? error.message : 'The local coordinator is unavailable.')
    await removeEndpoint().catch(() => undefined)
  }
}

const profiles = createWorkspaceProfileStore(path.join(app.getPath('userData'), 'profiles'), {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: value => safeStorage.encryptStringAsync(value),
  decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
})
const pool = createWorkspacePool({
  profiles,
  generateIdentity: (workspaceId, deviceId) => new Promise<LanIdentity>((resolve, reject) => {
    const executable = nativeExecutable()
    if (!executable) return reject(new Error('Build the native helper before creating a workspace.'))
    execFile(executable, ['--generate-lan-identity', '--workspace-id', workspaceId, '--id', deviceId], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    }, (error, stdout) => {
      if (error) return reject(new Error('The native helper could not generate a workspace identity.'))
      try {
        const identity = JSON.parse(stdout) as LanIdentity
        if (!['caCertPEM', 'caKeyPEM', 'certPEM', 'keyPEM'].every(key => typeof identity[key as keyof LanIdentity] === 'string')) throw new Error()
        resolve(identity)
      } catch { reject(new Error('The native helper returned an invalid workspace identity.')) }
    })
  }),
  activate: async (profile, initialJoin, bootstrapNewWorkspace) => {
    await initialStartup
    await stopHelper()
    repository.reset()
    notifiedConflicts.clear()
    activeProfile = profile
    await startHelper(profile, initialJoin, bootstrapNewWorkspace)
    if (runtime.status !== 'ready') throw new Error(runtime.message)
    if (profile.repositoryRoot) await repository.select(profile.repositoryRoot).catch(() => undefined)
    if (initialJoin && lanClient) {
      const generation = helperGeneration
      const target = lanClient
      const deadline = Date.now() + 12000
      try {
        while (Date.now() < deadline && generation === helperGeneration) {
          const status = await target.status()
          if (status.workspaceId !== profile.config.workspaceId || status.deviceId !== profile.deviceId) throw new Error('Enrollment identity changed before it was verified.')
          if (status.joinAttempt === 'failed') throw new Error(status.joinError?.message ?? 'Enrollment was not verified. Review the inviting Mac and retry this saved workspace.')
          if (status.joinAttempt === 'verified') {
            const passwordVerifier = await lanPasswordVerifier(initialJoin.password)
            if (generation !== helperGeneration) throw new Error('The workspace changed before enrollment could be saved.')
            const latest = activeProfile?.id === profile.id ? activeProfile : profile
            const { enrollment, ...verifiedProfile } = latest
            const acceptedProfile = { ...verifiedProfile, config: { ...latest.config, passwordVerifier } }
            activeProfile = acceptedProfile
            await profiles.save(acceptedProfile)
            return
          }
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        throw new Error('The join outcome is not confirmed yet. Refresh status, or retry the same saved workspace after reviewing its invitation.')
      } catch (error) {
        if (generation === helperGeneration) {
          await stopHelper()
          unavailable(error instanceof Error ? error.message : 'Enrollment must be retried before reopening this workspace.')
        }
        throw error
      } finally {
        initialJoin.password = ''
      }
    }
  },
  status: () => lanClient ? lanClient.status() : Promise.resolve(null),
})

const verifySender = (event: Electron.IpcMainInvokeEvent) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('This window cannot access the workspace.')
  }
}

const observeConflicts = (snapshot: Snapshot) => {
  Object.values(snapshot.tasks).filter((task) => task.status === 'blocked' && task.conflicts.length > 0).forEach((task) => {
    const key = `${task.id}:${task.revision}`
    if (notifiedConflicts.has(key)) return
    notifiedConflicts.add(key)
    if (Notification.isSupported()) {
      new Notification({
        title: 'Work paused: overlapping scope',
        body: `${task.description.slice(0, 160)}. Review the conflict in Agent PR Monitor.`,
      }).show()
    }
  })
}

ipcMain.handle('workspace:runtime', (event) => {
  verifySender(event)
  return { ...runtime }
})
ipcMain.handle('workspace:snapshot', async (event) => {
  verifySender(event)
  if (!client) throw new Error(runtime.message)
  const generation = helperGeneration
  const snapshot = await client.snapshot()
  if (generation !== helperGeneration) throw new Error('The workspace changed while reading its state. Refresh the current workspace.')
  observeConflicts(snapshot)
  return snapshot
})
ipcMain.handle('workspace:command', async (event, command: unknown, expectedWorkspaceKey: unknown) => {
  verifySender(event)
  if (expectedWorkspaceKey !== runtime.workspaceKey) throw new Error('The workspace changed. Review its shared plan before submitting changes.')
  if (!isCommand(command)) throw new Error('The workspace command is invalid.')
  if (!client) throw new Error(runtime.message)
  const targetClient = client
  const generation = helperGeneration
  if ('task' in command) {
    const root = repository.snapshot().local?.root
    if (!root) throw new Error('Choose this Mac’s Git clone in Worktree before proposing a task.')
    const assertCurrent = () => {
      if (generation !== helperGeneration || client !== targetClient || expectedWorkspaceKey !== runtime.workspaceKey
        || repository.snapshot().local?.root !== root) {
        throw new Error('The workspace or clone changed before task registration. Review the current shared plan first.')
      }
    }
    await ensureWorkspaceRepository({ api: targetClient, root, assertCurrent })
    const assetDirectory = app.isPackaged
      ? path.join(process.resourcesPath, 'parser-assets') : path.join(directory, '..', 'parser-assets')
    const qualified = await qualifyTaskScopes(root, command.task.scopes, { assetDirectory })
    assertCurrent()
    const result = await targetClient.command({ ...command, task: { ...command.task, scopes: qualified.scopes } })
    assertCurrent()
    return result
  }
  return client.command(command)
})

ipcMain.handle('repository:snapshot', (event) => {
  verifySender(event)
  return repository.snapshot()
})
ipcMain.handle('repository:choose', async (event) => {
  verifySender(event)
  if (!window) throw new Error('Open the workspace window first.')
  const generation = helperGeneration
  const selected = await dialog.showOpenDialog(window, {
    title: 'Select this Mac’s Git clone', buttonLabel: 'Observe repository', properties: ['openDirectory'],
    message: 'Agent PR Monitor reads this clone. Your agents continue working in their own tools.',
  })
  if (generation !== helperGeneration) throw new Error('The workspace changed while selecting its clone.')
  if (selected.canceled || !selected.filePaths[0]) return repository.snapshot()
  const view = await repository.select(selected.filePaths[0])
  if (generation !== helperGeneration) throw new Error('The workspace changed while selecting its clone.')
  if (activeProfile && view.local) {
    activeProfile = { ...activeProfile, repositoryRoot: view.local.root }
    await profiles.save(activeProfile)
  }
  return view
})
ipcMain.handle('repository:refresh-local', async (event) => {
  verifySender(event)
  return repository.refreshLocal()
})
ipcMain.handle('repository:refresh-github', async (event) => {
  verifySender(event)
  return repository.refreshGitHub()
})
ipcMain.handle('repository:session-token', (event, token: unknown) => {
  verifySender(event)
  return repository.setSessionToken(token)
})
ipcMain.handle('repository:observe-task-pr', async (event, input: unknown, expectedWorkspaceKey: unknown) => {
  verifySender(event)
  const request = observedTaskSchema.safeParse(input)
  if (!request.success) throw new Error('Select a current task and revision to check its linked PR.')
  if (!client) throw new Error(runtime.message)
  const targetClient = client
  const generation = helperGeneration
  const root = repository.snapshot().local?.root
  const assertCurrent = () => {
    if (expectedWorkspaceKey !== runtime.workspaceKey || generation !== helperGeneration || client !== targetClient
      || !root || repository.snapshot().local?.root !== root) {
      throw new Error('The workspace or selected clone changed. Review the current task before checking its PR.')
    }
  }
  return observeTaskPullRequest({
    api: targetClient, ...request.data, assertCurrent,
    observe: (identity, number) => repository.observeLinkedPullRequest(identity, number),
  })
})

ipcMain.handle('pool:snapshot', event => { verifySender(event); return pool.snapshot() })
ipcMain.handle('pool:inspect-invitation', (event, input: unknown) => {
  verifySender(event)
  if (typeof input !== 'string') throw new Error('Paste a workspace invitation.')
  return parseLanInvitation(input)
})
ipcMain.handle('pool:create', (event, input: unknown) => { verifySender(event); return pool.create(input) })
ipcMain.handle('pool:join', (event, input: unknown) => { verifySender(event); return pool.join(input) })
ipcMain.handle('pool:open', (event, input: unknown) => { verifySender(event); return pool.open(input) })
ipcMain.handle('pool:retry-join', (event, input: unknown) => { verifySender(event); return pool.retryJoin(input) })

const agentSetup = () => createAgentSetupService({
  userDataDirectory: app.getPath('userData'),
  cliPath: app.isPackaged ? path.join(process.resourcesPath, 'integrations', 'cli.js')
    : path.join(app.getAppPath(), 'dist', 'integrations', 'cli.js'),
  electronPath: process.execPath,
  getRepositoryRoot: () => repository.snapshot().local?.root,
  getEndpointFile: () => runtime.status === 'ready' ? runtime.endpointFile : undefined,
  getOfflineAuthority: () => {
    if (!activeProfile || runtime.status !== 'ready' || runtime.workspaceKey !== activeProfile.id) return undefined
    const identity = githubIdentity(repository.snapshot().local?.origin)
    return {
      workspaceId: activeProfile.config.workspaceId, deviceId: activeProfile.deviceId,
      caCertPEM: activeProfile.config.identity.caCertPEM,
      ...(identity ? { repository: identity } : {}),
    }
  },
})
ipcMain.handle('agents:inspect', (event) => {
  verifySender(event)
  return agentSetup().inspect()
})
ipcMain.handle('agents:prepare', (event, request: unknown) => {
  verifySender(event)
  return agentSetup().prepare(request)
})

const createWindow = () => {
  window = new BrowserWindow({
    title: 'Agent PR Monitor', width: 1420, height: 960, minWidth: 1040, minHeight: 720,
    backgroundColor: '#171a18', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
  if (devUrl) {
    const url = new URL(devUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== '5173' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('The development renderer must use loopback HTTP on port 5173.')
    }
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(path.join(directory, '..', 'renderer', 'index.html'))
  }
  window.on('closed', () => { window = null })
}

if (ownsApplicationLock) {
  app.whenReady().then(() => {
    createWindow()
    initialStartup = startHelper()
    app.on('activate', () => { if (!window) createWindow() })
  })
  app.on('second-instance', () => {
    if (!window) createWindow()
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
} else {
  app.quit()
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  stopDiscovery?.()
  if (lanMonitor) clearInterval(lanMonitor)
  void (async () => {
    await removeEndpoint().catch(() => undefined)
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const child = helper
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        child.kill('SIGTERM')
      })
    }
  })().finally(() => app.quit())
})
