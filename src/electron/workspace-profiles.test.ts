import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorkspaceProfile } from '../shared/lan.js'
import { createWorkspaceProfileStore, lanPasswordVerifier } from './workspace-profiles.js'

const directories: string[] = []
const key = randomBytes(32)
const crypto = {
  available: async () => true,
  encrypt: async (value: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decrypt: async (value: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  },
}
const fixture = async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-profile-')))
  directories.push(directory)
  const profile: WorkspaceProfile = {
    id: randomUUID(), name: 'Team project', deviceId: randomUUID(), creator: true,
    config: {
      version: 1, workspaceId: randomUUID(), listenHost: '127.0.0.1', controlPort: 0, raftPort: 0, peerHints: [],
      identity: { caCertPEM: 'public-ca', caKeyPEM: 'secret-ca-key', certPEM: 'public-leaf', keyPEM: 'secret-leaf-key' },
      passwordVerifier: await lanPasswordVerifier('test-password'),
    },
  }
  return { directory, profile, store: createWorkspaceProfileStore(directory, crypto) }
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

it('round trips an encrypted private profile and lists only public metadata', async () => {
  const { directory, profile, store } = await fixture()
  await store.save(profile)
  const file = path.join(directory, `${profile.id}.json`)
  expect((await lstat(directory)).mode & 0o777).toBe(0o700)
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  expect(await readFile(file, 'utf8')).not.toContain('secret-ca-key')
  expect(await readFile(file, 'utf8')).not.toContain(profile.config.passwordVerifier.key)
  expect(await store.load(profile.id)).toEqual(profile)
  expect(await store.list()).toEqual([{ id: profile.id, name: profile.name, workspaceId: profile.config.workspaceId, deviceId: profile.deviceId }])
})

it('fails closed without secret storage and rejects transient passwords in saved profiles', async () => {
  const { directory, profile } = await fixture()
  const unavailable = createWorkspaceProfileStore(directory, { ...crypto, available: async () => false })
  await expect(unavailable.save(profile)).rejects.toThrow('Keychain protection is unavailable')
  const store = createWorkspaceProfileStore(directory, crypto)
  await expect(store.save({ ...profile, config: { ...profile.config, join: { password: 'must-not-persist' } } } as WorkspaceProfile)).rejects.toThrow()
})

it('rejects unsafe paths, symlink profiles, loose permissions, and mismatched metadata', async () => {
  const { directory, profile, store } = await fixture()
  await store.save(profile)
  await expect(store.load('../outside')).rejects.toThrow()
  const file = path.join(directory, `${profile.id}.json`)
  await chmod(file, 0o644)
  await expect(store.load(profile.id)).rejects.toThrow('permissions')
  await chmod(file, 0o600)
  const envelope = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...envelope, name: 'different metadata' }))
  await expect(store.load(profile.id)).rejects.toThrow('inconsistent')
  const alias = randomUUID()
  await symlink(file, path.join(directory, `${alias}.json`))
  await expect(store.load(alias)).rejects.toThrow('permissions')
})

it('uses the native LAN scrypt parameters and base64url salt/key sizes', async () => {
  const verifier = await lanPasswordVerifier('eight-or-more')
  expect(Buffer.from(verifier.salt, 'base64url')).toHaveLength(16)
  expect(Buffer.from(verifier.key, 'base64url')).toEqual(scryptSync('eight-or-more', Buffer.from(verifier.salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 }))
  await expect(lanPasswordVerifier('short')).rejects.toThrow()
  await expect(lanPasswordVerifier('a'.repeat(1025))).rejects.toThrow()
})

it('serializes asynchronous encryption per profile in invocation order and snapshots queued inputs', async () => {
  const { directory, profile } = await fixture()
  let release: () => void = () => undefined
  let began: () => void = () => undefined
  const started = new Promise<void>(resolve => { began = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const names: string[] = []
  const store = createWorkspaceProfileStore(directory, {
    ...crypto,
    encrypt: async value => {
      const input = JSON.parse(value) as WorkspaceProfile
      names.push(input.name)
      if (input.name === 'Older save') { began(); await gate }
      return crypto.encrypt(value)
    },
  })
  const older = store.save({ ...profile, name: 'Older save' })
  await started
  const latest = { ...profile, name: 'Verified save', repositoryRoot: '/new/clone' }
  const newer = store.save(latest)
  latest.name = 'Caller mutation after queuing'
  expect(names).toEqual(['Older save'])
  release()
  await Promise.all([older, newer])
  expect(names).toEqual(['Older save', 'Verified save'])
  expect(await store.load(profile.id)).toMatchObject({ name: 'Verified save', repositoryRoot: '/new/clone' })
})

it('rejects modified plaintext enrollment metadata instead of reviewing a different trust pin', async () => {
  const { directory, profile, store } = await fixture()
  const enrollment = {
    requestId: randomUUID(),
    invitation: {
      workspaceId: profile.config.workspaceId, deviceId: 'inviter', controlUrl: 'https://127.0.0.1:12345',
      raftEndpoint: '127.0.0.1:12346', caCertPEM: 'public-ca', fingerprint: 'a'.repeat(64),
    },
  }
  await store.save({ ...profile, enrollment })
  const file = path.join(directory, `${profile.id}.json`)
  const envelope = JSON.parse(await readFile(file, 'utf8'))
  envelope.enrollment.invitation.fingerprint = 'b'.repeat(64)
  await writeFile(file, JSON.stringify(envelope))
  await expect(store.load(profile.id)).rejects.toThrow('inconsistent')
})
