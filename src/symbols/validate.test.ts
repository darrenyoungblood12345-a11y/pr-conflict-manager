import { mkdtemp, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateDeclaredScopes } from './validate.js'
import { LANGUAGE_FIXTURES } from './fixtures.js'

describe('declared function scopes against a selected local clone', () => {
  const directories: string[] = []
  const repository = async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'symbol-repo-')))
    directories.push(directory)
    return directory
  }
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

  it.each(LANGUAGE_FIXTURES)('validates a unique existing $language function via its exact qualified name', async fixture => {
    const root = await repository()
    await writeFile(path.join(root, fixture.path), fixture.source)
    const symbol = fixture.expected.at(-1)!
    const result = await validateDeclaredScopes(root, [{ path: fixture.path, kind: 'symbol', symbol }])
    expect(result).toMatchObject({ ok: true, qualified: true, fallbacks: [], errors: [] })
    expect(result.scopes).toEqual([{ path: fixture.path.toLowerCase(), kind: 'symbol', symbol }])
  })

  it('retains separate functions in one file and class/nested identities without changing repository files', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'store.ts'), 'class Store { save() { function validate() {} } load() {} }')
    const result = await validateDeclaredScopes(root, [
      { path: 'store.ts', kind: 'symbol', symbol: 'Store.save' },
      { path: 'store.ts', kind: 'symbol', symbol: 'Store.load' },
      { path: 'store.ts', kind: 'symbol', symbol: 'Store.save.validate' },
    ])
    expect(result).toMatchObject({ ok: true, qualified: true, fallbacks: [] })
    expect(result.scopes.map(scope => scope.symbol)).toEqual(['Store.save', 'Store.load', 'Store.save.validate'])
    const symbols = result.files[0].analysis.symbols
    const parent = symbols.find(symbol => symbol.qualifiedName === 'Store')!
    const child = symbols.find(symbol => symbol.qualifiedName === 'Store.save.validate')!
    expect(parent.startByte).toBeLessThan(child.startByte)
    expect(parent.endByte).toBeGreaterThan(child.endByte)
  })

  it('broadens a file atomically when a planned addition, rename, or removed symbol has no current range', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'app.js'), 'function existing() {}')
    const result = await validateDeclaredScopes(root, [
      { path: 'app.js', kind: 'symbol', symbol: 'existing' },
      { path: 'app.js', kind: 'symbol', symbol: 'plannedNewFunction' },
    ])
    expect(result).toMatchObject({ ok: true, qualified: false, scopes: [{ path: 'app.js', kind: 'file' }] })
    expect(result.fallbacks[0].reason).toContain('additions, renames')
    const newFile = await validateDeclaredScopes(root, [{ path: 'new-file.ts', kind: 'symbol', symbol: 'newFunction' }])
    expect(newFile).toMatchObject({ ok: true, qualified: false, scopes: [{ path: 'new-file.ts', kind: 'file' }] })
  })

  it('broadens overloaded or duplicate qualified names instead of selecting one declaration', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'overload.ts'), 'function run(value: string): string;\nfunction run(value: number): number;\nfunction run(value: any) { return value }')
    const result = await validateDeclaredScopes(root, [{ path: 'overload.ts', kind: 'symbol', symbol: 'run' }])
    expect(result).toMatchObject({ ok: true, qualified: false, scopes: [{ path: 'overload.ts', kind: 'file' }] })
    expect(result.fallbacks[0].reason).toContain('ambiguous')
  })

  it('broadens unsupported files and parser errors to explicit whole-file reservations', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'data.txt'), 'function fake() {}')
    await writeFile(path.join(root, 'broken.js'), 'function broken( {')
    const result = await validateDeclaredScopes(root, [
      { path: 'data.txt', kind: 'symbol', symbol: 'fake' },
      { path: 'broken.js', kind: 'symbol', symbol: 'broken' },
    ])
    expect(result).toMatchObject({ ok: true, qualified: false })
    expect(result.scopes).toEqual([{ path: 'data.txt', kind: 'file' }, { path: 'broken.js', kind: 'file' }])
    expect(result.fallbacks).toHaveLength(2)
  })

  it('retains an explicit whole-file reservation rather than narrowing it through parser output', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'app.js'), 'function run() {}')
    expect(await validateDeclaredScopes(root, [
      { path: 'app.js', kind: 'file' }, { path: 'app.js', kind: 'symbol', symbol: 'run' },
    ])).toMatchObject({ ok: true, scopes: [{ path: 'app.js', kind: 'file' }] })
  })

  it('rejects traversal/absolute paths and symlink aliases without returning partial accepted scopes', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'app.js'), 'function run() {}')
    await symlink(path.join(root, 'app.js'), path.join(root, 'alias.js'))
    expect(await validateDeclaredScopes(root, [{ path: '../outside.js', kind: 'symbol', symbol: 'run' }])).toMatchObject({ ok: false, scopes: [] })
    expect(await validateDeclaredScopes(root, [{ path: path.join(root, 'app.js'), kind: 'file' }])).toMatchObject({ ok: false, scopes: [] })
    expect(await validateDeclaredScopes(root, [{ path: 'app.js', kind: 'symbol', symbol: 'run' }, { path: 'alias.js', kind: 'symbol', symbol: 'run' }])).toMatchObject({ ok: false, scopes: [] })
  })

  it('rejects symlinked parent directories and directory scopes', async () => {
    const root = await repository()
    const outside = await repository()
    await writeFile(path.join(outside, 'outside.js'), 'function secret() {}')
    await symlink(outside, path.join(root, 'linked'))
    await mkdir(path.join(root, 'folder'))
    expect(await validateDeclaredScopes(root, [{ path: 'linked/outside.js', kind: 'symbol', symbol: 'secret' }])).toMatchObject({ ok: false, scopes: [] })
    expect(await validateDeclaredScopes(root, [{ path: 'folder', kind: 'file' }])).toMatchObject({ ok: false, scopes: [] })
  })

  it('falls back for invalid source bytes without inventing UTF-8 symbol ranges', async () => {
    const root = await repository()
    await writeFile(path.join(root, 'invalid.js'), Buffer.from([0xff, 0x61]))
    expect(await validateDeclaredScopes(root, [{ path: 'invalid.js', kind: 'symbol', symbol: 'run' }])).toMatchObject({ ok: true, qualified: false, scopes: [{ path: 'invalid.js', kind: 'file' }] })
  })
})
