import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const native = spawnSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' })
if (native.status !== 0) process.exit(native.status ?? 1)
await import('./copy-parser-assets.mjs')

await build({
  entryPoints: ['src/electron/main.ts', 'src/electron/preload.ts'],
  outdir: 'dist/electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], sourcemap: true,
  // Electron's CJS entry provides __filename; the ESM fallback is unreachable.
  define: { 'import.meta.url': 'undefined' },
})
await build({
  entryPoints: ['src/integrations/cli.ts'], outfile: 'dist/integrations/cli.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);' },
  sourcemap: true,
})
await writeFile('dist/integrations/package.json', '{"type":"module"}\n')
await buildRenderer()
