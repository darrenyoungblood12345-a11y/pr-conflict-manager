import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SignedTaskReceipt, Snapshot, Task } from '../shared/contracts.js'
import { agentContextSchema } from './schemas.js'
import type { AgentContext } from './schemas.js'
import { receiptInvalidatedBy, verifyOfflineReceipt } from './offline-receipt.js'
import { isActiveTask } from './task-identity.js'

export const readPrivateJson = async (file: string): Promise<unknown> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error('Configuration must be a bounded private regular file owned by this user')
    }
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Configuration changed while reading')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
  } finally { await handle.close() }
}

export const loadContext = async (file: string): Promise<AgentContext> => agentContextSchema.parse(await readPrivateJson(file))

const sameSession = (left: AgentContext, right: AgentContext) => left.ownerId === right.ownerId
  && left.sessionId === right.sessionId && left.agent === right.agent && left.repositoryRoot === right.repositoryRoot
  && JSON.stringify(left.offlineAuthority) === JSON.stringify(right.offlineAuthority)

/** A crashed writer leaves this private lock fail-closed rather than guessing it is stale. */
const updateContext = async (file: string, previous: AgentContext, change: (latest: AgentContext) => AgentContext) => {
  const lock = `${file}.lock`
  const acquire = async (remaining: number): Promise<void> => {
    try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || remaining === 0) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
      return acquire(remaining - 1)
    }
  }
  await acquire(40)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const latest = await loadContext(file)
    if (!sameSession(latest, previous)) throw new Error('Session setup changed while coordinating work')
    const updated = agentContextSchema.parse(change(latest))
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await handle.writeFile(JSON.stringify(updated, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
    const parent = await open(path.dirname(file), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
    return updated
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { recursive: true })
  }
}

export const acceptContext = (file: string, previous: AgentContext, task: Task, receipt?: SignedTaskReceipt) => updateContext(file, previous, latest => {
  if ((latest.offlineRevokedThrough?.[task.id] ?? -1) >= task.revision
    || (latest.taskId === task.id && (latest.revision ?? -1) > task.revision)) {
    throw new Error('A later local stop or task revision superseded this acceptance')
  }
  const updated = { ...latest, taskId: task.id, revision: task.revision, acceptedOfflineReceipt: undefined }
  if (receipt) {
    verifyOfflineReceipt(updated, receipt, task)
    return { ...updated, acceptedOfflineReceipt: receipt }
  }
  return updated
})

export const observeContext = (file: string, previous: AgentContext, snapshot: Snapshot) => updateContext(file, previous, latest => {
  const floors = { ...latest.offlineRevokedThrough }
  Object.values(snapshot.tasks).filter(task => task.ownerId === latest.ownerId
    && task.sessionId === latest.sessionId && task.agent === latest.agent).forEach(task => {
    if (!isActiveTask(task)) floors[task.id] = Math.max(floors[task.id] ?? -1, task.revision)
    else if (task.id === latest.taskId && latest.revision !== undefined && task.revision > latest.revision) {
      floors[task.id] = Math.max(floors[task.id] ?? -1, task.revision - 1)
    }
  })
  if (latest.acceptedOfflineReceipt) {
    try {
      const receipt = verifyOfflineReceipt(latest)
      if (receiptInvalidatedBy(receipt, snapshot)) {
        floors[receipt.task.id] = Math.max(floors[receipt.task.id] ?? -1, receipt.task.revision)
        return { ...latest, offlineRevokedThrough: floors, acceptedOfflineReceipt: undefined }
      }
    } catch {
      if (latest.taskId && latest.revision !== undefined) floors[latest.taskId] = Math.max(floors[latest.taskId] ?? -1, latest.revision)
      return { ...latest, offlineRevokedThrough: floors, acceptedOfflineReceipt: undefined }
    }
  }
  return { ...latest, offlineRevokedThrough: floors }
})
