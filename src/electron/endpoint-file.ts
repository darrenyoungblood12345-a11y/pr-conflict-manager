import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EndpointConfig } from '../shared/contracts.js'

/** This must be an app-specific user-data directory, never the user's home/root. */
const secureAppDirectory = async (directory: string) => {
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root || resolved === homedir()) {
    throw new Error('Integration handoff requires an app-specific directory.')
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 })
  const metadata = await lstat(resolved)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The integration directory must be a local app directory.')
  }
  await chmod(resolved, 0o700)
}

export const writeEndpointFile = async (file: string, endpoint: EndpointConfig) => {
  await secureAppDirectory(path.dirname(file))
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(endpoint)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export const removeStaleEndpointFile = async (file: string) => {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

/** An older instance must not remove a handoff replaced with a different token. */
export const removeOwnedEndpointFile = async (file: string, endpoint: EndpointConfig) => {
  try {
    const current: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof current !== 'object' || current === null) return
    const value = current as Partial<EndpointConfig>
    if (value.token === endpoint.token && value.url === endpoint.url) await unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
