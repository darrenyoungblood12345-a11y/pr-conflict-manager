import { describe, expect, it } from 'vitest'
import { canonicalScopePath, PATH_UNICODE_VERSION } from './path-identity.js'

describe('Unicode 15 path identity shared with native coordination', () => {
  it.each([
    ['SRC/Straße.ts', 'src/strasse.ts'],
    ['src/STRAẞE.ts', 'src/strasse.ts'],
    ['src/Σ.ts', 'src/σ.ts'],
    ['src/ς.ts', 'src/σ.ts'],
    ['src/ﬃ.ts', 'src/ffi.ts'],
    ['SRC/Cafe\u0301.ts', 'src/café.ts'],
    ['SRC/Café.ts', 'src/café.ts'],
    ['src/İ.ts', 'src/i\u0307.ts'],
  ])('folds %s to the native identity %s', (input, expected) => {
    expect(canonicalScopePath(input)).toBe(expected)
    expect(canonicalScopePath(expected)).toBe(expected)
  })

  it('refuses post-Unicode-15 characters instead of applying newer runtime equivalences', () => {
    // Cyrillic Tje acquired case mappings in Unicode 16. Native Unicode 15
    // deliberately treats it as unassigned and must not inherit Node's mapping.
    expect(PATH_UNICODE_VERSION).toBe('15.0.0')
    expect(() => canonicalScopePath('src/\u1c89.ts')).toThrow('outside qualified Unicode 15.0.0')
    expect(() => canonicalScopePath('src/\u1c8a.ts')).toThrow()
  })

  it('rejects malformed UTF-16 rather than replacing it with a different filename', () => {
    expect(() => canonicalScopePath('src/\ud800.ts')).toThrow()
  })

  it('refuses Cherokee until native folding is idempotent for those aliases', () => {
    expect(() => canonicalScopePath('src/ꭰ.ts')).toThrow('Cherokee path identity is not qualified')
    expect(() => canonicalScopePath('src/Ꭰ.ts')).toThrow('Cherokee path identity is not qualified')
  })
})
