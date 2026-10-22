import { expect, it } from 'vitest'
import { createInvitationReview } from './invitation-review.js'
import type { LanPublic } from '../shared/lan.js'

const peer: LanPublic = { workspaceId: 'workspace', deviceId: 'peer', caCertPEM: 'public', fingerprint: 'a'.repeat(64), controlUrl: 'https://127.0.0.1:12345', raftEndpoint: '127.0.0.1:12346' }

it('cannot authorize a changed or edited-back invitation using an earlier asynchronous review', async () => {
  const gate = createInvitationReview()
  let complete: (value: LanPublic) => void = () => undefined
  gate.replace('invitation one')
  const pending = gate.inspect(() => new Promise(resolve => { complete = resolve }))
  gate.replace('invitation two')
  gate.replace('invitation one')
  complete(peer)
  expect(await pending).toBeNull()
  const reviewed = await gate.inspect(async () => peer)
  expect(gate.matches(reviewed)).toBe(true)
  gate.replace('invitation three')
  expect(gate.matches(reviewed)).toBe(false)
})
