import { contextBridge, ipcRenderer } from 'electron'
import type { Command } from '../shared/contracts.js'
import type { AgentSetupRequest } from '../shared/agent-setup.js'

contextBridge.exposeInMainWorld('workspace', {
  snapshot: () => ipcRenderer.invoke('workspace:snapshot'),
  command: (command: Command, expectedWorkspaceKey: string) => ipcRenderer.invoke('workspace:command', command, expectedWorkspaceKey),
  runtime: () => ipcRenderer.invoke('workspace:runtime'),
  pool: {
    snapshot: () => ipcRenderer.invoke('pool:snapshot'),
    inspectInvitation: (invitation: string) => ipcRenderer.invoke('pool:inspect-invitation', invitation),
    create: (input: unknown) => ipcRenderer.invoke('pool:create', input),
    join: (input: unknown) => ipcRenderer.invoke('pool:join', input),
    open: (input: unknown) => ipcRenderer.invoke('pool:open', input),
    retryJoin: (input: unknown) => ipcRenderer.invoke('pool:retry-join', input),
  },
  repository: {
    snapshot: () => ipcRenderer.invoke('repository:snapshot'),
    choose: () => ipcRenderer.invoke('repository:choose'),
    refreshLocal: () => ipcRenderer.invoke('repository:refresh-local'),
    refreshGitHub: () => ipcRenderer.invoke('repository:refresh-github'),
    setSessionToken: (token: string) => ipcRenderer.invoke('repository:session-token', token),
    observeTaskPullRequest: (taskId: string, expectedRevision: number, workspaceKey: string) =>
      ipcRenderer.invoke('repository:observe-task-pr', { taskId, expectedRevision }, workspaceKey),
  },
  agents: {
    inspect: () => ipcRenderer.invoke('agents:inspect'),
    prepare: (request: AgentSetupRequest) => ipcRenderer.invoke('agents:prepare', request),
  },
})
