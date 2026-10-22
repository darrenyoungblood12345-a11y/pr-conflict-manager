import { describe, expect, it } from 'vitest'
import { isCommand } from './validation.js'
import { taskProposalSchema } from '../integrations/schemas.js'

const task = {
  id: 'task-one', ownerId: 'person-one', sessionId: 'session-one', agent: 'codex',
  branch: 'feat/save', baseCommit: 'a'.repeat(40), description: 'Add safe save behavior',
  planRevision: 2, scopes: [{ kind: 'symbol', path: 'src/store.ts', symbol: 'Store.save' }],
}

describe('renderer IPC validation', () => {
  it('accepts a well-formed registration and bounded shared-plan update', () => {
    expect(isCommand({ type: 'register_task', task })).toBe(true)
    expect(isCommand({ type: 'set_plan', expectedRevision: 2, markdown: '' })).toBe(true)
  })

  it('rejects unknown operations and oversized or malformed payloads before service access', () => {
    expect(isCommand({ type: 'execute', command: 'anything' })).toBe(false)
    expect(isCommand({ type: 'bind_repository', repository: { owner: 'example', repo: 'project' } })).toBe(false)
    expect(isCommand({ type: 'mark_pr_merged', taskId: task.id, expectedRevision: 1 })).toBe(false)
    expect(isCommand({ type: 'set_plan', expectedRevision: 2, markdown: 'x'.repeat(65537) })).toBe(false)
    expect(isCommand({ type: 'register_task', task: { ...task, scopes: [{ kind: 'symbol', path: 'src/store.ts' }] } })).toBe(false)
    expect(isCommand({ type: 'register_task', task: { ...task, agent: 'unknown-agent' } })).toBe(false)
    expect(isCommand({ type: 'register_task', task: { ...task, scopes: [] } })).toBe(false)
  })

  it('requires a revision and owner for lifecycle changes', () => {
    expect(isCommand({ type: 'cancel_task', taskId: task.id })).toBe(false)
    expect(isCommand({ type: 'cancel_task', taskId: task.id, ownerId: task.ownerId, expectedRevision: -1 })).toBe(false)
    expect(isCommand({ type: 'acknowledge_stop', taskId: task.id, ownerId: task.ownerId, expectedRevision: 1 })).toBe(true)
    expect(isCommand({ type: 'link_pull_request', taskId: task.id, ownerId: task.ownerId, expectedRevision: 1, number: 42 })).toBe(true)
    expect(isCommand({ type: 'link_pull_request', taskId: task.id, ownerId: task.ownerId, expectedRevision: 1, number: 0 })).toBe(false)
  })

  it('rejects a scope revision that switches its task or owner identity', () => {
    const command = { type: 'revise_task', taskId: task.id, ownerId: task.ownerId, expectedRevision: 1, task }
    expect(isCommand(command)).toBe(true)
    expect(isCommand({ ...command, task: { ...task, id: 'another-task' } })).toBe(false)
    expect(isCommand({ ...command, task: { ...task, ownerId: 'another-person' } })).toBe(false)
  })

  it('uses the same strict UTF-8, identity, commit, and scope bounds as agent proposals', () => {
    const proposals = [
      task,
      { ...task, id: 'space in identity' },
      { ...task, branch: 'b'.repeat(257) },
      { ...task, description: '界'.repeat(2667) },
      { ...task, baseCommit: 'not-a-commit' },
      { ...task, scopes: [{ kind: 'file', path: '../outside.ts' }] },
      { ...task, scopes: [{ kind: 'file', path: 'src/store.ts', symbol: 'extra' }] },
      { ...task, scopes: Array.from({ length: 257 }, () => task.scopes[0]) },
      { ...task, unrecognized: true },
    ]
    proposals.forEach(proposal => {
      expect(isCommand({ type: 'register_task', task: proposal })).toBe(taskProposalSchema.safeParse(proposal).success)
    })
    expect(isCommand({ type: 'set_plan', expectedRevision: 2, markdown: '界'.repeat(21846) })).toBe(false)
    expect(isCommand({ type: 'acknowledge_stop', taskId: task.id, ownerId: task.ownerId, expectedRevision: 1, extra: true })).toBe(false)
  })
})
