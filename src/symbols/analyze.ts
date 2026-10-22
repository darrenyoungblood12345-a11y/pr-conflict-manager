import { languageForPath } from './languages.js'
import { createParser } from './runtime.js'
import { extractSymbols } from './extract.js'
import type { SymbolAnalysis, SymbolOptions } from './types.js'

export const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024

export const analyzeFile = async (filePath: string, source: string, options: SymbolOptions = {}): Promise<SymbolAnalysis> => {
  const language = languageForPath(filePath)
  const fallback = (reason: string): SymbolAnalysis => ({ language, qualified: false, symbols: [], reason })
  if (!language) return fallback('Unsupported or ambiguous language; use a whole-file reservation')
  if (source.includes('\0') || /[\uD800-\uDFFF]/u.test(source)) return fallback('Source is not qualified UTF-8 text')
  if (Buffer.byteLength(source, 'utf8') > MAX_ANALYSIS_BYTES) return fallback('Source exceeds the 2 MiB qualified analysis limit')
  try {
    const parser = await createParser(language, options)
    try {
      const started = performance.now()
      const tree = parser.parse(source, null, { progressCallback: () => performance.now() - started > 500 })
      if (!tree) return fallback('Parser timed out or returned no complete syntax tree')
      try {
        if (tree.rootNode.hasError) return fallback('Syntax errors or missing syntax require a whole-file reservation')
        const result = extractSymbols(tree.rootNode, source, language)
        if (result.reason) return fallback(result.reason)
        return { language, qualified: true, symbols: result.symbols }
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  } catch {
    return fallback('Pinned parser runtime or grammar is unavailable/incompatible; use a whole-file reservation')
  }
}
