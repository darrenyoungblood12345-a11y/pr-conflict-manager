import { build } from 'esbuild'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { symbolAssetPaths } from './runtime.js'

describe('Node and Electron-style parser packaging', () => {
  it('loads a copied runtime/grammar through bundled ESM and CommonJS without resolving development assets', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'symbol-bundle-'))
    try {
      const assetDirectory = path.join(directory, 'parser-assets')
      await mkdir(assetDirectory)
      const assets = symbolAssetPaths('javascript')
      await copyFile(assets.runtime, path.join(assetDirectory, 'web-tree-sitter.wasm'))
      await copyFile(assets.binding, path.join(assetDirectory, 'web-tree-sitter.mjs'))
      await copyFile(assets.grammar, path.join(assetDirectory, 'tree-sitter-javascript.wasm'))
      for (const format of ['esm', 'cjs'] as const) {
        const bundle = path.join(directory, format === 'esm' ? 'symbols.mjs' : 'symbols.cjs')
        await build({
          entryPoints: ['src/symbols/index.ts'], outfile: bundle, bundle: true, platform: 'node', format, target: 'node22', logLevel: 'silent',
          ...(format === 'esm' ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
        })
        const script = path.join(directory, `probe-${format}.mjs`)
        await writeFile(script, `import * as symbols from ${JSON.stringify(pathToFileURL(bundle).href)}\nconst options = {assetDirectory: ${JSON.stringify(assetDirectory)}}\nconst good = await symbols.analyzeFile('app.js', 'function save() { return true }', options)\nconst missing = await symbols.analyzeFile('app.ts', 'function save() {}', options)\nconsole.log(JSON.stringify({good, missing}))\n`)
        const processResult = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', timeout: 10000 })
        expect(processResult.status, processResult.stderr).toBe(0)
        const result = JSON.parse(processResult.stdout)
        expect(result.good, `${format}: ${JSON.stringify(result)}`).toMatchObject({ qualified: true, symbols: [{ qualifiedName: 'save' }] })
        expect(result.missing).toMatchObject({ qualified: false, symbols: [] })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
