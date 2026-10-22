import { X509Certificate, createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { LanPublic } from '../shared/lan.js'

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const invitationSchema = z.object({
  workspaceId: identifier, deviceId: identifier, controlUrl: z.string().max(256), raftEndpoint: z.string().max(256),
  caCertPEM: z.string().max(16384), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const isLanAddress = (address: string) => {
  if (address.includes('%')) return false
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number)
    return first === 10 || first === 127 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31 || first === 169 && second === 254
  }
  return isIP(address) === 6 && (address === '::1' || /^(?:f[cd]|fe[89ab])/i.test(address))
}

const validEndpoint = (endpoint: string) => {
  try {
    const url = new URL(`https://${endpoint}`)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return isLanAddress(host) && Number(url.port) >= 1 && Number(url.port) <= 65535 && endpoint === url.host
  } catch { return false }
}

// Desktop discovery currently uses UDP4. Scoped IPv6 link-local addresses cannot
// be represented by the current invitation transport, so do not offer them as
// defaults. Native IPv6 transport qualification remains a separate test matrix.
export const lanInterfaces = (inventory = networkInterfaces()) => [
  ...Object.entries(inventory).flatMap(([name, values]) => (values ?? []).flatMap(value => (
    !value.internal && isIP(value.address) === 4 && !value.address.startsWith('127.') && isLanAddress(value.address)
      ? [{ name, address: value.address }] : []
  ))).sort((left, right) => Number(left.address.startsWith('169.254.')) - Number(right.address.startsWith('169.254.'))
    || left.name.localeCompare(right.name) || left.address.localeCompare(right.address)),
  { name: 'This Mac only · testing', address: '127.0.0.1' },
]

/** Decode public identity locally; this function performs no network requests. */
export const parseLanInvitation = (input: string): LanPublic => {
  try {
    if (Buffer.byteLength(input, 'utf8') > 32768) throw new Error()
    const invitation = invitationSchema.parse(JSON.parse(input))
    const control = new URL(invitation.controlUrl)
    if (control.protocol !== 'https:' || invitation.controlUrl !== control.origin
      || !validEndpoint(control.host) || !validEndpoint(invitation.raftEndpoint)) throw new Error()
    if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(invitation.caCertPEM)) throw new Error()
    const ca = new X509Certificate(invitation.caCertPEM)
    const fingerprint = createHash('sha256').update(ca.raw).digest('hex')
    if (!ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey) || fingerprint !== invitation.fingerprint
      || ca.subject !== `CN=${invitation.deviceId}.${invitation.workspaceId}.agent-pr-monitor.invalid`
      || Date.now() < Date.parse(ca.validFrom) || Date.now() >= Date.parse(ca.validTo)) throw new Error()
    return invitation
  } catch {
    throw new Error('The invitation is invalid. Use a complete invitation from the workspace app and compare its fingerprint directly with that Mac.')
  }
}
