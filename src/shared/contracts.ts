export type AgentKind = 'codex' | 'cursor' | 'opencode' | 'claude-code'

export interface Scope {
  path: string
  kind: 'file' | 'symbol'
  symbol?: string
}

export interface TaskProposal {
  id: string
  ownerId: string
  sessionId: string
  agent: AgentKind
  branch: string
  baseCommit: string
  description: string
  planRevision: number
  scopes: Scope[]
}

export type TaskStatus = 'active' | 'blocked' | 'awaiting-merge' | 'completed' | 'cancelled'

export interface Task extends TaskProposal {
  pullRequest?: { number: number }
  revision: number
  status: TaskStatus
  stopAcknowledged: boolean
  prMerged: boolean
  conflicts: string[]
}

export interface ActivityEvent {
  index: number
  type: string
  taskId?: string
  message: string
}

export interface WorkspaceState {
  repository?: RepositoryIdentity
  plan: { revision: number; markdown: string }
  tasks: Record<string, Task>
  events: ActivityEvent[]
}

export interface Member {
  id: string
  address: string
  voter: boolean
}

export interface Snapshot extends WorkspaceState {
  nodeId: string
  leaderId: string
  hasAuthority: boolean
  commitIndex: number
  members: Member[]
}

interface OwnedTaskCommand {
  taskId: string
  ownerId: string
  expectedRevision: number
}

export type Command =
  | { type: 'bind_repository'; repository: RepositoryIdentity }
  | { type: 'set_plan'; expectedRevision: number; markdown: string }
  | { type: 'register_task'; task: TaskProposal }
  | ({ type: 'acknowledge_stop' } & OwnedTaskCommand)
  | ({ type: 'cancel_task' } & OwnedTaskCommand)
  | ({ type: 'report_completion' } & OwnedTaskCommand)
  | ({ type: 'revise_task'; task: TaskProposal } & OwnedTaskCommand)
  | ({ type: 'link_pull_request'; number: number } & OwnedTaskCommand)
  | { type: 'mark_pr_merged'; taskId: string; expectedRevision: number }

export interface CommandRequest {
  requestId: string
  command: Command
}

export interface CommandResult {
  ok: boolean
  error?: { code: string; message: string }
  taskId?: string
  state?: WorkspaceState
}

export interface EndpointConfig {
  url: string
  token: string
}

export interface OfflineAuthority {
  workspaceId: string
  deviceId: string
  caCertPEM: string
  repository?: RepositoryIdentity
}

export interface RepositoryIdentity {
  owner: string
  repo: string
}

export interface SignedTaskReceipt {
  payload: string
  signature: string
  certPEM: string
}

export interface GateContext {
  taskId: string
  ownerId: string
  sessionId: string
  revision: number
}

export interface GateDecision {
  allow: boolean
  reason: string
}

export interface WorkspaceApi {
  snapshot(): Promise<Snapshot>
  command(command: Command): Promise<CommandResult>
  taskReceipt?(taskId: string, revision: number): Promise<SignedTaskReceipt>
}
