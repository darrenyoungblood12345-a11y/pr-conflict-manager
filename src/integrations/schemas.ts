import { z } from 'zod'
import path from 'node:path'

export const agentKindSchema = z.enum(['codex', 'cursor', 'opencode', 'claude-code'])
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const boundedText = (maxBytes: number) => z.string().min(1).max(maxBytes).refine(value => (
  value.trim() === value && value.trim().length > 0
  && !/[\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, 'utf8') <= maxBytes
), `Use nonempty, trimmed UTF-8 text within ${maxBytes} bytes`)
const repositoryPath = boundedText(1024).refine(value => (
  !value.startsWith('/') && !value.startsWith('~') && !/[\\:\p{Cc}]/u.test(value)
  && path.posix.normalize(value) === value && value !== '.'
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.trim() === part)
), 'Use an unambiguous repository-relative path')

export const scopeSchema = z.object({
  path: repositoryPath,
  kind: z.enum(['file', 'symbol']),
  symbol: boundedText(512).refine(value => !/\p{Cc}/u.test(value), 'Symbols cannot contain control characters').optional(),
}).strict().refine(scope => scope.kind === 'symbol' ? Boolean(scope.symbol) : scope.symbol === undefined, {
  message: 'Symbol scope requires a qualified symbol; file scope must omit symbol',
})

export const taskProposalSchema = z.object({
  id: identifier,
  ownerId: identifier,
  sessionId: identifier,
  agent: agentKindSchema,
  branch: boundedText(256),
  baseCommit: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  description: boundedText(8000),
  planRevision: revision,
  scopes: z.array(scopeSchema).min(1).max(256),
}).strict()

export const ownedTaskSchema = z.object({
  taskId: identifier,
  ownerId: identifier,
  expectedRevision: revision,
}).strict()

export const reviseTaskSchema = ownedTaskSchema.extend({ task: taskProposalSchema })
export const linkPullRequestSchema = ownedTaskSchema.extend({ number: revision.refine(value => value > 0) })
export const setPlanSchema = z.object({
  expectedRevision: revision,
  markdown: z.string().max(65536).refine(value => !/[\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 65536, 'Plan must be valid UTF-8 within 64 KiB'),
}).strict()

const lanIdentifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const certificate = z.string().min(1).max(32768)
export const repositoryIdentitySchema = z.object({
  owner: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/),
  repo: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/).refine(value => !['.', '..'].includes(value)),
}).strict()
export const offlineAuthoritySchema = z.object({
  workspaceId: lanIdentifier,
  deviceId: lanIdentifier,
  caCertPEM: certificate,
  repository: repositoryIdentitySchema.optional(),
}).strict()

export const signedTaskReceiptSchema = z.object({
  payload: z.string().min(1).max(355000).regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
  certPEM: certificate,
}).strict()

export const taskSchema = taskProposalSchema.extend({
  pullRequest: z.object({ number: revision.refine(value => value > 0) }).strict().optional(),
  revision,
  status: z.enum(['active', 'blocked', 'awaiting-merge', 'completed', 'cancelled']),
  stopAcknowledged: z.boolean(),
  prMerged: z.boolean(),
  conflicts: z.array(identifier).max(4096),
})

export const agentContextSchema = z.object({
  repositoryRoot: z.string().min(1),
  ownerId: identifier,
  sessionId: identifier,
  agent: agentKindSchema,
  taskId: identifier.optional(),
  revision: revision.optional(),
  offlineAuthority: offlineAuthoritySchema.optional(),
  acceptedOfflineReceipt: signedTaskReceiptSchema.optional(),
  offlineRevokedThrough: z.record(identifier, revision).refine(value => Object.keys(value).length <= 4096).optional(),
}).strict()

export type AgentContext = z.infer<typeof agentContextSchema>
