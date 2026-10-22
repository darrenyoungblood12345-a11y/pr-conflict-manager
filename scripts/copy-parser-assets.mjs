import { createRequire } from 'node:module'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const directory = resolve('dist/parser-assets')
const grammarRoot = dirname(require.resolve('@cursorless/tree-sitter-wasms/package.json'))
const languages = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'c_sharp', 'ruby', 'php', 'swift', 'kotlin']
await mkdir(directory, { recursive: true })
await cp(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), join(directory, 'web-tree-sitter.wasm'))
await cp(join(dirname(require.resolve('web-tree-sitter/web-tree-sitter.wasm')), 'web-tree-sitter.js'), join(directory, 'web-tree-sitter.mjs'))
await Promise.all(languages.map(language => cp(
  join(grammarRoot, 'out', `tree-sitter-${language}.wasm`),
  join(directory, `tree-sitter-${language}.wasm`),
)))
