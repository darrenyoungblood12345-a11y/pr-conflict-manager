import { describe, expect, it } from 'vitest'
import { analyzeFile, MAX_ANALYSIS_BYTES } from './analyze.js'
import { LANGUAGE_FIXTURES } from './fixtures.js'

describe('pinned Tree-sitter symbol adapters', () => {
  it.each(LANGUAGE_FIXTURES)('qualifies $language grammar using named AST definitions', async fixture => {
    const result = await analyzeFile(fixture.path, fixture.source)
    expect(result, result.reason).toMatchObject({ language: fixture.language, qualified: true })
    expect(result.symbols.map(symbol => symbol.qualifiedName)).toEqual(fixture.expected)
    const bytes = Buffer.from(fixture.source, 'utf8')
    result.symbols.forEach(symbol => {
      expect(symbol.startByte).toBeGreaterThanOrEqual(0)
      expect(symbol.endByte).toBeGreaterThan(symbol.startByte)
      expect(symbol.endByte).toBeLessThanOrEqual(bytes.byteLength)
      expect(bytes.subarray(symbol.startByte, symbol.endByte).toString('utf8')).toContain(symbol.name)
      expect(symbol.startLine).toBeGreaterThan(0)
      expect(symbol.endLine).toBeGreaterThanOrEqual(symbol.startLine)
    })
  })

  it('converts UTF-16 parser indices into exact UTF-8 byte boundaries', async () => {
    const source = '// 😀 café\nfunction run() { return "🎉" }\n'
    const result = await analyzeFile('unicode.js', source)
    expect(result.qualified).toBe(true)
    expect(result.symbols[0]).toMatchObject({ startByte: Buffer.byteLength('// 😀 café\n', 'utf8'), endByte: Buffer.byteLength(source.trimEnd(), 'utf8'), startLine: 2, endLine: 2 })
    expect(Buffer.from(source).subarray(result.symbols[0].startByte, result.symbols[0].endByte).toString()).toBe('function run() { return "🎉" }')
  })

  it('includes Python decorators in the reserved definition range', async () => {
    const source = '@cache\ndef load():\n    return 1\n'
    const result = await analyzeFile('sample.py', source)
    expect(result).toMatchObject({ qualified: true, symbols: [{ name: 'load', startByte: 0, startLine: 1, endLine: 3 }] })
  })

  it('indexes JSX arrow components using the JavaScript grammar', async () => {
    expect(await analyzeFile('Button.jsx', 'const Button = () => <button>Ready</button>')).toMatchObject({ language: 'javascript', qualified: true, symbols: [{ qualifiedName: 'Button', kind: 'function' }] })
  })

  it('never qualifies parser-recovered invalid syntax', async () => {
    const result = await analyzeFile('broken.ts', 'function save( { return !!!')
    expect(result).toMatchObject({ qualified: false, symbols: [], reason: expect.stringContaining('Syntax errors') })
  })

  it('falls back for unknown/ambiguous languages and oversized or invalid text', async () => {
    expect(await analyzeFile('data.unknown', 'function save() {}')).toMatchObject({ language: null, qualified: false, symbols: [] })
    expect(await analyzeFile('header.h', 'int save(void);')).toMatchObject({ language: null, qualified: false })
    expect(await analyzeFile('huge.js', 'x'.repeat(MAX_ANALYSIS_BYTES + 1))).toHaveProperty('qualified', false)
    expect(await analyzeFile('binary.js', '\0')).toHaveProperty('qualified', false)
  })
})
