import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const script = name => readFile(new URL(`../../scripts/${name}`, import.meta.url), 'utf8')

describe('integration bridge and parser artifacts', () => {
  it('are prepared by the same shared step in the development and production builds', async () => {
    const shared = await script('integration-artifacts.mjs')
    expect(shared).toContain("import('./copy-parser-assets.mjs')")
    expect(shared).toContain("outfile: 'dist/integrations/cli.js'")
    for (const name of ['dev.mjs', 'build.mjs']) {
      const source = await script(name)
      expect(source, name).toContain("import { buildIntegrationArtifacts } from './integration-artifacts.mjs'")
      expect(source, name).toMatch(/^await buildIntegrationArtifacts\(\)$/m)
      // A private copy of either step is how the two builds drifted apart.
      expect(source, name).not.toContain('copy-parser-assets')
      expect(source, name).not.toContain('src/integrations/cli.ts')
    }
  })
})
