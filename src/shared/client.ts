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

interface Connection { config: EndpointConfig; url: URL }
const connect = (config: EndpointConfig): Connection => ({ config, url: validateEndpoint(config) })

/**
 * `republished` reads the endpoint the app currently publishes (nothing while it is closed), so an
 * integration that outlives an app restart follows the new endpoint instead of its first one.
 */
export const createWorkspaceClient = (
  config: EndpointConfig | undefined,
  republished?: () => Promise<EndpointConfig | undefined>,
): WorkspaceApi => {
  let active = config && connect(config)
  // Kept across endpoints: a mutation with an uncertain outcome must reuse its ID after a restart.
  const pendingRequests = new Map<string, string>()

  const current = async (): Promise<Connection | undefined> => {
    const latest = republished ? await republished() : active?.config
    if (!latest) return undefined
    if (!active || latest.url !== active.config.url || latest.token !== active.config.token) active = connect(latest)
    return active
  }

  const send = async <T>({ config, url }: Connection, path: string, body?: CommandRequest): Promise<T> => {
    try {
      const response = await fetch(new URL(path, url), {
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

  const request = async <T>(path: string, body?: CommandRequest): Promise<T> => {
    const used = await current()
    if (!used) throw new WorkspaceConnectionError('The local app is closed', true, true)
    try { return await send<T>(used, path, body) } catch (error) {
      if (!republished || !(error instanceof WorkspaceConnectionError)) throw error
      // The app may have restarted during the request; retry once, only on a different endpoint.
      const latest = await current()
      if (!latest || latest === used) throw error
      return send<T>(latest, path, body)
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
