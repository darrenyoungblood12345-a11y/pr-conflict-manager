import { verify, X509Certificate } from 'node:crypto'
import { z } from 'zod'
import type { SignedTaskReceipt, Snapshot, Task } from '../shared/contracts.js'
import type { AgentContext } from './schemas.js'
import { repositoryIdentitySchema, signedTaskReceiptSchema, taskSchema } from './schemas.js'
import { isActiveTask, sameReservation } from './task-identity.js'

const MAX_PAYLOAD_BYTES = 266240
const receiptPayloadSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  issuerDeviceId: z.string(),
  task: taskSchema,
  repository: repositoryIdentitySchema,
  commitIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>

const decode = (value: string, maximum: number) => {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength > maximum || bytes.toString('base64url') !== value) throw new Error('Invalid receipt encoding')
  return bytes
}

const certificate = (pem: string) => {
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) throw new Error('Expected one certificate')
  return new X509Certificate(pem)
}

const validAt = (cert: X509Certificate, now: number) => Number.isFinite(Date.parse(cert.validFrom))
  && Number.isFinite(Date.parse(cert.validTo)) && Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo)

/** Verify exact signed bytes against the app-provisioned device CA, never a receipt-supplied trust root. */
export const verifyOfflineReceipt = (
  context: AgentContext,
  value: SignedTaskReceipt = context.acceptedOfflineReceipt!,
  expectedTask?: Task,
  now = Date.now(),
): ReceiptPayload => {
  const receipt = signedTaskReceiptSchema.parse(value)
  const authority = context.offlineAuthority
  if (!authority || !context.taskId || context.revision === undefined) throw new Error('No bound offline authority')
  if ((context.offlineRevokedThrough?.[context.taskId] ?? -1) >= context.revision) throw new Error('Receipt was locally revoked')
  const logicalName = `${authority.deviceId}.${authority.workspaceId}.agent-pr-monitor.invalid`
  const ca = certificate(authority.caCertPEM)
  const leaf = certificate(receipt.certPEM)
  if (!ca.ca || leaf.ca || !validAt(ca, now) || !validAt(leaf, now)
    || ca.subject !== `CN=${logicalName}` || leaf.subject !== `CN=${logicalName}`
    || leaf.subjectAltName !== `DNS:${logicalName}`
    || leaf.checkHost(logicalName, { wildcards: false, subject: 'never' }) !== logicalName
    || ca.publicKey.asymmetricKeyType !== 'ed25519' || leaf.publicKey.asymmetricKeyType !== 'ed25519'
    || !ca.verify(ca.publicKey) || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)
    || !['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'].every(usage => leaf.keyUsage?.includes(usage))) {
    throw new Error('Receipt certificate is not the configured device identity')
  }
  const bytes = decode(receipt.payload, MAX_PAYLOAD_BYTES)
  const signature = decode(receipt.signature, 64)
  if (signature.byteLength !== 64 || !verify(null, bytes, leaf.publicKey, signature)) throw new Error('Invalid receipt signature')
  const payload = receiptPayloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  const task = payload.task
  if (payload.workspaceId !== authority.workspaceId || payload.issuerDeviceId !== authority.deviceId
    || (authority.repository && JSON.stringify(authority.repository) !== JSON.stringify(payload.repository))
    || task.id !== context.taskId || task.revision !== context.revision
    || task.ownerId !== context.ownerId || task.sessionId !== context.sessionId || task.agent !== context.agent
    || !isActiveTask(task) || (expectedTask && !sameReservation(task, expectedTask))) {
    throw new Error('Receipt does not match the accepted task reservation')
  }
  return payload
}

/** An observed stop/scope change revokes local continuation even if quorum is now unavailable. */
export const receiptInvalidatedBy = (receipt: ReceiptPayload, snapshot: Snapshot): boolean => {
  const observed = snapshot.tasks[receipt.task.id]
  if (!observed) return snapshot.commitIndex >= receipt.commitIndex
  if (observed.revision < receipt.task.revision) return false
  return !isActiveTask(observed) || !sameReservation(receipt.task, observed)
}
