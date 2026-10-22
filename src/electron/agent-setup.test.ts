import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentSetupService, describeAgentInstallation } from './agent-setup.js'

const execute = promisify(execFile)
const directories: string[] = []
const secret = 'private-endpoint-token-never-rendered'

const fixture = async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'agent-pr-setup-'))
  directories.push(temporary)
  const directory = await realpath(temporary)
  const root = path.join(directory, 'clone')
  const userDataDirectory = path.join(directory, 'application')
  const cliPath = path.join(directory, 'integrations', 'cli.js')
  const electronPath = path.join(directory, "electron's $(touch injected)")
  const endpointFile = path.join(directory, 'private-endpoint.json')
  await mkdir(root)
  await mkdir(path.dirname(cliPath))
  await mkdir(path.join(root, '.codex'))
  await writeFile(path.join(root, '.codex', 'config.toml'), 'existing = "preserve me"\n')
  await writeFile(cliPath, 'export {}\n')
  await writeFile(electronPath, '#!/bin/sh\nprintf \'%s\\n\' "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o700 })
  await writeFile(endpointFile, JSON.stringify({ url: 'http://127.0.0.1:12345', token: secret }), { mode: 0o600 })
  let selectedRoot: string | undefined = root
  let selectedEndpoint: string | undefined = endpointFile
  const options = {
    userDataDirectory, cliPath, electronPath, getRepositoryRoot: () => selectedRoot,
    getEndpointFile: () => selectedEndpoint, probeInstallations: async () => [],
  }
  const request = { agent: 'codex', ownerId: 'local-user', sessionId: 'actual-native-session', expectedRepositoryRoot: root, expectedEndpointFile: endpointFile }
  return {
    directory, root, userDataDirectory, cliPath, electronPath, endpointFile, options, request,
    service: createAgentSetupService(options),
    changeSelection: (nextRoot?: string, nextEndpoint?: string) => { selectedRoot = nextRoot; selectedEndpoint = nextEndpoint },
  }
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('private per-session agent setup', () => {
  it('keeps detected clients unqualified and blocks older/prerelease Claude failure behavior without inventing missing versions', () => {
    expect(describeAgentInstallation('claude-code', 'detected', '2.1.285').qualification).toBe('version-blocked')
    expect(describeAgentInstallation('claude-code', 'detected', '2.1.295-alpha.1').qualification).toBe('version-blocked')
    expect(describeAgentInstallation('claude-code', 'detected', '2.1.295').qualification).toBe('unverified')
    expect(describeAgentInstallation('claude-code', 'detected', '3.0.0').qualification).toBe('unverified')
    expect(describeAgentInstallation('codex', 'detected', '0.163.0-alpha.10.2')).toMatchObject({ version: '0.163.0-alpha.10.2', qualification: 'unverified' })
    expect(describeAgentInstallation('cursor', 'not-found', null)).toMatchObject({ version: null, installation: 'not-found', qualification: 'unverified' })
  })
  it('creates unique private contexts outside the clone without overwriting project configuration or returning secrets', async () => {
    const { service, request, root, userDataDirectory, endpointFile } = await fixture()
    const first = await service.prepare(request)
    const second = await service.prepare(request)
    expect(first.contextFile).not.toBe(second.contextFile)
    expect(first.launcherFile).toBe(second.launcherFile)
    expect(JSON.parse(await readFile(first.contextFile, 'utf8'))).toEqual({ agent: 'codex', ownerId: 'local-user', sessionId: 'actual-native-session', repositoryRoot: root })
    expect((await stat(first.contextFile)).mode & 0o777).toBe(0o600)
    expect((await stat(first.launcherFile)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(userDataDirectory, 'sessions'))).mode & 0o777).toBe(0o700)
    expect(await readFile(path.join(root, '.codex', 'config.toml'), 'utf8')).toBe('existing = "preserve me"\n')
    expect(await readdir(root)).toEqual(['.codex'])
    expect(first.files[0].contents).toContain(first.launcherFile)
    expect(first.files[0].contents).toContain(endpointFile)
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(JSON.stringify(await service.inspect())).not.toContain(secret)
  })

  it('generates a Claude Code session ID and the command that starts that exact session', async () => {
    const { service, request, root } = await fixture()
    const prepared = await service.prepare({ ...request, agent: 'claude-code', sessionId: '' })
    expect(prepared.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(prepared.launchCommand).toBe(`cd '${root}' && claude --session-id ${prepared.sessionId}`)
    expect(JSON.parse(await readFile(prepared.contextFile, 'utf8')).sessionId).toBe(prepared.sessionId)
    const second = await service.prepare({ ...request, agent: 'claude-code', sessionId: '' })
    expect(second.sessionId).not.toBe(prepared.sessionId)
  })

  it('resumes a supplied Claude Code session ID and gives no launch command for other agents', async () => {
    const { service, request, root } = await fixture()
    const existing = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect((await service.prepare({ ...request, agent: 'claude-code', sessionId: existing })).launchCommand).toBe(`cd '${root}' && claude --resume ${existing}`)
    expect((await service.prepare({ ...request, agent: 'claude-code', sessionId: 'not-a-uuid' })).launchCommand).toBeUndefined()
    expect((await service.prepare(request)).launchCommand).toBeUndefined()
  })

  it('passes literal executable paths and argument bytes through the launcher without shell injection', async () => {
    const { service, request, directory } = await fixture()
    const prepared = await service.prepare(request)
    const args = ['literal; touch injected', '$(touch injected)', "single'quote", 'space in argument']
    const result = await execute(prepared.launcherFile, args, { cwd: directory })
    expect(result.stdout.trimEnd().split('\n')).toEqual(['1', ...args])
    await expect(stat(path.join(directory, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pins the selected workspace public authority in the private session without exporting it as credentials', async () => {
    const { options, request } = await fixture()
    const offlineAuthority = {
      workspaceId: 'workspace-id', deviceId: 'device-id', caCertPEM: 'public-authority-certificate',
      repository: { owner: 'example', repo: 'project' },
    }
    const service = createAgentSetupService({ ...options, getOfflineAuthority: () => offlineAuthority })
    const prepared = await service.prepare(request)
    const context = JSON.parse(await readFile(prepared.contextFile, 'utf8'))
    expect(context.offlineAuthority).toEqual(offlineAuthority)
    expect(context.acceptedOfflineReceipt).toBeUndefined()
    expect(JSON.stringify(prepared)).not.toContain(offlineAuthority.caCertPEM)
  })

  it('rejects unsafe identities, extra fields, and a stale selected-clone/workspace expectation', async () => {
    const { service, request, userDataDirectory, changeSelection, root, endpointFile } = await fixture()
    await expect(service.prepare({ ...request, ownerId: '../escape' })).rejects.toThrow('identifiers')
    await expect(service.prepare({ ...request, sessionId: '' })).rejects.toThrow('identifiers')
    await expect(service.prepare({ ...request, privateToken: secret })).rejects.toThrow('identifiers')
    changeSelection(`${root}-another`, endpointFile)
    await expect(service.prepare(request)).rejects.toThrow('changed')
    await expect(stat(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses symlinked private storage and repository-contained storage', async () => {
    const { options, request, directory, root } = await fixture()
    const outside = path.join(directory, 'outside')
    await mkdir(outside)
    await mkdir(options.userDataDirectory)
    await symlink(outside, path.join(options.userDataDirectory, 'sessions'))
    await expect(createAgentSetupService(options).prepare(request)).rejects.toThrow('owned local directory')
    expect(await readdir(outside)).toEqual([])
    const nestedStorage = path.join(root, 'private-data')
    await expect(createAgentSetupService({ ...options, userDataDirectory: nestedStorage }).prepare(request)).rejects.toThrow('outside the repository')
    await expect(stat(nestedStorage)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('provides honest unavailable state when the workspace endpoint is absent', async () => {
    const { service, changeSelection, root } = await fixture()
    changeSelection(root, undefined)
    expect(await service.inspect()).toMatchObject({ ready: false, endpointFile: null, reason: expect.stringContaining('coordination workspace') })
  })

  it('refuses to overwrite an altered launcher and leaves existing session files intact', async () => {
    const { service, request, userDataDirectory } = await fixture()
    const first = await service.prepare(request)
    await writeFile(first.launcherFile, '#!/bin/sh\nexit 99\n')
    await expect(service.prepare(request)).rejects.toThrow('launcher could not be prepared safely')
    expect(await readFile(first.launcherFile, 'utf8')).toBe('#!/bin/sh\nexit 99\n')
    expect(await readdir(path.join(userDataDirectory, 'sessions'))).toHaveLength(1)
  })
})
