import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, readdir, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { WorkspaceProfile, WorkspaceProfileInfo } from '../shared/lan.js'

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const pem = z.string().min(1).max(16384)
const hint = z.object({ deviceId: identifier, controlUrl: z.string().max(256), raftEndpoint: z.string().max(256) }).strict()
const invitation = hint.extend({ workspaceId: identifier, caCertPEM: pem, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const enrollment = z.object({ requestId: z.string().uuid(), invitation }).strict()
const profileSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120), deviceId: identifier, creator: z.boolean(),
  repositoryRoot: z.string().min(1).max(4096).optional(),
  enrollment: enrollment.optional(),
  config: z.object({
    version: z.literal(1), workspaceId: identifier,
    identity: z.object({ caCertPEM: pem, caKeyPEM: pem, certPEM: pem, keyPEM: pem }).strict(),
    passwordVerifier: z.object({ salt: z.string().regex(/^[\w-]{22}$/), key: z.string().regex(/^[\w-]{43}$/) }).strict(),
    listenHost: z.string().max(128), controlPort: z.number().int().min(0).max(65535), raftPort: z.number().int().min(0).max(65535),
    peerHints: z.array(hint).max(10),
  }).strict(),
}).strict()
const envelopeSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), name: z.string().min(1).max(120),
  workspaceId: identifier, deviceId: identifier, encrypted: z.string().min(1).max(256 * 1024),
  enrollment: enrollment.optional(),
}).strict()

export interface ProfileEncryption {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

export const lanPasswordVerifier = (password: string): Promise<{ salt: string; key: string }> => {
  const size = Buffer.byteLength(password, 'utf8')
  if (size < 8 || size > 1024 || /[\uD800-\uDFFF]/u.test(password)) return Promise.reject(new Error('Use a workspace password of 8–1024 UTF-8 bytes.'))
  const salt = randomBytes(16)
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
    if (error) reject(new Error('Workspace password protection is unavailable.'))
    else resolve({ salt: salt.toString('base64url'), key: key.toString('base64url') })
  }))
}

/** No plaintext fallback: LAN identity keys/verifiers require the OS secret store. */
export const createWorkspaceProfileStore = (directory: string, encryption: ProfileEncryption) => {
  const root = path.resolve(directory)
  const saves = new Map<string, Promise<void>>()
  const prepare = async () => {
    if (root === homedir() || root === path.parse(root).root) throw new Error('Use an app-specific workspace profile directory.')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(root) !== root) throw new Error('Workspace profiles require a private local app directory.')
    await chmod(root, 0o700)
  }
  const fileFor = (id: string) => path.join(root, `${z.string().uuid().parse(id)}.json`)
  const read = async (id: string) => {
    await prepare()
    const file = fileFor(id)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 256 * 1024) throw new Error('Workspace profile permissions or size are invalid.')
    const envelope = envelopeSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (envelope.id !== id) throw new Error('Workspace profile identity does not match its filename.')
    return envelope
  }
  const list = async (): Promise<WorkspaceProfileInfo[]> => {
    await prepare()
    const files = (await readdir(root)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).slice(0, 100)
    const results = await Promise.allSettled(files.map(file => read(file.slice(0, -5))))
    return results.flatMap(result => result.status === 'fulfilled' ? [{
      id: result.value.id, name: result.value.name, workspaceId: result.value.workspaceId, deviceId: result.value.deviceId,
      ...(result.value.enrollment ? { enrollment: result.value.enrollment } : {}),
    }] : [])
  }
  const persist = async (profile: WorkspaceProfile) => {
    await prepare()
    if (!await encryption.available()) throw new Error('macOS Keychain protection is unavailable. Workspace secrets were not saved.')
    const encrypted = await encryption.encrypt(JSON.stringify(profile))
    const destination = fileFor(profile.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({
          version: 1, id: profile.id, name: profile.name, workspaceId: profile.config.workspaceId,
          deviceId: profile.deviceId, encrypted: encrypted.toString('base64'),
          ...(profile.enrollment ? { enrollment: profile.enrollment } : {}),
        }) + '\n')
        await handle.chmod(0o600)
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, destination)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  const save = async (input: WorkspaceProfile) => {
    // Zod clones the validated input before it waits, so subsequent caller edits
    // cannot alter a queued credential save. Per-ID ordering prevents a slow
    // Keychain operation from overwriting a later verified profile update.
    const profile = profileSchema.parse(input)
    const pending = (saves.get(profile.id) ?? Promise.resolve()).catch(() => undefined).then(() => persist(profile))
    saves.set(profile.id, pending)
    const finished = () => { if (saves.get(profile.id) === pending) saves.delete(profile.id) }
    void pending.then(finished, finished)
    return pending
  }
  const load = async (id: string): Promise<WorkspaceProfile> => {
    const envelope = await read(id)
    if (!await encryption.available()) throw new Error('Unlock macOS Keychain to reopen this workspace.')
    const profile = profileSchema.parse(JSON.parse(await encryption.decrypt(Buffer.from(envelope.encrypted, 'base64'))))
    if (profile.id !== id || profile.deviceId !== envelope.deviceId || profile.config.workspaceId !== envelope.workspaceId || profile.name !== envelope.name
      || JSON.stringify(profile.enrollment) !== JSON.stringify(envelope.enrollment)) throw new Error('Workspace profile identity is inconsistent.')
    return profile
  }
  return { list, save, load }
}
