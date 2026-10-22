import type { EndpointConfig } from '../shared/contracts.js'
import type { LanStatus, PeerHint } from '../shared/lan.js'
import { validateEndpoint } from '../shared/client.js'

export const createLanClient = (config: EndpointConfig) => {
  const endpoint = validateEndpoint(config)
  const request = async <T>(path: string, hints?: PeerHint[]): Promise<T> => {
    try {
      const response = await fetch(new URL(path, endpoint), {
        method: hints ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${config.token}`, ...(hints ? { 'Content-Type': 'application/json' } : {}) },
        body: hints ? JSON.stringify({ peerHints: hints }) : undefined,
      })
      if (!response.ok) throw new Error()
      return await response.json() as T
    } catch { throw new Error('The local LAN coordinator is unavailable.') }
  }
  return {
    status: () => request<LanStatus>('/v1/lan/status'),
    updateHints: (hints: PeerHint[]) => request<{ ok: boolean }>('/v1/lan/peer-hints', hints),
  }
}
