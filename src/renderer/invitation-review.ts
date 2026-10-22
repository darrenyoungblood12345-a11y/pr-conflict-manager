import type { LanPublic } from '../shared/lan.js'

export interface ReviewedInvitation { text: string; revision: number; peer: LanPublic }

/** A decoded invitation is valid only for the exact text/version the user reviewed. */
export const createInvitationReview = () => {
  let text = ''
  let revision = 0
  const replace = (value: string) => { text = value; revision += 1 }
  const matches = (review: ReviewedInvitation | null): review is ReviewedInvitation =>
    Boolean(review && review.text === text && review.revision === revision)
  const inspect = async (decode: (input: string) => Promise<LanPublic>): Promise<ReviewedInvitation | null> => {
    const pending = { text, revision }
    const peer = await decode(pending.text)
    const review = { ...pending, peer }
    return matches(review) ? review : null
  }
  return { replace, inspect, matches }
}
