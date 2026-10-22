import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkspacePool } from './workspace-pool.js'
import { lanInvitationFixture } from './lan-test-support.js'
import type { LanConfig, LanIdentity, LanStatus, WorkspaceProfile } from '../shared/lan.js'

let invitationFixture: Awaited<ReturnType<typeof lanInvitationFixture>>
beforeAll(async () => { invitationFixture = await lanInvitationFixture() })
afterAll(async () => { if (invitationFixture) await rm(invitationFixture.directory, { recursive: true, force: true }) })
const identity: LanIdentity = { caCertPEM: 'public-ca', caKeyPEM: 'private-ca', certPEM: 'public-leaf', keyPEM: 'private-leaf' }
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}
const fixture = () => {
  const saved = new Map<string, WorkspaceProfile>()
  const profiles = {
    save: vi.fn(async (profile: WorkspaceProfile) => { saved.set(profile.id, structuredClone(profile)) }),
    load: vi.fn(async (id: string) => { const profile = saved.get(id); if (!profile) throw new Error('Missing fixture'); return structuredClone(profile) }),
    list: vi.fn(async () => [...saved.values()].map(profile => ({
      id: profile.id, name: profile.name, workspaceId: profile.config.workspaceId, deviceId: profile.deviceId,
      ...(profile.enrollment ? { enrollment: profile.enrollment } : {}),
    }))),
  }
  const activate = vi.fn(async (_profile: WorkspaceProfile, _join?: LanConfig['join'], _bootstrap?: boolean) => undefined)
  const status = vi.fn(async (): Promise<LanStatus | null> => null)
  const generateIdentity = vi.fn(async () => identity)
  const pool = createWorkspacePool({ profiles, activate, status, generateIdentity, interfaces: () => [{ name: 'test', address: '127.0.0.1' }] })
  return { pool, saved, profiles, activate, status, generateIdentity }
}
const statusFor = (profile: WorkspaceProfile, stage: LanStatus['stage'] = 'active'): LanStatus => ({
  workspaceId: profile.config.workspaceId, deviceId: profile.deviceId, stage, hasAuthority: true,
  leaderId: profile.deviceId, members: [], public: invitationFixture.invitation, joinAttempt: 'none',
})
const createInput = { name: 'Pool fixture', password: 'private-workspace-password', listenHost: '127.0.0.1' }

describe('workspace pool lifecycle and pinned enrollment', () => {
  it('bootstraps only explicit creation and never an existing creator profile reopened later', async () => {
    const { pool, saved, activate } = fixture()
    await pool.create(createInput)
    const profile = [...saved.values()][0]
    expect(activate.mock.calls[0]).toEqual([profile, undefined, true])
    expect(JSON.stringify(profile)).not.toContain(createInput.password)
    await pool.open({ id: profile.id, listenHost: '127.0.0.1' })
    expect(activate.mock.calls[1]).toEqual([profile, undefined, false])
  })

  it('retries the exact identity/request ID while keeping retry passwords and verifier changes out of persistence', async () => {
    const { pool, saved, profiles, activate, generateIdentity, status } = fixture()
    activate.mockRejectedValueOnce(new Error('Enrollment reply was lost'))
    await expect(pool.join({ ...createInput, invitation: JSON.stringify(invitationFixture.invitation), fingerprintConfirmed: true })).rejects.toThrow('reply was lost')
    const profile = [...saved.values()][0]
    const firstJoin = activate.mock.calls[0][1]
    await expect(pool.open({ id: profile.id, listenHost: '127.0.0.1' })).rejects.toThrow('unfinished enrollment')
    await pool.retryJoin({ id: profile.id, password: 'different-retry-password', listenHost: '127.0.0.1', fingerprintConfirmed: true })
    expect(generateIdentity).toHaveBeenCalledTimes(1)
    expect(profiles.save).toHaveBeenCalledTimes(1)
    const [retried, join, bootstrap] = activate.mock.calls[1]
    expect(retried.deviceId).toBe(profile.deviceId)
    expect(retried.config.identity).toEqual(profile.config.identity)
    expect(retried.config.passwordVerifier).toEqual(profile.config.passwordVerifier)
    expect(join).toMatchObject({ requestId: firstJoin!.requestId, password: 'different-retry-password', trustedCaCertPEM: invitationFixture.invitation.caCertPEM })
    expect(bootstrap).toBe(false)
    expect(JSON.stringify(saved.get(profile.id))).not.toContain('different-retry-password')
    status.mockResolvedValue(statusFor(profile))
    await expect(pool.retryJoin({ id: profile.id, password: 'another-password', listenHost: '127.0.0.1', fingerprintConfirmed: true })).rejects.toThrow('already active')
  })

  it('cannot activate or enroll without private persistence, a reviewed pin, and an available local interface', async () => {
    const { pool, activate, profiles } = fixture()
    profiles.save.mockRejectedValueOnce(new Error('Keychain unavailable'))
    await expect(pool.create(createInput)).rejects.toThrow('Keychain')
    expect(activate).not.toHaveBeenCalled()
    await expect(pool.join({ ...createInput, invitation: JSON.stringify(invitationFixture.invitation), fingerprintConfirmed: false })).rejects.toThrow()
    await expect(pool.create({ ...createInput, listenHost: '192.168.9.9' })).rejects.toThrow('available LAN interface')
    expect(activate).not.toHaveBeenCalled()
  })

  it('does not attach another workspace’s authority to the selected profile or accept an older status response after switching', async () => {
    const { pool, saved, status } = fixture()
    await pool.create(createInput)
    const first = [...saved.values()][0]
    const pending = deferred<LanStatus | null>()
    const started = deferred<void>()
    status.mockImplementationOnce(async () => { started.resolve(); return pending.promise })
    const oldSnapshot = pool.snapshot()
    await started.promise
    await pool.create({ ...createInput, name: 'Second workspace' })
    const second = [...saved.values()][1]
    pending.resolve(statusFor(first))
    expect(await oldSnapshot).toMatchObject({ current: { id: second.id }, lan: null })
    status.mockResolvedValue({ ...statusFor(first), workspaceId: randomUUID() })
    expect(await pool.snapshot()).toMatchObject({ current: { id: second.id }, lan: null, error: expect.stringContaining('different workspace') })
  })
})
