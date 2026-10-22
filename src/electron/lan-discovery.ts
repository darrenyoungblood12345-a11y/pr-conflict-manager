import Bonjour from 'bonjour-service'
import type { LanPublic, PeerHint } from '../shared/lan.js'
import { isLanAddress } from './lan-invitation.js'

interface DiscoveredService { port: number; txt?: Record<string, unknown> }

/** Discovery supplies addresses only; TLS and the committed roster supply trust. */
export const discoveredHint = (service: DiscoveredService, workspaceId: string): PeerHint | null => {
  const txt = service.txt
  if (!txt || txt.workspace !== workspaceId || typeof txt.device !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(txt.device)
    || typeof txt.address !== 'string' || !isLanAddress(txt.address)
    || typeof txt.raft !== 'string' || !/^\d{1,5}$/.test(txt.raft)
    || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null
  const raftPort = Number(txt.raft)
  if (raftPort < 1 || raftPort > 65535) return null
  const host = txt.address.includes(':') ? `[${txt.address}]` : txt.address
  return { deviceId: txt.device, controlUrl: `https://${host}:${service.port}`, raftEndpoint: `${host}:${raftPort}` }
}

export const startLanDiscovery = (
  identity: LanPublic,
  members: () => string[],
  onHints: (hints: PeerHint[]) => Promise<unknown>,
  onUnavailable: () => void,
) => {
  const control = new URL(identity.controlUrl)
  const address = control.hostname.replace(/^\[|\]$/g, '')
  if (address === '127.0.0.1' || address === '::1') return () => undefined
  const raft = new URL(`https://${identity.raftEndpoint}`)
  let stopped = false
  const hints = new Map<string, PeerHint>()
  const options = { interface: address } as { interface: string } & Partial<Bonjour.ServiceConfig>
  const bonjour = new Bonjour(options, onUnavailable)
  const service = bonjour.publish({
    name: identity.deviceId, host: `${identity.deviceId}.local`, type: 'agentpr',
    subtypes: [identity.workspaceId], protocol: 'tcp', port: Number(control.port),
    txt: { workspace: identity.workspaceId, device: identity.deviceId, address, raft: raft.port },
  })
  const records = service.records.bind(service)
  service.records = () => records().filter(record => !['A', 'AAAA'].includes(record.type) || record.data === address)
  service.on('error', onUnavailable)
  const accept = (peer: DiscoveredService) => {
    const hint = discoveredHint(peer, identity.workspaceId)
    if (stopped || !hint || hint.deviceId === identity.deviceId || !members().includes(hint.deviceId)) return
    hints.set(hint.deviceId, hint)
  }
  const browser = bonjour.find({ type: 'agentpr', protocol: 'tcp', subtypes: [identity.workspaceId] }, accept)
  browser.on('txt-update', accept)
  browser.on('srv-update', accept)
  const timer = setInterval(() => {
    if (stopped || hints.size === 0) return
    const accepted = [...hints.values()].filter(hint => members().includes(hint.deviceId)).slice(0, 10)
    hints.clear()
    if (accepted.length) void onHints(accepted).catch(onUnavailable)
  }, 2000)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    browser.stop()
    service.stop()
    bonjour.destroy()
  }
}
