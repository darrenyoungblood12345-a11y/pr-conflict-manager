import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Command, CommandResult, Scope, SignedTaskReceipt, Snapshot, Task, TaskProposal, WorkspaceApi } from '../shared/contracts.js'
import type { AgentContext } from './schemas.js'
import { linkPullRequestSchema, ownedTaskSchema, reviseTaskSchema, scopeSchema, setPlanSchema, taskProposalSchema } from './schemas.js'
import { proposalIdentity } from './task-identity.js'
import { verifyOfflineReceipt } from './offline-receipt.js'
import { inspectRepository } from '../repository/local-git.js'
import { validateDeclaredScopes } from '../symbols/index.js'
import type { SymbolOptions } from '../symbols/index.js'
import { realpath } from 'node:fs/promises'
import { checkedSourcePath } from './source-path.js'

interface BridgeOptions {
  context: Pick<AgentContext, 'ownerId' | 'sessionId' | 'agent' | 'offlineAuthority'>
  onTaskAccepted?: (task: Task, receipt?: SignedTaskReceipt) => Promise<void>
  qualifyScopes?: (scopes: Scope[]) => Promise<{ scopes: Scope[]; warnings: string[] }>
  onSnapshotObserved?: (snapshot: Snapshot) => Promise<unknown>
  validateRepository?: (snapshot: Snapshot) => Promise<void>
  repositoryRoot?: string
  symbolOptions?: SymbolOptions
}

const textResult = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  isError,
})

export const createWorkspaceMcpServer = (api: WorkspaceApi, options: BridgeOptions) => {
  const server = new McpServer({ name: 'agent-pr-monitor', version: '0.1.0' })
  const snapshot = async () => {
    const state = await api.snapshot()
    await options.onSnapshotObserved?.(state)
    return state
  }
  const belongsToSession = (task: TaskProposal) => (
    task.ownerId === options.context.ownerId
    && task.sessionId === options.context.sessionId
    && task.agent === options.context.agent
  )

  const protect = (handler: () => Promise<ReturnType<typeof textResult>>) => handler().catch(() => (
    textResult({ ok: false, error: { code: 'unavailable', message: 'Workspace coordination is unavailable; no editing permission was granted' } }, true)
  ))

  const mutate = async (command: Command, acceptedTaskId?: string) => {
    if ('task' in command && options.validateRepository) await options.validateRepository(await snapshot())
    const qualification = 'task' in command && options.qualifyScopes
      ? await options.qualifyScopes(command.task.scopes) : undefined
    if (qualification && 'task' in command) {
      command = { ...command, task: { ...command.task, scopes: qualification.scopes } }
    }
    const result: CommandResult = await api.command(command)
    if (result.state) await options.onSnapshotObserved?.({ ...result.state, nodeId: '', leaderId: '', hasAuthority: false, commitIndex: 0, members: [] })
    if (!result.ok) return textResult(result, true)
    // A deduplicated command result may describe historical state. Never issue a
    // task context or an editing permission from that response alone.
    const state = await snapshot()
    const taskId = acceptedTaskId ?? result.taskId
    const task = taskId ? state.tasks[taskId] : undefined
    const accepted = taskId ? result.state?.tasks[taskId] : undefined
    const initiallyAllowed = Boolean(state.hasAuthority === true && task && accepted && accepted.revision === task.revision
      && belongsToSession(task) && belongsToSession(accepted)
      && task.status === 'active' && task.stopAcknowledged === false && task.conflicts.length === 0
      && accepted.status === 'active' && accepted.stopAcknowledged === false && accepted.conflicts.length === 0
      && proposalIdentity(accepted) === proposalIdentity(task)
      && accepted.pullRequest?.number === task.pullRequest?.number
      && (!('task' in command) || proposalIdentity(command.task) === proposalIdentity(task)))
    const receipt = acceptedTaskId && initiallyAllowed && task && options.context.offlineAuthority && api.taskReceipt
      ? await api.taskReceipt(task.id, task.revision).then(value => {
        verifyOfflineReceipt({ ...options.context, repositoryRoot: '', taskId: task.id, revision: task.revision }, value, task)
        return value
      }).catch(() => undefined) : undefined
    const finalState = acceptedTaskId && initiallyAllowed ? await snapshot() : state
    const finalTask = taskId ? finalState.tasks[taskId] : undefined
    const editingAllowed = initiallyAllowed && finalState.hasAuthority === true && Boolean(finalTask && task
      && finalTask.status === 'active' && finalTask.stopAcknowledged === false && finalTask.conflicts.length === 0
      && finalTask.revision === task.revision && proposalIdentity(finalTask) === proposalIdentity(task)
      && finalTask.pullRequest?.number === task.pullRequest?.number)
    if (acceptedTaskId && editingAllowed && finalTask) {
      if (receipt) await options.onTaskAccepted?.(finalTask, receipt)
      else await options.onTaskAccepted?.(finalTask)
    }
    return textResult({
      ok: true,
      hasAuthority: finalState.hasAuthority,
      commitIndex: finalState.commitIndex,
      task: finalTask,
      editingAllowed,
      offlineContinuation: editingAllowed && Boolean(receipt),
      scopeWarnings: qualification?.warnings ?? [],
      note: 'This response is observational. The native gate checks current state again before each covered action.',
    })
  }

  const owned = async (command: Extract<Command, { ownerId: string }>) => {
    const state = await snapshot()
    const task = state.tasks[command.taskId]
    if (!task || !belongsToSession(task) || command.ownerId !== options.context.ownerId) {
      return textResult({ ok: false, error: { code: 'ownership_mismatch', message: 'This bridge can only change tasks owned by its configured agent session' } }, true)
    }
    if ('task' in command && (!belongsToSession(command.task) || command.task.id !== command.taskId)) {
      return textResult({ ok: false, error: { code: 'ownership_mismatch', message: 'A revision cannot replace the task identity' } }, true)
    }
    return mutate(command, ['revise_task', 'link_pull_request'].includes(command.type) ? command.taskId : undefined)
  }

  server.registerTool('read_plan', {
    description: 'Read the current shared project plan before proposing work. Cached history cannot authorize a new task.',
    inputSchema: {},
  }, () => protect(async () => {
    const state = await snapshot()
    return textResult({ plan: state.plan, hasAuthority: state.hasAuthority, identity: options.context })
  }))

  server.registerTool('list_tasks', {
    description: 'Read all current task plans, reservations, conflicts, and owner stop acknowledgements.',
    inputSchema: {},
  }, () => protect(async () => {
    const state = await snapshot()
    return textResult({ tasks: Object.values(state.tasks), hasAuthority: state.hasAuthority })
  }))

  server.registerTool('repository_status', {
    description: 'Inspect the selected local clone without writing, fetching or changing branches. Available before task registration and while blocked.',
    inputSchema: {},
  }, () => protect(async () => {
    if (!options.repositoryRoot) throw new Error('No selected repository')
    return textResult(await inspectRepository(options.repositoryRoot))
  }))

  server.registerTool('list_symbols', {
    description: 'Read fixture-qualified function/container names and ranges from one safe selected-repository source file. Does not reserve or edit anything.',
    inputSchema: { path: scopeSchema.shape.path },
  }, ({ path }) => protect(async () => {
    if (!options.repositoryRoot) throw new Error('No selected repository')
    const root = await realpath(options.repositoryRoot)
    await checkedSourcePath(root, root, path)
    const result = await validateDeclaredScopes(root, [{ path, kind: 'file' }], options.symbolOptions)
    if (!result.ok) throw new Error('Source inspection unavailable')
    return textResult({ path, analysis: result.files[0]?.analysis })
  }))

  server.registerTool('task_status', {
    description: 'Read current task revision and status. Historical acceptance is not permission to resume editing.',
    inputSchema: { taskId: ownedTaskSchema.shape.taskId },
  }, ({ taskId }) => protect(async () => {
    const state = await snapshot()
    return textResult({ task: state.tasks[taskId] ?? null, hasAuthority: state.hasAuthority, commitIndex: state.commitIndex })
  }))

  server.registerTool('set_plan', {
    description: 'Replace the shared project plan with an explicit expected revision. Preserve user-approved project requirements.',
    inputSchema: setPlanSchema.shape,
  }, input => protect(() => mutate({ type: 'set_plan', ...setPlanSchema.parse(input) })))

  server.registerTool('submit_task', {
    description: 'Submit a detailed task and function/file scope after reading the plan. A blocked registration is not permission to work. Use whole-file scope when parsing is unreliable.',
    inputSchema: { task: taskProposalSchema },
  }, ({ task }) => protect(async () => {
    if (!belongsToSession(task)) return textResult({ ok: false, error: { code: 'ownership_mismatch', message: 'Use the configured owner, agent kind, and session identity returned by read_plan' } }, true)
    return mutate({ type: 'register_task', task }, task.id)
  }))

  server.registerTool('revise_task', {
    description: 'Replace an owned task scope at its current revision after acknowledging all admitted/background writes have stopped. Coordinate additional scope before editing it.',
    inputSchema: reviseTaskSchema.shape,
  }, input => protect(() => owned({ type: 'revise_task', ...reviseTaskSchema.parse(input) })))

  server.registerTool('link_pull_request', {
    description: 'Associate an existing GitHub PR number with this owned task at its exact revision. This does not create, edit or merge a PR. Active task acceptance must refresh after a link revision.',
    inputSchema: linkPullRequestSchema.shape,
  }, input => protect(() => owned({ type: 'link_pull_request', ...linkPullRequestSchema.parse(input) })))

  const transitions = ['acknowledge_stop', 'report_completion', 'cancel_task'] as const
  const descriptions = {
    acknowledge_stop: 'Acknowledge that all admitted and background writes for this exact task revision have stopped. Do not acknowledge merely because a pause was requested.',
    report_completion: 'Report editing finished. Reservations remain held until owner stop acknowledgement and observed PR merge; this does not merge code.',
    cancel_task: 'Abandon an owned task after acknowledging that all admitted and background writes have stopped. Requires the current task revision.',
  }
  transitions.forEach(type => server.registerTool(type, {
    description: descriptions[type],
    inputSchema: ownedTaskSchema.shape,
  }, input => protect(() => owned({ type, ...ownedTaskSchema.parse(input) }))))

  return server
}
