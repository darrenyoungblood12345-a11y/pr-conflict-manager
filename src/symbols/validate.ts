import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Scope } from '../shared/contracts.js'
import { canonicalScopePath } from '../integrations/path-identity.js'
import { scopeSchema } from '../integrations/schemas.js'
import { analyzeFile, MAX_ANALYSIS_BYTES } from './analyze.js'
import { languageForPath } from './languages.js'
import type { ScopeValidationResult, SymbolAnalysis, SymbolOptions } from './types.js'

interface FileGroup {
  path: string
  requestedPath: string
  scopes: Scope[]
}

const fallbackAnalysis = (file: string, reason: string): SymbolAnalysis => ({
  language: languageForPath(file), qualified: false, symbols: [], reason,
})

const inspectFile = async (root: string, file: FileGroup, options: SymbolOptions): Promise<{ analysis: SymbolAnalysis; error?: string }> => {
  const absolute = path.join(root, file.requestedPath)
  const pieces = file.requestedPath.split('/')
  try {
    await pieces.reduce(async (previous, piece) => {
      const current = path.join(await previous, piece)
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error('symbol-symlink')
      return current
    }, Promise.resolve(root))
    const canonical = await realpath(absolute)
    const relative = path.relative(root, canonical)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('symbol-symlink')
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile()) return { analysis: fallbackAnalysis(file.path, 'Scope must identify a regular file'), error: 'Scope must identify a regular file' }
      if (!languageForPath(file.path)) return { analysis: fallbackAnalysis(file.path, 'Unsupported or ambiguous language; use a whole-file reservation') }
      if (before.size > MAX_ANALYSIS_BYTES) return { analysis: fallbackAnalysis(file.path, 'Source exceeds the 2 MiB qualified analysis limit') }
      const buffer = Buffer.alloc(before.size + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        return { analysis: fallbackAnalysis(file.path, 'File changed during inspection; use a whole-file reservation and inspect again') }
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
      return { analysis: await analyzeFile(file.path, source, options) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { analysis: fallbackAnalysis(file.path, 'File does not exist; planned additions require a whole-file reservation') }
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP' || (error instanceof Error && error.message === 'symbol-symlink')) {
      return { analysis: fallbackAnalysis(file.path, 'Symlink scope paths are not qualified'), error: 'Symlink scope paths are not qualified' }
    }
    return { analysis: fallbackAnalysis(file.path, 'File is unreadable or not valid UTF-8; use a whole-file reservation') }
  }
}

export const validateDeclaredScopes = async (
  repositoryRoot: string,
  scopes: readonly Scope[],
  options: SymbolOptions = {},
): Promise<ScopeValidationResult> => {
  const result: ScopeValidationResult = { ok: true, qualified: true, scopes: [], files: [], fallbacks: [], errors: [] }
  if (!path.isAbsolute(repositoryRoot) || scopes.length === 0 || scopes.length > 256) {
    return { ...result, ok: false, qualified: false, errors: [{ path: '', reason: 'Select an absolute repository root and declare 1–256 valid file/symbol scopes' }] }
  }
  const root = await realpath(repositoryRoot).catch(() => undefined)
  const rootStat = root ? await lstat(root).catch(() => undefined) : undefined
  if (!root || !rootStat?.isDirectory()) {
    return { ...result, ok: false, qualified: false, errors: [{ path: '', reason: 'Selected repository root is unavailable' }] }
  }
  const groups = new Map<string, FileGroup>()
  scopes.forEach(scope => {
    const parsed = scopeSchema.safeParse(scope)
    if (!parsed.success) {
      result.errors.push({ path: scope.path, reason: 'Invalid or ambiguous repository-relative scope' })
      return
    }
    try {
      const normalized = canonicalScopePath(parsed.data.path)
      const group = groups.get(normalized) ?? { path: normalized, requestedPath: parsed.data.path, scopes: [] }
      group.scopes.push({ ...parsed.data, path: normalized })
      groups.set(normalized, group)
    } catch {
      result.errors.push({ path: scope.path, reason: 'Path identity is outside the qualified coordinator Unicode mapping' })
    }
  })
  if (result.errors.length > 0) return { ...result, ok: false, qualified: false }
  // Bound memory use: read/parse one selected file at a time. Trees and source
  // buffers are released before the next file; source contents are not returned.
  await [...groups.values()].reduce(async (previous, file) => {
    await previous
    const { analysis, error } = await inspectFile(root, file, options)
    result.files.push({ path: file.path, analysis })
    if (error) {
      result.errors.push({ path: file.path, reason: error })
      return
    }
    if (file.scopes.some(scope => scope.kind === 'file')) {
      result.scopes.push({ path: file.path, kind: 'file' })
      return
    }
    const uncertain = file.scopes.flatMap(scope => {
      if (!analysis.qualified) return [{ path: file.path, symbol: scope.symbol, reason: analysis.reason ?? 'Symbol analysis is unavailable' }]
      const matches = analysis.symbols.filter(symbol => symbol.qualifiedName === scope.symbol)
      if (matches.length !== 1) return [{
        path: file.path, symbol: scope.symbol,
        reason: matches.length === 0
          ? 'Symbol is absent; additions, renames, or unknown names require a whole-file reservation'
          : 'Symbol identity is ambiguous or overloaded; use a whole-file reservation',
      }]
      return []
    })
    if (uncertain.length > 0) {
      result.scopes.push({ path: file.path, kind: 'file' })
      result.fallbacks.push(...uncertain)
      result.qualified = false
      return
    }
    const unique = new Map(file.scopes.map(scope => [scope.symbol, scope]))
    result.scopes.push(...unique.values())
  }, Promise.resolve())
  if (result.errors.length > 0) return { ...result, ok: false, qualified: false, scopes: [] }
  return result
}
