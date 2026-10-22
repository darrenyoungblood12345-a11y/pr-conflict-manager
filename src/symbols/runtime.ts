import { createRequire as createSymbolRequire } from 'node:module'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Language, Parser } from 'web-tree-sitter'
import { LANGUAGE_CONFIGURATIONS } from './languages.js'
import type { SupportedLanguage } from './languages.js'
import type { SymbolOptions } from './types.js'

const symbolRequire = createSymbolRequire(typeof __filename === 'string' ? __filename : import.meta.url)
type Bindings = Pick<typeof import('web-tree-sitter'), 'Parser' | 'Language'>
const runtimeAssets = new Map<string, Promise<{ bytes: Buffer; digest: string }>>()
const initialized: { digest?: string; promise?: Promise<void>; bindings?: Promise<Bindings> } = {}
const languages = new Map<string, Promise<Language>>()

export const symbolAssetPaths = (language: SupportedLanguage, options: SymbolOptions = {}) => {
  const filename = `tree-sitter-${LANGUAGE_CONFIGURATIONS[language].grammar}.wasm`
  return {
    runtime: options.assetDirectory
      ? path.join(options.assetDirectory, 'web-tree-sitter.wasm')
      : symbolRequire.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    binding: options.assetDirectory
      ? path.join(options.assetDirectory, 'web-tree-sitter.mjs')
      : path.join(path.dirname(symbolRequire.resolve('web-tree-sitter')), 'web-tree-sitter.js'),
    grammar: options.assetDirectory
      ? path.join(options.assetDirectory, filename)
      : symbolRequire.resolve(`@cursorless/tree-sitter-wasms/out/${filename}`),
  }
}

export const loadLanguage = async (language: SupportedLanguage, options: SymbolOptions = {}) => {
  const assets = symbolAssetPaths(language, options)
  // Parser's Wasm runtime is process-global. Never reinitialize it while cached
  // language handles exist; copied assets must match the first pinned runtime.
  if (!runtimeAssets.has(assets.runtime)) {
    runtimeAssets.set(assets.runtime, Promise.all([readFile(assets.runtime), readFile(assets.binding)]).then(([bytes, binding]) => ({ bytes, digest: createHash('sha256').update(bytes).update(binding).digest('hex') })))
  }
  const runtime = await runtimeAssets.get(assets.runtime)!
  if (initialized.digest && initialized.digest !== runtime.digest) throw new Error('Parser runtime changed within the process')
  if (!initialized.promise) {
    initialized.digest = runtime.digest
    // Preserve the binding's import.meta.url by loading it as a native ESM file.
    // Compiling that file into Electron's CJS main would erase import.meta.url.
    initialized.bindings = import(pathToFileURL(assets.binding).href) as Promise<Bindings>
    initialized.promise = initialized.bindings.then(bindings => bindings.Parser.init({ locateFile: () => assets.runtime, wasmBinary: runtime.bytes }))
  }
  await initialized.promise
  if (!languages.has(assets.grammar)) {
    languages.set(assets.grammar, Promise.all([readFile(assets.grammar), initialized.bindings!]).then(([bytes, bindings]) => bindings.Language.load(bytes)))
  }
  return languages.get(assets.grammar)!
}

export const createParser = async (language: SupportedLanguage, options: SymbolOptions = {}): Promise<Parser> => {
  const grammar = await loadLanguage(language, options)
  const bindings = await initialized.bindings!
  const parser = new bindings.Parser()
  try {
    parser.setLanguage(grammar)
    return parser
  } catch (error) {
    parser.delete()
    throw error
  }
}
