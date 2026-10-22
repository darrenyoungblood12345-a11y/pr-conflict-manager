import type { Snapshot, Task } from '../shared/contracts.js'
import type { AgentContext } from './schemas.js'

export const sampleTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-a', ownerId: 'owner-a', sessionId: 'session-a', agent: 'claude-code',
  branch: 'feat/task-a', baseCommit: 'a'.repeat(40), description: 'Add validation to the save function',
  planRevision: 1, scopes: [{ path: 'source.ts', kind: 'file' }],
  revision: 1, status: 'active', stopAcknowledged: false, prMerged: false, conflicts: [],
  ...overrides,
})

export const sampleSnapshot = (task = sampleTask(), overrides: Partial<Snapshot> = {}): Snapshot => ({
  nodeId: 'mac-a', leaderId: 'mac-a', hasAuthority: true, commitIndex: 7, members: [],
  plan: { revision: 1, markdown: 'Implement carefully' }, tasks: { [task.id]: task }, events: [],
  ...overrides,
})

export const sampleContext = (repositoryRoot: string): AgentContext => ({
  repositoryRoot, ownerId: 'owner-a', sessionId: 'session-a', agent: 'claude-code', taskId: 'task-a', revision: 1,
})
