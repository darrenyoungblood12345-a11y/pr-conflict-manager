import type { Scope } from '../shared/contracts.js'

export interface CodeSymbol {
  kind: 'function' | 'container'
  name: string
  qualifiedName: string
  // Byte ranges are UTF-8, with an inclusive start and exclusive end.
  startByte: number
  endByte: number
  // Line numbers are one-based and inclusive.
  startLine: number
  endLine: number
}

export interface SymbolEditDecision {
  allow: boolean
  reason: string
  symbol?: string
}

export interface SymbolAnalysis {
  language: string | null
  qualified: boolean
  symbols: CodeSymbol[]
  reason?: string
}

export interface SymbolOptions {
  // Production uses copied, bundled assets. Development resolves the pinned
  // npm assets; neither path loads grammars from the inspected repository.
  assetDirectory?: string
}

export interface ScopeFallback {
  path: string
  symbol?: string
  reason: string
}

export interface ScopeValidationResult {
  ok: boolean
  qualified: boolean
  scopes: Scope[]
  files: Array<{ path: string; analysis: SymbolAnalysis }>
  fallbacks: ScopeFallback[]
  errors: Array<{ path: string; reason: string }>
}
