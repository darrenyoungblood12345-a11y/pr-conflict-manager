import { expect, it } from 'vitest'
import { discoveredHint } from './lan-discovery.js'

it('treats service advertisements as bounded private address hints with a workspace identity', () => {
  const service = { port: 4242, txt: { workspace: 'workspace', device: 'device', address: '192.168.1.4', raft: '4243' } }
  expect(discoveredHint(service, 'workspace')).toEqual({ deviceId: 'device', controlUrl: 'https://192.168.1.4:4242', raftEndpoint: '192.168.1.4:4243' })
  expect(discoveredHint({ ...service, txt: { ...service.txt, address: 'fd00::4' } }, 'workspace')?.raftEndpoint).toBe('[fd00::4]:4243')
  expect(discoveredHint(service, 'other')).toBeNull()
  for (const address of ['8.8.8.8', '0.0.0.0', '224.0.0.1', 'host.local', '192.168.1.4/path', 'fe80::1%en0']) {
    expect(discoveredHint({ ...service, txt: { ...service.txt, address } }, 'workspace')).toBeNull()
  }
  expect(discoveredHint({ ...service, txt: { ...service.txt, raft: '0' } }, 'workspace')).toBeNull()
  expect(discoveredHint({ ...service, port: 65536 }, 'workspace')).toBeNull()
})
