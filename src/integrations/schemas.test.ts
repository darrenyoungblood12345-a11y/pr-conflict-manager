import { describe, expect, it } from 'vitest'
import { scopeSchema, setPlanSchema, taskProposalSchema } from './schemas.js'
import { sampleTask } from './fixtures.test-support.js'

const proposal = () => {
  const { revision, status, stopAcknowledged, prMerged, conflicts, ...task } = sampleTask()
  return task
}

describe('native-compatible MCP validation', () => {
  it('enforces the coordinator scope count before deduplication', () => {
    const scope = { path: 'source.ts', kind: 'file' as const }
    expect(taskProposalSchema.safeParse({ ...proposal(), scopes: Array(256).fill(scope) }).success).toBe(true)
    expect(taskProposalSchema.safeParse({ ...proposal(), scopes: Array(257).fill(scope) }).success).toBe(false)
  })

  it('uses byte bounds for branch names, qualified symbols, descriptions, and paths', () => {
    expect(taskProposalSchema.safeParse({ ...proposal(), branch: 'é'.repeat(128) }).success).toBe(true)
    expect(taskProposalSchema.safeParse({ ...proposal(), branch: 'é'.repeat(129) }).success).toBe(false)
    expect(scopeSchema.safeParse({ path: 'source.ts', kind: 'symbol', symbol: 'é'.repeat(256) }).success).toBe(true)
    expect(scopeSchema.safeParse({ path: 'source.ts', kind: 'symbol', symbol: 'é'.repeat(257) }).success).toBe(false)
    expect(taskProposalSchema.safeParse({ ...proposal(), description: 'é'.repeat(4001) }).success).toBe(false)
    expect(scopeSchema.safeParse({ path: 'é'.repeat(513), kind: 'file' }).success).toBe(false)
  })

  it.each(['../source.ts', 'a//b', './source.ts', 'a/ b', '~/.ssh', '/absolute', 'a\\b', 'a:b'])('refuses ambiguous repository path %s', filePath => {
    expect(scopeSchema.safeParse({ path: filePath, kind: 'file' }).success).toBe(false)
  })

  it('requires ASCII bounded identities and safe-integer plan revisions', () => {
    expect(taskProposalSchema.safeParse({ ...proposal(), id: 'é' }).success).toBe(false)
    expect(taskProposalSchema.safeParse({ ...proposal(), id: 'a'.repeat(129) }).success).toBe(false)
    expect(taskProposalSchema.safeParse({ ...proposal(), planRevision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
  })

  it('requires qualified symbol scopes and omits symbol from whole-file fallback', () => {
    expect(scopeSchema.safeParse({ path: 'source.ts', kind: 'symbol' }).success).toBe(false)
    expect(scopeSchema.safeParse({ path: 'source.ts', kind: 'file', symbol: 'save' }).success).toBe(false)
  })

  it('accepts an empty shared plan and applies the 64 KiB native byte limit', () => {
    expect(setPlanSchema.safeParse({ expectedRevision: 0, markdown: '' }).success).toBe(true)
    expect(setPlanSchema.safeParse({ expectedRevision: 0, markdown: 'é'.repeat(32768) }).success).toBe(true)
    expect(setPlanSchema.safeParse({ expectedRevision: 0, markdown: 'é'.repeat(32769) }).success).toBe(false)
  })
})
