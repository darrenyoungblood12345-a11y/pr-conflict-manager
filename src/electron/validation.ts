import type { Command } from '../shared/contracts.js'
import { linkPullRequestSchema, reviseTaskSchema, setPlanSchema, taskProposalSchema, ownedTaskSchema } from '../integrations/schemas.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const observedTaskSchema = ownedTaskSchema.omit({ ownerId: true })

/** The renderer is not trusted to supply well-formed service commands. */
export const isCommand = (value: unknown): value is Command => {
  if (!isRecord(value)) return false
  const { type, ...payload } = value

  switch (type) {
    case 'set_plan':
      return setPlanSchema.safeParse(payload).success
    case 'register_task':
      return Object.keys(payload).length === 1 && taskProposalSchema.safeParse(payload.task).success
    case 'revise_task': {
      const result = reviseTaskSchema.safeParse(payload)
      return result.success && result.data.task.id === result.data.taskId && result.data.task.ownerId === result.data.ownerId
    }
    case 'acknowledge_stop':
    case 'cancel_task':
    case 'report_completion':
      return ownedTaskSchema.safeParse(payload).success
    case 'link_pull_request':
      return linkPullRequestSchema.safeParse(payload).success
    default:
      return false
  }
}
