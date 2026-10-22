import { randomUUID } from 'node:crypto'
import type { CommandRequest, CommandResult, EndpointConfig, SignedTaskReceipt, Snapshot, WorkspaceApi } from './contracts.js'

export class WorkspaceConnectionError extends Error {
  constructor(message: string, readonly retryable = true, readonly offlineEligible = false) {
    super(message)
    this.name = 'WorkspaceConnectionError'
  }
}

export const validateEndpoint = (config: EndpointConfig): URL => {
  const url = (() => {
    try { return new URL(config.url) } catch { throw new WorkspaceConnectionError('The local coordinator endpoint is invalid', false) }
  })()
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^[a-zA-Z0-9_-]{32,}$/.test(config.token)) {
    throw new WorkspaceConnectionError('The local coordinator endpoint is invalid', false)
  }
  return url
}

export const createWorkspaceClient = (config: EndpointConfig): WorkspaceApi => {
  const endpoint = validateEndpoint(config)
  const pendingRequests = new Map<string, string>()

  const request = async <T>(path: string, body?: CommandRequest): Promise<T> => {
    try {
      const response = await fetch(new URL(path, endpoint), {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new WorkspaceConnectionError(`Local coordinator returned HTTP ${response.status}`, response.status >= 500, response.status >= 500)
      }
      try { return await response.json() as T } catch { throw new WorkspaceConnectionError('The coordinator returned an invalid response', false) }
    } catch (error) {
      if (error instanceof WorkspaceConnectionError) throw error
      throw new WorkspaceConnectionError('The local coordinator is unavailable; no new permission was granted', true, true)
    }
  }

  return {
    snapshot: () => request<Snapshot>('/v1/snapshot'),
    taskReceipt: (taskId, revision) => request<SignedTaskReceipt>(`/v1/task-receipt?taskId=${encodeURIComponent(taskId)}&revision=${revision}`),
    command: async command => {
      const key = JSON.stringify(command, (_, value: unknown) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        }
        return value
      })
      if (!pendingRequests.has(key) && pendingRequests.size >= 128) {
        throw new WorkspaceConnectionError('Resolve pending coordinator requests before starting more work')
      }
      const requestId = pendingRequests.get(key) ?? randomUUID()
      pendingRequests.set(key, requestId)
      try {
        const result = await request<CommandResult>('/v1/commands', { requestId, command })
        if (typeof result.ok !== 'boolean') throw new WorkspaceConnectionError('The coordinator returned an invalid decision')
        pendingRequests.delete(key)
        return result
      } catch (error) {
        if (error instanceof WorkspaceConnectionError && !error.retryable) pendingRequests.delete(key)
        throw error
      }
    },
  }
}
