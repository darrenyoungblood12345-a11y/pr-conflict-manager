import type { Command, CommandResult, Snapshot } from '../shared/contracts.js'
import type { RepositoryApi } from '../shared/repository.js'
import type { WorkspacePoolApi } from '../shared/lan.js'
import type { DesktopRuntime } from '../shared/desktop.js'
import type { AgentSetupApi } from '../shared/agent-setup.js'

declare global {
  interface Window {
    workspace?: {
      snapshot(): Promise<Snapshot>
      command(command: Command, expectedWorkspaceKey: string): Promise<CommandResult>
      runtime(): Promise<DesktopRuntime>
      pool: WorkspacePoolApi
      repository: RepositoryApi
      agents: AgentSetupApi
    }
  }
}

export {}
