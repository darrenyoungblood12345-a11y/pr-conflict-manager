import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isLanAddress, lanInterfaces, parseLanInvitation } from './lan-invitation.js'
import type { NetworkInterfaceInfo } from 'node:os'
import { lanInvitationFixture } from './lan-test-support.js'

let fixture: Awaited<ReturnType<typeof lanInvitationFixture>>
let nonCa: Awaited<ReturnType<typeof lanInvitationFixture>>
beforeAll(async () => { fixture = await lanInvitationFixture(); nonCa = await lanInvitationFixture(false) })
afterAll(async () => { await Promise.all([fixture, nonCa].filter(Boolean).map(item => rm(item.directory, { recursive: true, force: true }))) })

describe('public LAN invitation validation without network access', () => {
  it('accepts a real self-signed CA only when its pinned identity and fingerprint match', () => {
    expect(parseLanInvitation(JSON.stringify(fixture.invitation))).toEqual(fixture.invitation)
    expect(parseLanInvitation(JSON.stringify({ ...fixture.invitation, controlUrl: 'https://[fd12::15]:32100', raftEndpoint: '[fd12::15]:32101' })).controlUrl).toBe('https://[fd12::15]:32100')
    for (const replacement of [{ fingerprint: '0'.repeat(64) }, { deviceId: 'another-peer' }, { workspaceId: 'another-workspace' }, { caCertPEM: `${fixture.invitation.caCertPEM}${fixture.invitation.caCertPEM}` }, { unexpected: true }]) {
      expect(() => parseLanInvitation(JSON.stringify({ ...fixture.invitation, ...replacement }))).toThrow('invitation is invalid')
    }
  })

  it('rejects public hosts, credentials, paths, ambiguous ports, and non-LAN raft endpoints before any password is requested', () => {
    for (const controlUrl of ['http://192.168.1.15:32100', 'https://8.8.8.8:32100', 'https://example.com:32100', 'https://user:secret@192.168.1.15:32100', 'https://192.168.1.15:32100/path', 'https://192.168.1.15:32100?token=secret', 'https://127.1:32100', 'https://192.168.1.15:032100']) {
      expect(() => parseLanInvitation(JSON.stringify({ ...fixture.invitation, controlUrl }))).toThrow()
    }
    for (const raftEndpoint of ['8.8.8.8:32101', '192.168.1.15:32101/path', '192.168.1.15:0', '[fe80::1%en0]:32101', '0.0.0.0:32101']) {
      expect(() => parseLanInvitation(JSON.stringify({ ...fixture.invitation, raftEndpoint }))).toThrow()
    }
  })

  it('rejects non-CA, expired, and not-yet-valid certificates and oversized payloads', () => {
    expect(() => parseLanInvitation(JSON.stringify(nonCa.invitation))).toThrow()
    try {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.certificate.validTo) + 1)
      expect(() => parseLanInvitation(JSON.stringify(fixture.invitation))).toThrow()
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.certificate.validFrom) - 1)
      expect(() => parseLanInvitation(JSON.stringify(fixture.invitation))).toThrow()
    } finally { vi.restoreAllMocks() }
    expect(() => parseLanInvitation(' '.repeat(32769))).toThrow()
  })

  it('restricts literal addresses to local/private ranges', () => {
    expect(['10.1.2.3', '172.16.1.2', '192.168.5.4', '169.254.1.2', '127.0.0.1', '::1', 'fd12::1', 'fe80::1'].every(isLanAddress)).toBe(true)
    expect(['0.0.0.0', '8.8.8.8', '172.15.1.2', '172.32.1.2', 'example.com', 'fe80::1%en0', '2001:4860:4860::8888'].some(isLanAddress)).toBe(false)
  })

  it('offers usable private IPv4 before link-local/loopback and excludes unscoped IPv6 defaults', () => {
    const entry = (address: string, internal = false) => ({ address, internal }) as NetworkInterfaceInfo
    expect(lanInterfaces({
      en0: [entry('fe80::1cb2:1234'), entry('169.254.5.4'), entry('192.168.1.5')],
      en1: [entry('fd12::1'), entry('10.0.0.7'), entry('8.8.8.8')],
      lo0: [entry('127.0.0.1', true)],
    })).toEqual([
      { name: 'en0', address: '192.168.1.5' }, { name: 'en1', address: '10.0.0.7' },
      { name: 'en0', address: '169.254.5.4' }, { name: 'This Mac only · testing', address: '127.0.0.1' },
    ])
  })
})
