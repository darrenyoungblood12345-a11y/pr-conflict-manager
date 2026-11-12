import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import { spawnSync } from 'node:child_process'
import { buildIntegrationArtifacts } from './integration-artifacts.mjs'

const native = spawnSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' })
if (native.status !== 0) process.exit(native.status ?? 1)
await buildIntegrationArtifacts()

await build({
  entryPoints: ['src/electron/main.ts', 'src/electron/preload.ts'],
  outdir: 'dist/electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], sourcemap: true,
  // Electron's CJS entry provides __filename; the ESM fallback is unreachable.
  define: { 'import.meta.url': 'undefined' },
})
await buildRenderer()
