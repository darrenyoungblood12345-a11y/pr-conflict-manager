import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GateDecision, Snapshot, WorkspaceApi } from '../shared/contracts.js'
import { WorkspaceConnectionError } from '../shared/client.js'
import type { AgentContext } from './schemas.js'
import { canonicalScopePath } from './path-identity.js'
import { MAX_ANALYSIS_BYTES, validateSymbolEdit } from '../symbols/index.js'
import type { SymbolOptions } from '../symbols/index.js'
import { isModeledEditPayload, proposedContent } from './edit-content.js'
import { receiptInvalidatedBy, verifyOfflineReceipt } from './offline-receipt.js'
import { isActiveTask, sameReservation } from './task-identity.js'
import { validateRepositoryBinding } from './repository-guard.js'
import { checkedSourcePath, isWithin } from './source-path.js'
import { isNativeReadTool, validateNativeRead } from './read-only.js'

export interface GateOptions extends SymbolOptions {
  onSnapshotObserved?: (snapshot: Snapshot) => Promise<unknown>
}

export const MCP_SERVER_NAME = 'agent_pr_monitor'
export const COORDINATION_TOOLS = [
  'read_plan', 'list_tasks', 'task_status', 'submit_task', 'revise_task',
  'acknowledge_stop', 'report_completion', 'cancel_task', 'set_plan',
  'repository_status', 'list_symbols', 'link_pull_request',
] as const

export interface ToolInvocation {
  name: string
  input: Record<string, unknown>
  sessionId: string
  cwd: string
  serverName?: string
  serverSource?: string
}

export const isCoordinationTool = (invocation: ToolInvocation): boolean => {
  const { name, serverName, serverSource } = invocation
  // Reject an explicit mismatching provenance even if the name looks familiar.
  if (serverName && serverName !== MCP_SERVER_NAME) return false
  if (serverSource && !['project', 'local', 'user'].includes(serverSource)) return false
  return COORDINATION_TOOLS.some(tool => (
    (serverName === MCP_SERVER_NAME && name === tool)
    || name === `mcp__${MCP_SERVER_NAME}__${tool}`
    || name === `${MCP_SERVER_NAME}_${tool}`
  ))
}

const deny = (reason: string): GateDecision => ({ allow: false, reason })
const allow = (reason: string): GateDecision => ({ allow: true, reason })
const followup = ' Read task_status and the shared plan; ask the user to cancel or revise overlapping work. Coordination tools remain available.'

const patchPaths = (command: unknown): string[] => {
  if (typeof command !== 'string') return []
  const lines = command.trimEnd().split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') return []
  const operations = lines.filter(line => /^\*\*\* (Add File|Update File|Delete File|Move to): /.test(line))
  if (operations.length === 0) return []
  if (lines.some(line => line.startsWith('*** ') && !/^\*\*\* (Begin Patch|End Patch|End of File|Add File: .+|Update File: .+|Delete File: .+|Move to: .+)$/.test(line))) return []
  return operations.map(line => line.slice(line.indexOf(': ') + 2))
}

const editPaths = (invocation: ToolInvocation): string[] => {
  if (invocation.name === 'apply_patch') return patchPaths(invocation.input.command)
  const knownFileTools = ['Edit', 'Write', 'MultiEdit', 'Delete', 'edit', 'write', 'multiedit']
  if (!knownFileTools.includes(invocation.name)) return []
  const supplied = ['file_path', 'filePath', 'path'].filter(key => key in invocation.input).map(key => invocation.input[key])
  if (supplied.length === 0 || supplied.some(value => typeof value !== 'string' || value.length === 0)) return []
  // Do not authorize one path while a client-specific alias points elsewhere.
  const distinct = [...new Set(supplied as string[])]
  return distinct.length === 1 ? distinct : []
}

export const evaluateGate = async (
  api: WorkspaceApi,
  context: AgentContext,
  invocation: ToolInvocation,
  options: GateOptions = {},
): Promise<GateDecision> => {
  if (isCoordinationTool(invocation)) return allow('Workspace coordination remains available')
  if (invocation.sessionId !== context.sessionId) return deny('This agent session is not bound to the task context.' + followup)
  if (isNativeReadTool(invocation.name)) {
    try {
      await validateNativeRead(context, invocation)
      return allow('Bounded native source inspection remains available before work and while blocked')
    } catch { return deny('Native read/search input is outside the qualified source inspection policy; use a specific safe source path.') }
  }
  if (!context.taskId || context.revision === undefined) return deny('Read the shared plan and register a task before starting work.' + followup)
  if ((context.offlineRevokedThrough?.[context.taskId] ?? -1) >= context.revision) return deny('A later local stop or revision invalidated this task acceptance.' + followup)
  try {
    const admission = async () => {
      const state = await api.snapshot().catch(error => {
        if (!(error instanceof WorkspaceConnectionError) || !error.offlineEligible) throw error
        return undefined
      })
      if (state) await options.onSnapshotObserved?.(state)
      if (state?.hasAuthority === true) {
        if (context.offlineAuthority && !state.repository) throw new Error('LAN workspace repository is not bound')
        await validateRepositoryBinding(context.repositoryRoot, state.repository)
        return { task: state.tasks[context.taskId!], offline: false }
      }
      const receipt = verifyOfflineReceipt(context)
      if (state && receiptInvalidatedBy(receipt, state)) throw new Error('Observed task state revoked the offline receipt')
      await validateRepositoryBinding(context.repositoryRoot, receipt.repository)
      return { task: receipt.task, offline: true }
    }
    const { task, offline } = await admission()
    if (!task || task.ownerId !== context.ownerId || task.sessionId !== context.sessionId || task.agent !== context.agent) {
      return deny('Task ownership or agent session does not match the current workspace.' + followup)
    }
    if (task.revision !== context.revision) return deny('Task revision changed; an old acceptance cannot authorize work.' + followup)
    if (task.status !== 'active' || task.stopAcknowledged !== false || task.conflicts.length > 0) {
      return deny(`Task is ${task.status}; stop subsequent work.` + followup)
    }
    const files = editPaths(invocation)
    if (files.length === 0 || !isModeledEditPayload(invocation)) {
      return deny('This tool has no proven edit scope. Arbitrary shell, delegation, and unknown tool payloads remain unqualified.' + followup)
    }
    const root = await realpath(context.repositoryRoot)
    const cwd = await realpath(invocation.cwd)
    if (cwd !== root && !isWithin(root, cwd)) return deny('Agent working directory is outside the selected repository')
    const checked = await Promise.all(files.map(async file => (await checkedSourcePath(root, cwd, file)).canonical))
    const claimedFiles = new Set(task.scopes.filter(scope => scope.kind === 'file').map(scope => canonicalScopePath(scope.path)))
    const unclaimed = checked.map((file, index) => ({ file, index })).filter(({ file }) => !claimedFiles.has(file))
    const decisions = await Promise.all(unclaimed.map(async ({ file, index }) => {
      const handle = await open(path.resolve(cwd, files[index]), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > MAX_ANALYSIS_BYTES) return false
        const buffer = Buffer.alloc(before.size + 1)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const after = await handle.stat()
        if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return false
        const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
        const proposed = proposedContent(invocation, source)
        if (proposed === undefined) return false
        return (await validateSymbolEdit(file, source, proposed, task.scopes, options)).allow
      } finally { await handle.close() }
    }))
    if (decisions.some(decision => !decision)) return deny('The proposed edit cannot be proven inside a reserved function. Reserve the whole file or narrow the edit.' + followup)
    if (unclaimed.length > 0) {
      const current = await admission().catch(() => undefined)
      const latest = current?.task
      if (!latest || !sameReservation(latest, task) || !isActiveTask(latest)) {
        return deny('The task or coordination authority changed during symbol validation.' + followup)
      }
    }
    return allow(offline ? 'Existing accepted scope verified from its signed offline receipt; no new scope was granted'
      : 'Current active task and declared scope verified against the local coordinator')
  } catch {
    return deny('Workspace or scope validation is unavailable; the action is blocked.' + followup)
  }
}
