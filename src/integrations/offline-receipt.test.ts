import { describe, expect, it } from 'vitest'
import { receiptInvalidatedBy, verifyOfflineReceipt } from './offline-receipt.js'
import { receiptContext, signedReceipt, TEST_CA_CERT } from './receipt-fixtures.test-support.js'
import { sampleSnapshot, sampleTask } from './fixtures.test-support.js'

const context = receiptContext('/repository')

describe('signed accepted-scope offline receipts', () => {
  it('verifies the exact Ed25519 bytes, device certificate, authority and bound active task', () => {
    expect(verifyOfflineReceipt(context, signedReceipt())).toMatchObject({ workspaceId: 'workspace-a', task: { id: 'task-a' }, repository: { owner: 'acme', repo: 'project' } })
  })

  it('refuses tampering, noncanonical encodings, another certificate and unknown payload fields', () => {
    const receipt = signedReceipt()
    expect(() => verifyOfflineReceipt(context, { ...receipt, payload: Buffer.from('{}').toString('base64url') })).toThrow()
    expect(() => verifyOfflineReceipt(context, { ...receipt, payload: receipt.payload + '=' })).toThrow()
    expect(() => verifyOfflineReceipt(context, { ...receipt, certPEM: TEST_CA_CERT })).toThrow()
    expect(() => verifyOfflineReceipt(context, signedReceipt(sampleTask(), { unknown: true }))).toThrow()
    expect(() => verifyOfflineReceipt(context, { ...receipt, certPEM: receipt.certPEM + receipt.certPEM })).toThrow()
  })

  it.each([
    { ownerId: 'other' }, { sessionId: 'other' }, { taskId: 'other' }, { revision: 2 },
    { offlineRevokedThrough: { 'task-a': 1 } },
    { offlineAuthority: { ...context.offlineAuthority!, workspaceId: 'other-workspace' } },
    { offlineAuthority: { ...context.offlineAuthority!, deviceId: 'other-mac' } },
    { offlineAuthority: { ...context.offlineAuthority!, repository: { owner: 'other', repo: 'project' } } },
  ])('refuses an unrelated or locally revoked context %j', override => {
    expect(() => verifyOfflineReceipt({ ...context, ...override }, signedReceipt())).toThrow()
  })

  it.each([{ status: 'blocked' as const }, { status: 'cancelled' as const }, { stopAcknowledged: true }, { conflicts: ['other'] }])('refuses a signed but inactive task %j', override => {
    expect(() => verifyOfflineReceipt(context, signedReceipt(sampleTask(override)))).toThrow()
  })

  it('checks task scope and certificate validity without treating merge observation as a stop', () => {
    expect(() => verifyOfflineReceipt(context, signedReceipt(), sampleTask({ scopes: [{ kind: 'file', path: 'another.ts' }] }))).toThrow()
    expect(() => verifyOfflineReceipt(context, signedReceipt(), undefined, Date.parse('2200-01-01'))).toThrow()
    expect(() => verifyOfflineReceipt(context, signedReceipt(), undefined, Date.parse('2020-01-01'))).toThrow()
    expect(verifyOfflineReceipt(context, signedReceipt(sampleTask({ prMerged: true })))).toBeDefined()
  })

  it('invalidates on current or newer stops, scope changes and missing committed state, but not older history', () => {
    const receipt = verifyOfflineReceipt(context, signedReceipt())
    expect(receiptInvalidatedBy(receipt, sampleSnapshot(sampleTask({ status: 'blocked' })))).toBe(true)
    expect(receiptInvalidatedBy(receipt, sampleSnapshot(sampleTask({ revision: 2 })))).toBe(true)
    expect(receiptInvalidatedBy(receipt, sampleSnapshot(sampleTask({ scopes: [{ kind: 'file', path: 'other.ts' }] })))).toBe(true)
    expect(receiptInvalidatedBy(receipt, { ...sampleSnapshot(), tasks: {} })).toBe(true)
    expect(receiptInvalidatedBy(receipt, sampleSnapshot(sampleTask({ revision: 0, status: 'blocked' })))).toBe(false)
    expect(receiptInvalidatedBy(receipt, sampleSnapshot(sampleTask({ prMerged: true })))).toBe(false)
  })
})
