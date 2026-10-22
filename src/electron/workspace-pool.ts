import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { LanConfig, LanIdentity, LanStatus, WorkspacePoolView, WorkspaceProfile } from '../shared/lan.js'
import { lanInterfaces, parseLanInvitation } from './lan-invitation.js'
import { lanPasswordVerifier } from './workspace-profiles.js'
import type { createWorkspaceProfileStore } from './workspace-profiles.js'

const baseInput = z.object({ name: z.string().trim().min(1).max(120), password: z.string().min(1).max(1024), listenHost: z.string().max(128) }).strict()
const joinInput = baseInput.extend({ invitation: z.string().min(1).max(32768), fingerprintConfirmed: z.literal(true) }).strict()
const openInput = z.object({ id: z.string().uuid(), listenHost: z.string().max(128) }).strict()
const retryInput = openInput.extend({ password: z.string().min(1).max(1024), fingerprintConfirmed: z.literal(true) }).strict()

interface Dependencies {
  profiles: ReturnType<typeof createWorkspaceProfileStore>
  generateIdentity(workspaceId: string, deviceId: string): Promise<LanIdentity>
  activate(profile: WorkspaceProfile, initialJoin?: LanConfig['join'], bootstrapNewWorkspace?: boolean): Promise<void>
  status(): Promise<LanStatus | null>
  interfaces?: typeof lanInterfaces
}

export const createWorkspacePool = (dependencies: Dependencies) => {
  let current: WorkspacePoolView['current'] = { id: 'local', name: 'Local development workspace', mode: 'local' }
  let busy = false
  let generation = 0
  let selectedWorkspaceId: string | undefined
  let selectedDeviceId: string | undefined
  const interfaces = dependencies.interfaces ?? lanInterfaces
  const host = (address: string) => {
    if (!interfaces().some(entry => entry.address === address)) throw new Error('Choose an available LAN interface on this Mac.')
    return address
  }
  const snapshot = async (): Promise<WorkspacePoolView> => {
    const profiles = await dependencies.profiles.list()
    const revision = generation
    const selected = { ...current }
    const workspaceId = selectedWorkspaceId
    const deviceId = selectedDeviceId
    try {
      const lan = await dependencies.status()
      if (revision !== generation) return { profiles, interfaces: interfaces(), current: { ...current }, lan: null, error: 'The workspace changed while reading its connection. Waiting for the selected workspace.' }
      if (selected.mode === 'local') return { profiles, interfaces: interfaces(), current: selected, lan: null }
      if (lan && (lan.workspaceId !== workspaceId || lan.deviceId !== deviceId)) return { profiles, interfaces: interfaces(), current: selected, lan: null, error: 'Waiting for the selected workspace connection. A different workspace cannot authorize its work.' }
      return { profiles, interfaces: interfaces(), current: selected, lan }
    } catch {
      return { profiles, interfaces: interfaces(), current, lan: null, error: 'Workspace connection status is unavailable. New work must wait for verified authority.' }
    }
  }
  const operation = async (work: () => Promise<void>) => {
    if (busy) throw new Error('Another workspace operation is still running.')
    busy = true
    try { await work(); return await snapshot() } finally { busy = false }
  }
  const activate = async (profile: WorkspaceProfile, initialJoin?: LanConfig['join'], bootstrapNewWorkspace = false) => {
    generation += 1
    current = { id: profile.id, name: profile.name, mode: 'lan' }
    selectedWorkspaceId = profile.config.workspaceId
    selectedDeviceId = profile.deviceId
    await dependencies.activate(profile, initialJoin, bootstrapNewWorkspace)
  }
  const create = (raw: unknown) => operation(async () => {
    const input = baseInput.parse(raw)
    const listenHost = host(input.listenHost)
    const workspaceId = randomUUID()
    const deviceId = randomUUID()
    const [identity, passwordVerifier] = await Promise.all([
      dependencies.generateIdentity(workspaceId, deviceId), lanPasswordVerifier(input.password),
    ])
    const profile: WorkspaceProfile = {
      id: randomUUID(), name: input.name, deviceId, creator: true,
      config: { version: 1, workspaceId, identity, passwordVerifier, listenHost, controlPort: 0, raftPort: 0, peerHints: [] },
    }
    await dependencies.profiles.save(profile)
    await activate(profile, undefined, true)
  })
  const join = (raw: unknown) => operation(async () => {
    const input = joinInput.parse(raw)
    const invitation = parseLanInvitation(input.invitation)
    const listenHost = host(input.listenHost)
    const deviceId = randomUUID()
    const [identity, passwordVerifier] = await Promise.all([
      dependencies.generateIdentity(invitation.workspaceId, deviceId), lanPasswordVerifier(input.password),
    ])
    const profile: WorkspaceProfile = {
      id: randomUUID(), name: input.name, deviceId, creator: false,
      enrollment: { requestId: randomUUID(), invitation },
      config: {
        version: 1, workspaceId: invitation.workspaceId, identity, passwordVerifier, listenHost, controlPort: 0, raftPort: 0,
        peerHints: [{ deviceId: invitation.deviceId, controlUrl: invitation.controlUrl, raftEndpoint: invitation.raftEndpoint }],
      },
    }
    // The password is never included in a persisted profile. It exists only for
    // this pinned enrollment attempt and the private helper startup pipe.
    await dependencies.profiles.save(profile)
    await activate(profile, {
      controlUrl: invitation.controlUrl, deviceId: invitation.deviceId, trustedCaCertPEM: invitation.caCertPEM,
      password: input.password, requestId: profile.enrollment!.requestId,
    })
  })
  const open = (raw: unknown) => operation(async () => {
    const input = openInput.parse(raw)
    const listenHost = host(input.listenHost)
    const loaded = await dependencies.profiles.load(input.id)
    if (loaded.enrollment) throw new Error('This workspace has unfinished enrollment. Open its saved invitation and retry enrollment explicitly.')
    const profile = { ...loaded, config: { ...loaded.config, listenHost } }
    await dependencies.profiles.save(profile)
    await activate(profile)
  })
  const retryJoin = (raw: unknown) => operation(async () => {
    const input = retryInput.parse(raw)
    const listenHost = host(input.listenHost)
    const loaded = await dependencies.profiles.load(input.id)
    if (!loaded.enrollment) throw new Error('This workspace has no interrupted enrollment to retry.')
    if (current.id === loaded.id) {
      const status = await dependencies.status().catch(() => null)
      if (status?.workspaceId === loaded.config.workspaceId && status.deviceId === loaded.deviceId && status.stage === 'active') {
        throw new Error('This Mac is already active in that workspace. Re-enrollment is not needed.')
      }
    }
    const invitation = parseLanInvitation(JSON.stringify(loaded.enrollment.invitation))
    const profile = { ...loaded, config: { ...loaded.config, listenHost } }
    // A retry can encounter an already-admitted member after a lost response.
    // Retain the saved verifier until native password verification explicitly
    // confirms this attempt; stage=active alone is not that proof. Activation
    // receives the password transiently and persists a verifier only after a grant.
    await activate(profile, {
      controlUrl: invitation.controlUrl, deviceId: invitation.deviceId, trustedCaCertPEM: invitation.caCertPEM,
      password: input.password, requestId: loaded.enrollment.requestId,
    })
  })
  return { snapshot, create, join, open, retryJoin }
}
