import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { canonicalScopePath } from './path-identity.js'

export const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export const checkedSourcePath = async (root: string, cwd: string, filePath: string, allowDirectory = false) => {
  if (filePath.includes('\0') || filePath.includes('\\')) throw new Error('Ambiguous path')
  if (filePath.split('/').some(part => part === '..' || part === '.')) throw new Error('Traversing path')
  const absolute = path.resolve(cwd, filePath)
  if (absolute === root && allowDirectory) return { absolute, canonical: '' }
  if (!isWithin(root, absolute)) throw new Error('Path is outside the selected repository')
  const relative = path.relative(root, absolute)
  const segments = relative.split(path.sep)
  await segments.reduce(async (previous, segment) => {
    const current = path.join(await previous, segment)
    const stat = await lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('Symlink paths are not qualified')
    if (current === absolute && stat && !stat.isFile() && !(allowDirectory && stat.isDirectory())) throw new Error('Source targets must be regular files or permitted directories')
    return current
  }, Promise.resolve(root))
  if (segments.some(part => ['.git', '.codex', '.claude', '.cursor', '.opencode'].includes(part.toLowerCase()))) throw new Error('Agent and Git control files are outside the source tool policy')
  return { absolute, canonical: canonicalScopePath(segments.join('/')) }
}
