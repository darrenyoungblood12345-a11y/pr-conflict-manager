import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptContext, loadContext, observeContext } from './context-store.js'
import { receiptContext, signedReceipt } from './receipt-fixtures.test-support.js'
import { sampleSnapshot, sampleTask } from './fixtures.test-support.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'receipt-context-')))
  directories.push(root)
  const file = path.join(root, 'private-context.json')
  const context = receiptContext(root)
  await writeFile(file, JSON.stringify(context), { mode: 0o600 })
  return { file, context }
}

describe('durable receipt acceptance and revocation', () => {
  it('stores a verified receipt privately and permanently removes it after a cached stop', async () => {
    const { file, context } = await fixture()
    await acceptContext(file, context, sampleTask(), signedReceipt())
    expect((await loadContext(file)).acceptedOfflineReceipt).toBeDefined()
    await observeContext(file, context, sampleSnapshot(sampleTask({ stopAcknowledged: true }), { hasAuthority: false }))
    expect(await loadContext(file)).toMatchObject({ offlineRevokedThrough: { 'task-a': 1 } })
    expect((await loadContext(file)).acceptedOfflineReceipt).toBeUndefined()
    await expect(acceptContext(file, context, sampleTask(), signedReceipt())).rejects.toThrow('superseded')
  })

  it('serializes competing accept and stop writes so a delayed receipt cannot resurrect the revision', async () => {
    const { file, context } = await fixture()
    const results = await Promise.allSettled([
      acceptContext(file, context, sampleTask(), signedReceipt()),
      observeContext(file, context, sampleSnapshot(sampleTask({ status: 'blocked' }))),
    ])
    expect(results[1].status).toBe('fulfilled')
    const latest = await loadContext(file)
    expect(latest.offlineRevokedThrough?.['task-a']).toBe(1)
    expect(latest.acceptedOfflineReceipt).toBeUndefined()
    await expect(acceptContext(file, context, sampleTask(), signedReceipt())).rejects.toThrow()
    const revised = sampleTask({ revision: 2 })
    expect((await acceptContext(file, context, revised, signedReceipt(revised))).revision).toBe(2)
  })

  it('refuses changed repository setup and leaves the prior file intact', async () => {
    const { file, context } = await fixture()
    await writeFile(file, JSON.stringify({ ...context, repositoryRoot: '/different' }))
    await expect(acceptContext(file, context, sampleTask(), signedReceipt())).rejects.toThrow('setup changed')
    expect(JSON.parse(await readFile(file, 'utf8')).repositoryRoot).toBe('/different')
  })
})
