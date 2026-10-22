import type { Scope } from '../shared/contracts.js'
import { validateDeclaredScopes } from '../symbols/index.js'

export const qualifyTaskScopes = async (root: string, scopes: Scope[], options?: { assetDirectory?: string }) => {
  const result = await validateDeclaredScopes(root, scopes, options)
  if (!result.ok) throw new Error('Declared scope contains an unsafe repository path.')
  return {
    scopes: result.scopes,
    warnings: result.fallbacks.map(fallback => `${fallback.path}: ${fallback.reason}`),
  }
}
