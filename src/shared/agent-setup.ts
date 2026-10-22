import type { AgentKind } from './contracts.js'

export interface AgentInstallation {
  agent: AgentKind
  installation: 'detected' | 'not-found' | 'unknown'
  version: string | null
  qualification: 'unverified' | 'version-blocked'
  summary: string
  limitations: string[]
}

export interface AgentSetupEnvironment {
  repositoryRoot: string | null
  endpointFile: string | null
  ready: boolean
  reason: string | null
  agents: AgentInstallation[]
}

export interface AgentSetupRequest {
  agent: AgentKind
  ownerId: string
  sessionId: string
  expectedRepositoryRoot: string
  expectedEndpointFile: string
}

export interface PreparedAgentSetup {
  agent: AgentKind
  repositoryRoot: string
  contextFile: string
  endpointFile: string
  launcherFile: string
  files: Array<{ path: string; contents: string }>
  instructions: string
  notices: string[]
}

export interface AgentSetupApi {
  inspect(): Promise<AgentSetupEnvironment>
  prepare(request: AgentSetupRequest): Promise<PreparedAgentSetup>
}
