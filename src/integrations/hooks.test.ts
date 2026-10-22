import { describe, expect, it, vi } from 'vitest'
import { createOpenCodeGate, nativeHookOutput, parseHookInput, runNativeHook } from './hooks.js'
import { sampleContext, sampleSnapshot } from './fixtures.test-support.js'

describe('native client adapters', () => {
  it.each(['codex', 'claude-code'] as const)('returns documented %s PreToolUse denial without unsupported stop fields', agent => {
    expect(nativeHookOutput(agent, { allow: false, reason: 'Task overlap: stop' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Task overlap: stop' },
    })
    expect(nativeHookOutput(agent, { allow: true, reason: 'Current' })).toEqual({})
  })

  it('returns Cursor permission and both human/agent reasons', () => {
    expect(nativeHookOutput('cursor', { allow: false, reason: 'Scope changed' })).toEqual({ permission: 'deny', user_message: 'Scope changed', agent_message: 'Scope changed' })
  })

  it('parses Codex apply_patch tool_input.command and native session', () => {
    expect(parseHookInput('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'patch' }, session_id: 'native-session', cwd: '/project' })).toMatchObject({ name: 'apply_patch', input: { command: 'patch' }, sessionId: 'native-session' })
  })

  it('uses Cursor conversation identity and preserves MCP server identity', () => {
    expect(parseHookInput('cursor', { hook_event_name: 'preToolUse', tool_name: 'read_plan', tool_input: {}, conversation_id: 'conversation-a', cwd: '/project', mcp_server_name: 'agent_pr_monitor' })).toMatchObject({ sessionId: 'conversation-a', serverName: 'agent_pr_monitor' })
  })

  it('rejects malformed hook input with a native denial rather than throwing or allowing', async () => {
    const api = { snapshot: vi.fn(async () => sampleSnapshot()), command: vi.fn() }
    const result = await runNativeHook('claude-code', api, sampleContext('/tmp'), { tool_name: 'Edit' })
    expect(result.decision.allow).toBe(false)
    expect(result.output).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny')
    expect(api.snapshot).not.toHaveBeenCalled()
  })

  it('throws before an OpenCode tool runs and leaves exact coordination tools callable', async () => {
    const api = { snapshot: vi.fn(async () => sampleSnapshot()), command: vi.fn() }
    const context = { ...sampleContext('/tmp'), agent: 'opencode' as const }
    const hook = createOpenCodeGate(api, async () => context, '/tmp')['tool.execute.before']
    await expect(hook({ tool: 'bash', sessionID: 'session-a' }, { args: { command: 'touch x' } })).rejects.toThrow('Agent PR Monitor:')
    await expect(hook({ tool: 'agent_pr_monitor_read_plan', sessionID: 'session-a' }, { args: {} })).resolves.toBeUndefined()
  })

  it('denies an OpenCode context load failure', async () => {
    const hook = createOpenCodeGate({ snapshot: vi.fn(), command: vi.fn() }, async () => { throw new Error('Context missing') }, '/tmp')['tool.execute.before']
    await expect(hook({ tool: 'edit', sessionID: 'session-a' }, { args: {} })).rejects.toThrow('Agent PR Monitor: Context missing')
  })
})
