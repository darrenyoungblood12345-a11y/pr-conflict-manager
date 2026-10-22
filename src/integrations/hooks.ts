import type { AgentKind, GateDecision, WorkspaceApi } from '../shared/contracts.js'
import { evaluateGate } from './gate.js'
import type { GateOptions, ToolInvocation } from './gate.js'
import type { AgentContext } from './schemas.js'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hook payload must be an object')
  return value as Record<string, unknown>
}

const requiredString = (value: unknown) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing hook field')
  return value
}

export const parseHookInput = (agent: Exclude<AgentKind, 'opencode'>, raw: unknown): ToolInvocation => {
  const payload = record(raw)
  const expectedEvent = agent === 'cursor' ? 'preToolUse' : 'PreToolUse'
  if (payload.hook_event_name !== expectedEvent) throw new Error('Unsupported hook event')
  const provenance = payload.mcp_server ? record(payload.mcp_server) : undefined
  const serverName = payload.mcp_server_name ?? provenance?.name
  const serverSource = provenance?.source
  return {
    name: requiredString(payload.tool_name),
    input: record(payload.tool_input),
    sessionId: requiredString(agent === 'cursor' ? payload.conversation_id : payload.session_id),
    cwd: requiredString(payload.cwd),
    ...(typeof serverName === 'string' ? { serverName } : {}),
    ...(typeof serverSource === 'string' ? { serverSource } : {}),
  }
}

export const nativeHookOutput = (agent: Exclude<AgentKind, 'opencode'>, decision: GateDecision) => {
  if (agent === 'cursor') return {
    permission: decision.allow ? 'allow' : 'deny',
    ...(decision.allow ? {} : { user_message: decision.reason, agent_message: decision.reason }),
  }
  // An accepted coordination check does not bypass the client's normal tool
  // permission policy. Only refusals return permissionDecision.
  return decision.allow ? {} : {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  }
}

export const runNativeHook = async (
  agent: Exclude<AgentKind, 'opencode'>,
  api: WorkspaceApi,
  context: AgentContext,
  payload: unknown,
  options: GateOptions = {},
) => {
  const decision = await Promise.resolve().then(() => {
    if (context.agent !== agent) throw new Error('Context agent mismatch')
    return evaluateGate(api, context, parseHookInput(agent, payload), options)
  }).catch(() => ({ allow: false, reason: 'Invalid hook input or local setup. Work is blocked; verify the integration in the app.' }))
  return { decision, output: nativeHookOutput(agent, decision) }
}

export interface OpenCodeBeforeInput {
  tool: string
  sessionID: string
  callID?: string
}

export const createOpenCodeGate = (api: WorkspaceApi, loadContext: () => Promise<AgentContext>, cwd: string, options: GateOptions = {}) => ({
  'tool.execute.before': async (input: OpenCodeBeforeInput, output: { args: Record<string, unknown> }) => {
    try {
      const context = await loadContext()
      if (context.agent !== 'opencode') throw new Error('OpenCode context required')
      const decision = await evaluateGate(api, context, {
        name: requiredString(input.tool),
        input: record(output.args),
        sessionId: requiredString(input.sessionID),
        cwd,
      }, options)
      if (!decision.allow) throw new Error(decision.reason)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Agent PR Monitor:')) throw error
      const reason = error instanceof Error ? error.message : 'Integration unavailable'
      throw new Error(`Agent PR Monitor: ${reason}`)
    }
  },
})
