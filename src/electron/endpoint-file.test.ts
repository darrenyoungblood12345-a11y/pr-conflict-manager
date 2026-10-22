import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeOwnedEndpointFile, removeStaleEndpointFile, writeEndpointFile } from './endpoint-file.js'

const directories: string[] = []
const endpoint = { url: 'http://127.0.0.1:4567', token: 'local-private-token' }

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const endpointPath = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-pr-endpoint-'))
  directories.push(directory)
  return path.join(directory, 'app-user-data', 'integration-endpoint.json')
}

describe('private integration endpoint handoff', () => {
  it('atomically writes credentials with private file and app-directory permissions', async () => {
    const file = await endpointPath()
    await writeEndpointFile(file, endpoint)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(endpoint)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
  })

  it('preserves a newer process credential when an older owner tries to clean up', async () => {
    const file = await endpointPath()
    await writeEndpointFile(file, endpoint)
    const replacement = { ...endpoint, token: 'replacement-private-token' }
    await writeEndpointFile(file, replacement)
    await removeOwnedEndpointFile(file, endpoint)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(replacement)
    await removeOwnedEndpointFile(file, replacement)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a stale handoff at startup and tolerates an absent handoff', async () => {
    const file = await endpointPath()
    await writeEndpointFile(file, endpoint)
    await removeStaleEndpointFile(file)
    await removeStaleEndpointFile(file)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
