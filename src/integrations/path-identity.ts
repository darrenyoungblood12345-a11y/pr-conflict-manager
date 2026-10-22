import commonFoldings from '@unicode/unicode-15.0.0/Case_Folding/C/symbols.mjs'
import fullFoldings from '@unicode/unicode-15.0.0/Case_Folding/F/symbols.mjs'
import unassigned from '@unicode/unicode-15.0.0/General_Category/Unassigned/regex.mjs'

export const PATH_UNICODE_VERSION = '15.0.0'

// Match x/text v0.28.0: cases.Fold(), then norm.NFC. A versioned table avoids
// granting an equivalence introduced after the native coordinator's Unicode
// version. NFC is stable for already-assigned Unicode 15 characters; reject
// unknown/new characters instead of relying on the host Node/ICU data version.
export const canonicalScopePath = (value: string): string => {
  if (/[\uD800-\uDFFF]/u.test(value) || unassigned.test(value)) {
    throw new Error(`Path contains characters outside qualified Unicode ${PATH_UNICODE_VERSION}`)
  }
  // Exhaustive verification found the pinned native library toggles Cherokee
  // case instead of giving an idempotent identity. Refuse those names until
  // native normalization is corrected and the shared mapping is requalified.
  if (/[\u13a0-\u13f5\u13f8-\u13fd\uab70-\uabbf]/u.test(value)) {
    throw new Error('Cherokee path identity is not qualified against the current native coordinator')
  }
  return Array.from(value, character => fullFoldings.get(character) ?? commonFoldings.get(character) ?? character).join('').normalize('NFC')
}
