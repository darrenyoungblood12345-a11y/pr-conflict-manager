import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

/**
 * The agent bridge and parser grammars the running app looks for under dist/.
 * Development and production builds share this step so neither can omit them.
 */
export const buildIntegrationArtifacts = async () => {
  await import('./copy-parser-assets.mjs')
  await build({
    entryPoints: ['src/integrations/cli.ts'], outfile: 'dist/integrations/cli.js',
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);' },
    sourcemap: true,
  })
  await writeFile('dist/integrations/package.json', '{"type":"module"}\n')
}
