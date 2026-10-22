import type { Scope } from '../shared/contracts.js'
import { canonicalScopePath } from '../integrations/path-identity.js'
import { scopeSchema } from '../integrations/schemas.js'
import { analyzeFile } from './analyze.js'
import type { CodeSymbol, SymbolEditDecision, SymbolOptions } from './types.js'

const refusal = (reason: string): SymbolEditDecision => ({ allow: false, reason })
const covers = (scope: string, symbol: string) => scope === symbol || ['.', '::', '#', '/'].some(separator => symbol.startsWith(scope + separator))

const changedBytes = (before: string, after: string) => {
  const interval = { start: 0, beforeEnd: before.length, afterEnd: after.length }
  while (interval.start < before.length && interval.start < after.length && before[interval.start] === after[interval.start]) interval.start += 1
  while (interval.beforeEnd > interval.start && interval.afterEnd > interval.start && before[interval.beforeEnd - 1] === after[interval.afterEnd - 1]) {
    interval.beforeEnd -= 1
    interval.afterEnd -= 1
  }
  // Keep changes to surrogate pairs on complete code-point boundaries before
  // converting JavaScript indices to the UTF-8 ranges returned by analysis.
  if (interval.start > 0 && /[\uDC00-\uDFFF]/.test(before[interval.start] ?? after[interval.start] ?? '')) interval.start -= 1
  if (/[\uDC00-\uDFFF]/.test(before[interval.beforeEnd] ?? '')) interval.beforeEnd += 1
  if (/[\uDC00-\uDFFF]/.test(after[interval.afterEnd] ?? '')) interval.afterEnd += 1
  return {
    start: Buffer.byteLength(before.slice(0, interval.start), 'utf8'),
    beforeEnd: Buffer.byteLength(before.slice(0, interval.beforeEnd), 'utf8'),
    afterEnd: Buffer.byteLength(after.slice(0, interval.afterEnd), 'utf8'),
  }
}

const strictlyInside = (symbol: CodeSymbol, start: number, end: number) => start > symbol.startByte && end < symbol.endByte
const functionNames = (symbols: CodeSymbol[]) => symbols.filter(symbol => symbol.kind === 'function').map(symbol => symbol.qualifiedName).sort()

export const validateSymbolEdit = async (
  filePath: string,
  before: string,
  after: string,
  scopes: readonly Scope[],
  options: SymbolOptions = {},
): Promise<SymbolEditDecision> => {
  const file = scopeSchema.safeParse({ path: filePath, kind: 'file' })
  if (!file.success) return refusal('Edit path is not an unambiguous repository-relative file')
  try {
    const identity = canonicalScopePath(filePath)
    const valid = scopes.map(scope => scopeSchema.safeParse(scope))
    if (valid.some(scope => !scope.success)) return refusal('Reservation contains invalid scope data')
    const matching = valid.flatMap(scope => scope.success && canonicalScopePath(scope.data.path) === identity ? [scope.data] : [])
    if (matching.some(scope => scope.kind === 'file')) return { allow: true, reason: 'The current reservation covers this whole file' }
    const reserved = matching.filter(scope => scope.kind === 'symbol').map(scope => scope.symbol!)
    if (reserved.length === 0) return refusal('No reservation covers this file')
    const original = await analyzeFile(filePath, before, options)
    const proposed = await analyzeFile(filePath, after, options)
    if (!original.qualified || !proposed.qualified) return refusal('Both original and proposed text must parse reliably; reserve the whole file')
    if (before === after) return { allow: true, reason: 'The proposed text makes no changes' }
    if (JSON.stringify(functionNames(original.symbols)) !== JSON.stringify(functionNames(proposed.symbols))) {
      return refusal('Adding, removing, or renaming named functions requires a whole-file reservation')
    }
    const changed = changedBytes(before, after)
    const candidates = original.symbols.filter(symbol => symbol.kind === 'function'
      && reserved.some(scope => covers(scope, symbol.qualifiedName))
      && strictlyInside(symbol, changed.start, changed.beforeEnd))
    const admitted = candidates.find(symbol => {
      const oldMatches = original.symbols.filter(item => item.qualifiedName === symbol.qualifiedName)
      const newMatches = proposed.symbols.filter(item => item.qualifiedName === symbol.qualifiedName)
      return oldMatches.length === 1 && newMatches.length === 1 && newMatches[0].kind === 'function'
        && strictlyInside(newMatches[0], changed.start, changed.afterEnd)
    })
    return admitted
      ? { allow: true, symbol: admitted.qualifiedName, reason: 'All changed bytes remain strictly inside the same uniquely identified reserved function before and after parsing' }
      : refusal('The changed interval crosses a function boundary, lies outside its reservation, or has an ambiguous identity; reserve the whole file')
  } catch {
    return refusal('Path identity or parser validation is unavailable; no symbol edit was authorized')
  }
}
