import { getMessagesByIds, type DatabaseAdapter } from '@openchatlab/core'
import type { FollowUpMatchConfidence, IntimacyMember, SharedPlanDetails } from '@openchatlab/shared-types'
import { buildAssociationPrompt, parseAssociationMatch, toIntimacySourceMessages } from './association'
import { formatIntimacyMessageLines, type IntimacyPreprocessOptions } from './model-protocol'
import type { IntimacySourceMessage } from './source'
import type { IntimacyEventRecord } from './store'

/** How far back a later stage may reach for the arrangement it belongs to (60 days, §K5). */
export const INTIMACY_SHARED_PLAN_LOOKBACK_SECONDS = 60 * 24 * 60 * 60
/** How many arrangements the model may choose between; the most recent ones win. */
export const INTIMACY_SHARED_PLAN_MAX_CANDIDATES = 8
/** How much of an arrangement is quoted so it can be told apart from another one. */
const INTIMACY_SHARED_PLAN_CANDIDATE_MESSAGES = 2

/** An arrangement a later stage could belong to, with the words it was proposed in. */
export interface SharedPlanCandidate {
  eventId: string
  activitySummary: string
  proposedAt: number
  messages: IntimacySourceMessage[]
}

export interface SharedPlanCandidateInput {
  db: DatabaseAdapter
  /** The arrangements this run has coded so far; only a coded plan can take the stages of a later window. */
  plans: IntimacyEventRecord[]
  /** The stage looking for the plan it belongs to. */
  stage: { messageId: number; timestamp: number }
  /** No candidate may predate the chat itself. */
  chatStartTs: number
}

/**
 * Build the list of arrangements a stage seen in this window may belong to. Only plans this run already coded are
 * offered, inside the lookback, so a rescheduling or a look back at an outing joins the arrangement it continues
 * instead of the same activity months apart being read as one. Two of each plan's own messages come along, so the
 * model can tell two similar arrangements apart by what was actually said.
 */
export function collectSharedPlanCandidates(input: SharedPlanCandidateInput): {
  candidates: SharedPlanCandidate[]
  lookbackStartTs: number
} {
  const lookbackStartTs = Math.max(input.stage.timestamp - INTIMACY_SHARED_PLAN_LOOKBACK_SECONDS, input.chatStartTs)
  const plans = input.plans
    .flatMap((plan) =>
      plan.details.kind === 'shared_plan' ? [plan as IntimacyEventRecord & { details: SharedPlanDetails }] : []
    )
    .filter(
      (plan) =>
        plan.anchorMessageId < input.stage.messageId &&
        plan.anchorTs >= lookbackStartTs &&
        plan.anchorTs <= input.stage.timestamp
    )
    .sort((left, right) => right.anchorTs - left.anchorTs || right.anchorMessageId - left.anchorMessageId)
    .slice(0, INTIMACY_SHARED_PLAN_MAX_CANDIDATES)
  if (plans.length === 0) return { candidates: [], lookbackStartTs }

  const quoted = new Map(
    plans.map((plan) => [
      plan.id,
      [...plan.evidence]
        .sort((left, right) => left.messageId - right.messageId)
        .slice(0, INTIMACY_SHARED_PLAN_CANDIDATE_MESSAGES)
        .map((evidence) => evidence.messageId),
    ])
  )
  const messages = new Map(
    toIntimacySourceMessages(getMessagesByIds(input.db, [...quoted.values()].flat())).map((message) => [
      message.id,
      message,
    ])
  )
  return {
    candidates: plans.map((plan) => ({
      eventId: plan.id,
      activitySummary: plan.details.activitySummary,
      proposedAt: plan.anchorTs,
      messages: (quoted.get(plan.id) ?? []).flatMap((messageId) => {
        const message = messages.get(messageId)
        return message ? [message] : []
      }),
    })),
    lookbackStartTs,
  }
}

export interface SharedPlanMatchPromptInput {
  members: [IntimacyMember, IntimacyMember]
  /** The activity the new stage is about, as this window described it. */
  activitySummary: string
  /** The messages the new stage cites, read back from the window they were coded in. */
  stageMessages: IntimacySourceMessage[]
  candidates: SharedPlanCandidate[]
  timezone: string
  preprocess?: IntimacyPreprocessOptions
}

export function buildSharedPlanMatchPrompt(input: SharedPlanMatchPromptInput): {
  systemPrompt: string
  userPrompt: string
} {
  const lines = (messages: IntimacySourceMessage[]) =>
    formatIntimacyMessageLines(messages, {
      members: input.members,
      timezone: input.timezone,
      preprocess: input.preprocess,
    })
  return buildAssociationPrompt({
    task: 'You decide whether messages about an arrangement in a private chat continue an arrangement the two participants made earlier.',
    instructions: `You are given the new messages and the arrangements coded earlier. Return the ID of the arrangement they carry on — moving it, calling it off, or looking back on it — with "match": "supported".
Return {"planEventId":null,"match":"uncertain"} when none of them is that arrangement, or when several would fit equally well. The same kind of outing arranged again later is a different arrangement, not the same one carried on: only the same concrete arrangement counts.`,
    members: input.members,
    anonymize: input.preprocess?.anonymizeNames === true,
    subject: `The new messages are about: ${input.activitySummary}`,
    focusLabel: 'New messages',
    focusLines: lines(input.stageMessages),
    candidatesLabel: 'Earlier arrangements, most recent first',
    candidateLines: input.candidates
      .map((candidate) => `Plan ${candidate.eventId} — ${candidate.activitySummary}\n${lines(candidate.messages)}`)
      .join('\n'),
    returnTemplate: '{"planEventId":null,"match":"uncertain"}',
  })
}

export interface SharedPlanMatch {
  planEventId: string | null
  match: FollowUpMatchConfidence
}

/**
 * Read the answer back against the candidate list. An arrangement the server never offered is refused, and naming
 * nothing is never a match, so a stage only joins a plan the analysis itself coded.
 */
export function parseSharedPlanMatch(text: string, candidates: SharedPlanCandidate[]): SharedPlanMatch {
  const { payload, match } = parseAssociationMatch(text)
  const value = payload.planEventId
  if (value === undefined || value === null || value === '') return { planEventId: null, match: 'uncertain' }
  if (typeof value !== 'string') throw new Error('Invalid shared plan planEventId')
  if (!candidates.some((candidate) => candidate.eventId === value)) {
    throw new Error(`Shared plan ${value} is not one of the candidates`)
  }
  return match === 'supported' ? { planEventId: value, match } : { planEventId: null, match }
}
