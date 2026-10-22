import type { Task, TaskProposal } from '../shared/contracts.js'
import { canonicalScopePath } from './path-identity.js'

export const proposalIdentity = (task: TaskProposal) => JSON.stringify({
  id: task.id, ownerId: task.ownerId, sessionId: task.sessionId, agent: task.agent,
  branch: task.branch, baseCommit: task.baseCommit.toLowerCase(), description: task.description,
  planRevision: task.planRevision,
  scopes: [...new Set(task.scopes.map(scope => JSON.stringify({
    path: canonicalScopePath(scope.path), kind: scope.kind,
    ...(scope.kind === 'symbol' ? { symbol: scope.symbol } : {}),
  })))].sort(),
})

export const sameReservation = (left: Task, right: Task) => left.revision === right.revision
  && proposalIdentity(left) === proposalIdentity(right)
  && left.pullRequest?.number === right.pullRequest?.number

export const isActiveTask = (task: Task) => task.status === 'active'
  && task.stopAcknowledged === false && task.conflicts.length === 0
