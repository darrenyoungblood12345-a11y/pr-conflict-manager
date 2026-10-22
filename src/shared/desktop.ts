export interface DesktopRuntime {
  status: 'starting' | 'ready' | 'unavailable'
  message: string
  endpointFile?: string
  workspaceKey: string
  workspaceName: string
  mode: 'local' | 'lan'
}
