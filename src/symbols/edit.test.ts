import { describe, expect, it } from 'vitest'
import { validateSymbolEdit } from './edit.js'
import { LANGUAGE_FIXTURES } from './fixtures.js'

const edits: Record<string, { from: string; to: string; scope: string }> = {
  javascript: { from: 'true', to: 'false', scope: 'Store.save' },
  typescript: { from: 'true', to: 'false', scope: 'Store.save' },
  tsx: { from: 'Ready', to: 'Done', scope: 'App.render' },
  python: { from: 'True', to: 'False', scope: 'Store.save' },
  go: { from: 'true', to: 'false', scope: 'Store.Save' },
  rust: { from: 'true', to: 'false', scope: 'Store.save' },
  java: { from: 'true', to: 'false', scope: 'Store.save' },
  c: { from: 'return 1', to: 'return 3', scope: 'save' },
  cpp: { from: 'return 1', to: 'return 3', scope: 'app.Store.save' },
  c_sharp: { from: 'true', to: 'false', scope: 'App.Store.Save' },
  ruby: { from: 'true', to: 'false', scope: 'App.Store.save' },
  php: { from: 'true', to: 'false', scope: 'Store.save' },
  swift: { from: 'true', to: 'false', scope: 'Store.save' },
  kotlin: { from: 'true', to: 'false', scope: 'Store.save' },
}

describe('proven symbol edit boundaries', () => {
  it.each(LANGUAGE_FIXTURES)('admits an interior $language change under the existing reserved function', async fixture => {
    const edit = edits[fixture.language]
    const decision = await validateSymbolEdit(fixture.path, fixture.source, fixture.source.replace(edit.from, edit.to), [{ path: fixture.path, kind: 'symbol', symbol: edit.scope }])
    expect(decision, decision.reason).toMatchObject({ allow: true })
  })

  const file = 'app.js'
  const before = 'function save() { return true }\nfunction load() { return true }\n'
  const scope = [{ path: file, kind: 'symbol' as const, symbol: 'save' }]

  it('refuses changes to an unreserved sibling function', async () => {
    expect(await validateSymbolEdit(file, before, before.replace('load() { return true', 'load() { return false'), scope)).toMatchObject({ allow: false })
  })

  it('refuses a combined edit spanning sibling function boundaries even when both are reserved', async () => {
    expect(await validateSymbolEdit(file, before, before.replaceAll('true', 'false'), [...scope, { path: file, kind: 'symbol', symbol: 'load' }])).toMatchObject({ allow: false })
  })

  it('refuses unnamed top-level changes and function replacement/rename/addition/deletion', async () => {
    for (const after of [
      'const shared = true\n' + before,
      before.replace('save', 'renamed'),
      before + 'function another() {}\n',
      before.replace('function save() { return true }\n', ''),
      before.replace('return true', 'function nested() {} return true'),
    ]) expect(await validateSymbolEdit(file, before, after, scope)).toMatchObject({ allow: false })
  })

  it('refuses malformed resulting syntax and ambiguous function identities', async () => {
    expect(await validateSymbolEdit(file, before, before.replace('return true', 'return !!!'), scope)).toMatchObject({ allow: false })
    const duplicate = 'function save() { return 1 }\nfunction save() { return 2 }'
    expect(await validateSymbolEdit(file, duplicate, duplicate.replace('return 1', 'return 3'), scope)).toMatchObject({ allow: false })
  })

  it('requires file scope for new/unsupported files and preserves explicit whole-file authority', async () => {
    expect(await validateSymbolEdit(file, '', 'function save() {}', scope)).toMatchObject({ allow: false })
    expect(await validateSymbolEdit('data.txt', 'before', 'after', [{ path: 'data.txt', kind: 'symbol', symbol: 'run' }])).toMatchObject({ allow: false })
    expect(await validateSymbolEdit('data.txt', 'before', 'after', [{ path: 'data.txt', kind: 'file' }])).toMatchObject({ allow: true })
  })

  it('keeps emoji changes on complete UTF-8 boundaries', async () => {
    const original = '// café 😀\nfunction save() { return "😀" }\n'
    expect(await validateSymbolEdit(file, original, original.replace('return "😀"', 'return "😁"'), scope)).toMatchObject({ allow: true })
    expect(await validateSymbolEdit(file, original, original.replace('// café 😀', '// café 😁'), scope)).toMatchObject({ allow: false })
  })

  it('permits an existing method under a parent class claim but refuses edits to the class header', async () => {
    const source = 'class Store { save() { return true } }'
    const reserved = [{ path: file, kind: 'symbol' as const, symbol: 'Store' }]
    expect(await validateSymbolEdit(file, source, source.replace('true', 'false'), reserved)).toMatchObject({ allow: true })
    expect(await validateSymbolEdit(file, source, source.replace('class Store', 'class Store extends Other'), reserved)).toMatchObject({ allow: false })
  })
})
