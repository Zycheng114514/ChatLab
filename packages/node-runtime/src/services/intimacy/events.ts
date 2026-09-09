import type {
  FollowUpDetails,
  FollowUpInitiation,
  FollowUpMatchConfidence,
  FollowUpReviewDetails,
  GoodNewsResponseDetails,
  IntimacyEvent,
  IntimacyEventDetails,
  IntimacyEventReview,
  IntimacyEventStatus,
  IntimacyEvidence,
  IntimacyFollowUpMemberSummary,
  IntimacyMember,
  IntimacyMemberSummary,
  IntimacyModelDecision,
  IntimacyObservation,
  IntimacyResponseMemberSummary,
  ResponseObservation,
  SharedPlanDetails,
  SharedPlanReviewDetails,
  SharedPlanStage,
  SharedPlanStageRecord,
  SharedPlanSummary,
  SharingCategory,
  SharingDetails,
  SupportResponseDetails,
  SupportResponseLabel,
} from '@openchatlab/shared-types'
import type {
  ModelEventKind,
  ParsedFollowUpEvent,
  ParsedGoodNewsEvent,
  ParsedIntimacyEvent,
  ParsedResponseGroup,
  ParsedSharedPlanEvent,
  ParsedSharedPlanStage,
  ParsedSharingEvent,
} from './model-protocol'
import {
  GOOD_NEWS_RESPONSE_LABELS,
  SHARED_PLAN_STAGES,
  SHARING_CATEGORIES,
  SUPPORT_RESPONSE_LABELS,
} from './model-protocol'
import type { IntimacySourceMessage, IntimacyWindow } from './source'
import type { IntimacyEventRecord } from './store'

/** How far back a follow-up question may reach for the matter it asks about (30 days, §K3). */
export const INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS = 30 * 24 * 60 * 60
/** Questions this close together are the same follow-up conversation. */
export const INTIMACY_FOLLOW_UP_MERGE_GAP_SECONDS = 30 * 60

/** Stored events narrowed by kind, so the labels of one kind can be read without re-checking it. */
type SharingEventRecord = IntimacyEventRecord & { details: SharingDetails }
type SupportEventRecord = IntimacyEventRecord & { details: SupportResponseDetails }
type GoodNewsEventRecord = IntimacyEventRecord & { details: GoodNewsResponseDetails }
type SharedPlanEventRecord = IntimacyEventRecord & { details: SharedPlanDetails }

interface WindowBuildContext {
  windowMessages: Map<number, IntimacySourceMessage>
  contextIds: Set<number>
  previousWindowEvents: IntimacyEventRecord[]
  /** Event ids already written in this window, so one matter is never split over two events. */
  usedAnchors: Set<string>
  createdAt: number
}

/**
 * Turn one validated window response into storable events. Timestamps and senders are read back from the
 * window instead of the model response, an event continued from the previous window is merged into the one that
 * already covers it, and a distress disclosure or a piece of good news additionally produces the response event
 * that records how the other participant answered it.
 */
export function buildIntimacyEvents(
  parsed: ParsedIntimacyEvent[],
  window: IntimacyWindow,
  members: [IntimacyMember, IntimacyMember],
  previousWindowEvents: IntimacyEventRecord[],
  createdAt: number
): IntimacyEventRecord[] {
  const context: WindowBuildContext = {
    windowMessages: new Map(window.messages.map((message) => [message.id, message])),
    contextIds: new Set(window.messages.slice(0, window.contextCount).map((message) => message.id)),
    previousWindowEvents,
    usedAnchors: new Set<string>(),
    createdAt,
  }
  const events: IntimacyEventRecord[] = []
  // Within one kind a core message supports a single event; a sharing and a piece of good news may share them.
  const usedCoreIds: Record<ModelEventKind, Set<number>> = {
    sharing: new Set(),
    good_news: new Set(),
    follow_up: new Set(),
    shared_plan: new Set(),
  }
  // Questions about the same matter in one conversation are one event; a later conversation is a new one.
  const followUpConversations = new Map<string, number>()

  for (const item of parsed) {
    const coreMessageIds = item.coreMessageIds.filter((messageId) => !usedCoreIds[item.kind].has(messageId))
    if (item.kind === 'shared_plan') {
      const built = codeSharedPlan(item, coreMessageIds, members, context)
      if (!built) continue
      events.push(built)
      context.usedAnchors.add(built.id)
      for (const messageId of coreMessageIds) usedCoreIds.shared_plan.add(messageId)
      continue
    }
    if (item.kind === 'follow_up') {
      if (coreMessageIds.length === 0) continue
      const asker = members[item.asker === 'A' ? 0 : 1]
      const asked = members[item.asker === 'A' ? 1 : 0]
      const built = codeFollowUp(item, coreMessageIds, asked, asker, context)
      if (!built) continue
      const key = `${item.asker}\u0000${item.matter.trim().toLowerCase()}`
      const merged = mergeFollowUpConversation(events, followUpConversations, key, built)
      if (!merged) {
        followUpConversations.set(key, events.length)
        events.push(built)
        context.usedAnchors.add(built.id)
      }
      for (const messageId of coreMessageIds) usedCoreIds.follow_up.add(messageId)
      continue
    }
    if (coreMessageIds.length === 0 && !item.continuesContextEvent) continue
    const subjectMemberId = members[item.discloser === 'A' ? 0 : 1].memberId
    const otherMemberId = members[item.discloser === 'A' ? 1 : 0].memberId
    const built =
      item.kind === 'sharing'
        ? codeSharing(item, coreMessageIds, subjectMemberId, otherMemberId, context)
        : codeGoodNews(item, coreMessageIds, subjectMemberId, otherMemberId, context)
    if (built.length === 0) continue
    events.push(...built)
    for (const messageId of coreMessageIds) usedCoreIds[item.kind].add(messageId)
  }
  return events
}

/**
 * One follow-up conversation is one event: another question about the same matter, from the same asker and within
 * half an hour of the last one, joins the question that opened it instead of counting the matter a second time.
 */
function mergeFollowUpConversation(
  events: IntimacyEventRecord[],
  conversations: Map<string, number>,
  key: string,
  built: IntimacyEventRecord
): boolean {
  const index = conversations.get(key)
  const previous = index === undefined ? undefined : events[index]
  if (index === undefined || !previous) return false
  const lastQuestionTs = Math.max(...previous.evidence.filter((item) => item.role === 'core').map((i) => i.timestamp))
  if (built.anchorTs - lastQuestionTs > INTIMACY_FOLLOW_UP_MERGE_GAP_SECONDS) return false
  events[index] = { ...previous, evidence: mergeEvidence([...previous.evidence, ...built.evidence]) }
  return true
}

/**
 * A follow-up question with the earlier messages it points at, when this window shows them. Everything the pairing
 * decides — which event the matter belongs to, how long the gap was, who raised it in between — is filled in by
 * applyFollowUpPairing, because it needs the whole run and the chat, not just this window.
 */
function codeFollowUp(
  item: ParsedFollowUpEvent,
  coreMessageIds: number[],
  asked: IntimacyMember,
  asker: IntimacyMember,
  context: WindowBuildContext
): IntimacyEventRecord | null {
  const anchorMessageId = Math.min(...coreMessageIds)
  const id = `follow_up:${anchorMessageId}`
  if (context.usedAnchors.has(id)) return null
  const anchorTs = context.windowMessages.get(anchorMessageId)!.timestamp
  const record: IntimacyEventRecord = {
    id,
    kind: 'follow_up',
    subjectMemberId: asked.memberId,
    otherMemberId: asker.memberId,
    anchorMessageId,
    anchorTs,
    evidence: buildEvidence(coreMessageIds, [], context.windowMessages),
    observation: item.observation,
    origin: 'model',
    modelDecision: item.confidence === 'clear' ? 'included' : 'uncertain',
    modelReason: item.reason,
    details: {
      kind: 'follow_up',
      priorEventId: null,
      matter: item.matter,
      matterKeywords: item.matterKeywords,
      matchConfidence: 'uncertain',
      initiationInObservedRecord: 'uncertain',
      gapSeconds: null,
      lookbackStartTs: anchorTs - INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS,
      candidateMessageIds: [],
    },
    createdAt: context.createdAt,
  }
  const priorEvidence = item.priorMessageIds.flatMap((messageId) => {
    const message = context.windowMessages.get(messageId)
    return message
      ? [{ messageId, timestamp: message.timestamp, senderId: message.senderId, role: 'prior' as const }]
      : []
  })
  if (priorEvidence.length === 0) return record
  return applyFollowUpPairing(record, {
    priorEvidence,
    priorEventId: null,
    matchConfidence: 'supported',
    initiation: 'uncertain',
    candidateMessageIds: [],
    lookbackStartTs: anchorTs - INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS,
  })
}

/**
 * One arrangement as this window shows it. The proposal anchors it; a window that only shows a later stage still
 * produces an event, anchored on that stage and with no proposer, so the association step can look for the plan it
 * belongs to instead of the arrangement being lost or attributed to a guess.
 */
function codeSharedPlan(
  item: ParsedSharedPlanEvent,
  coreMessageIds: number[],
  members: [IntimacyMember, IntimacyMember],
  context: WindowBuildContext
): IntimacyEventRecord | null {
  const stages = buildStageRecords(item.stages, members, context.windowMessages)
  if (stages.length === 0) return null
  const proposerMemberId = coreMessageIds.length === 0 ? null : members[item.proposer === 'A' ? 0 : 1].memberId
  const anchorMessageId =
    coreMessageIds.length > 0 ? Math.min(...coreMessageIds) : Math.min(...stages.flatMap((stage) => stage.messageIds))
  const anchor = context.windowMessages.get(anchorMessageId)
  if (!anchor) return null
  const subjectMemberId = proposerMemberId ?? stages[0]!.actorMemberId
  const built: IntimacyEventRecord = {
    id: `shared_plan:${anchorMessageId}`,
    kind: 'shared_plan',
    subjectMemberId,
    otherMemberId: members.find((member) => member.memberId !== subjectMemberId)!.memberId,
    anchorMessageId,
    anchorTs: anchor.timestamp,
    evidence: mergeEvidence([
      ...buildEvidence(coreMessageIds, [], context.windowMessages),
      ...buildStageEvidence(stages, context.windowMessages),
    ]),
    observation: item.observation,
    origin: 'model',
    modelDecision: item.confidence === 'clear' ? 'included' : 'uncertain',
    modelReason: item.reason,
    details: buildSharedPlanDetails(proposerMemberId, item.activitySummary, stages),
    createdAt: context.createdAt,
  }
  const continued = item.continuesContextEvent
    ? findContinuedPlan(context, proposerMemberId, item.activitySummary)
    : null
  if (!continued || context.usedAnchors.has(continued.id)) {
    return context.usedAnchors.has(built.id) ? null : built
  }
  return mergeSharedPlanEvents(continued, built)
}

/**
 * Fold a later view of one arrangement into the event that already holds it, whether it came from the next window
 * or from the association step. The stages become one timeline and the evidence is unioned, while the identity —
 * event id, anchor, proposer and activity — stays with the event that started it, so one arrangement counts once.
 */
export function mergeSharedPlanEvents(target: IntimacyEventRecord, addition: IntimacyEventRecord): IntimacyEventRecord {
  if (target.details.kind !== 'shared_plan' || addition.details.kind !== 'shared_plan') return target
  const proposerMemberId = target.details.proposerMemberId ?? addition.details.proposerMemberId
  return {
    ...target,
    evidence: mergeEvidence([...target.evidence, ...addition.evidence]),
    // A limited observation from either window survives the merge; only one of the two can be more informative.
    observation: target.observation === 'sufficient' ? addition.observation : target.observation,
    modelDecision:
      target.modelDecision === 'uncertain' || addition.modelDecision === 'uncertain'
        ? 'uncertain'
        : target.modelDecision,
    details: buildSharedPlanDetails(proposerMemberId, target.details.activitySummary, [
      ...target.details.stages,
      ...addition.details.stages,
    ]),
  }
}

/** The plan as the stages describe it: one ordered timeline, where it stands now, and whether its start is here. */
export function buildSharedPlanDetails(
  proposerMemberId: number | null,
  activitySummary: string,
  stages: SharedPlanStageRecord[]
): SharedPlanDetails {
  const timeline = sortSharedPlanStages(stages)
  return {
    kind: 'shared_plan',
    proposerMemberId,
    activitySummary,
    stages: timeline,
    lastObservedStage: timeline[timeline.length - 1]!.stage,
    // Without a proposal the arrangement is real but its beginning is not covered by this analysis.
    priorCoverage: proposerMemberId === null ? 'not_covered' : 'covered',
  }
}

/** One timeline in message order; the same stage reported twice stays one entry. */
function sortSharedPlanStages(stages: SharedPlanStageRecord[]): SharedPlanStageRecord[] {
  const byKey = new Map<string, SharedPlanStageRecord>()
  for (const stage of stages) {
    const key = `${stage.stage}\u0000${stage.actorMemberId}\u0000${stage.messageIds.join(',')}`
    if (!byKey.has(key)) byKey.set(key, stage)
  }
  return [...byKey.values()].sort(
    (left, right) => left.at - right.at || Math.min(...left.messageIds) - Math.min(...right.messageIds)
  )
}

function buildStageRecords(
  stages: ParsedSharedPlanStage[],
  members: [IntimacyMember, IntimacyMember],
  windowMessages: Map<number, IntimacySourceMessage>
): SharedPlanStageRecord[] {
  return stages.flatMap((stage) => {
    const messages = stage.messageIds.flatMap((messageId) => {
      const message = windowMessages.get(messageId)
      return message ? [message] : []
    })
    if (messages.length === 0) return []
    return [
      {
        stage: stage.stage,
        actorMemberId: members[stage.actor === 'A' ? 0 : 1].memberId,
        messageIds: messages.map((message) => message.id),
        at: Math.min(...messages.map((message) => message.timestamp)),
      },
    ]
  })
}

function buildStageEvidence(
  stages: SharedPlanStageRecord[],
  windowMessages: Map<number, IntimacySourceMessage>
): IntimacyEvidence[] {
  return stages.flatMap((stage) =>
    stage.messageIds.flatMap((messageId) => {
      const message = windowMessages.get(messageId)
      return message
        ? [{ messageId, timestamp: message.timestamp, senderId: message.senderId, role: 'stage' as const }]
        : []
    })
  )
}

/** The arrangement the context tail already shows: the same activity if it is named again, otherwise the same proposer. */
function findContinuedPlan(
  context: WindowBuildContext,
  proposerMemberId: number | null,
  activitySummary: string
): SharedPlanEventRecord | null {
  const visible = context.previousWindowEvents.filter(
    (event): event is SharedPlanEventRecord =>
      isSharedPlanRecord(event) && event.evidence.some((evidence) => context.contextIds.has(evidence.messageId))
  )
  const summary = normalizeActivitySummary(activitySummary)
  const named = visible.filter((event) => normalizeActivitySummary(event.details.activitySummary) === summary)
  const candidates =
    named.length > 0
      ? named
      : visible.filter((event) => proposerMemberId !== null && event.details.proposerMemberId === proposerMemberId)
  if (candidates.length === 0) return null
  return candidates.reduce((latest, event) =>
    event.anchorTs > latest.anchorTs ||
    (event.anchorTs === latest.anchorTs && event.anchorMessageId > latest.anchorMessageId)
      ? event
      : latest
  )
}

function normalizeActivitySummary(activitySummary: string): string {
  return activitySummary.trim().toLowerCase()
}

/** A sharing event, plus the support response event when the sharing states a difficulty, worry or need. */
function codeSharing(
  item: ParsedSharingEvent,
  coreMessageIds: number[],
  subjectMemberId: number,
  otherMemberId: number,
  context: WindowBuildContext
): IntimacyEventRecord[] {
  const continued = item.continuesContextEvent
    ? findContinuedEvent(context.previousWindowEvents, isSharingRecord, subjectMemberId, context.contextIds)
    : null
  const target = continued && !context.usedAnchors.has(continued.id) ? continued : null
  const addition = {
    evidence: buildEvidence(coreMessageIds, item.relatedMessageIds, context.windowMessages),
    details: {
      kind: 'sharing' as const,
      categories: normalizeCategories(item.categories),
      topic: item.topic,
      isDistressDisclosure: item.distress,
    },
    modelDecision: (item.confidence === 'clear' ? 'included' : 'uncertain') as IntimacyModelDecision,
    observation: item.observation,
  }

  let sharing: SharingEventRecord
  if (target) {
    sharing = mergeContinuedSharing(target, addition)
  } else {
    if (coreMessageIds.length === 0) return []
    const anchorMessageId = Math.min(...coreMessageIds)
    const id = `sharing:${anchorMessageId}`
    if (context.usedAnchors.has(id)) return []
    sharing = {
      id,
      kind: 'sharing',
      subjectMemberId,
      otherMemberId,
      anchorMessageId,
      anchorTs: context.windowMessages.get(anchorMessageId)!.timestamp,
      evidence: addition.evidence,
      observation: addition.observation,
      origin: 'model',
      modelDecision: addition.modelDecision,
      modelReason: item.reason,
      details: addition.details,
      createdAt: context.createdAt,
    }
  }
  context.usedAnchors.add(sharing.id)
  const support = codeSupportResponse(sharing, item.responses, context)
  return support ? [sharing, support] : [sharing]
}

/**
 * The support response event lives alongside the disclosure it answers. It is created for a disclosure the model
 * marked as distress, and kept updated once it exists, so a reply arriving in a later window joins the same event.
 */
function codeSupportResponse(
  sharing: SharingEventRecord,
  responses: ParsedResponseGroup<SupportResponseLabel> | null,
  context: WindowBuildContext
): SupportEventRecord | null {
  const id = `support_response:${sharing.anchorMessageId}`
  const previous =
    context.previousWindowEvents.find(
      (event): event is SupportEventRecord => event.id === id && isSupportRecord(event)
    ) ?? null
  if (sharing.details.isDistressDisclosure !== 'yes' && !previous) return null
  const merged = mergeResponseDetails(previous?.details ?? null, responses, SUPPORT_RESPONSE_LABELS)
  return {
    id,
    kind: 'support_response',
    subjectMemberId: sharing.subjectMemberId,
    otherMemberId: sharing.otherMemberId,
    anchorMessageId: sharing.anchorMessageId,
    anchorTs: sharing.anchorTs,
    evidence: mergeEvidence([
      ...sharing.evidence.filter((evidence) => evidence.role === 'core'),
      ...(previous?.evidence.filter((evidence) => evidence.role === 'response') ?? []),
      ...buildResponseEvidence(responses, sharing.anchorMessageId, sharing.otherMemberId, context.windowMessages),
    ]),
    observation: sharing.observation,
    origin: 'model',
    modelDecision: sharing.modelDecision,
    modelReason: sharing.modelReason,
    details: {
      kind: 'support_response',
      disclosureEventId: sharing.id,
      responseLabels: merged.labels,
      responseObservation: merged.observation,
    },
    createdAt: previous?.createdAt ?? context.createdAt,
  }
}

function codeGoodNews(
  item: ParsedGoodNewsEvent,
  coreMessageIds: number[],
  subjectMemberId: number,
  otherMemberId: number,
  context: WindowBuildContext
): IntimacyEventRecord[] {
  const continued = item.continuesContextEvent
    ? findContinuedEvent(context.previousWindowEvents, isGoodNewsRecord, subjectMemberId, context.contextIds)
    : null
  const target = continued && !context.usedAnchors.has(continued.id) ? continued : null
  if (!target && coreMessageIds.length === 0) return []
  const anchorMessageId = target ? target.anchorMessageId : Math.min(...coreMessageIds)
  const id = `good_news_response:${anchorMessageId}`
  if (!target && context.usedAnchors.has(id)) return []
  const merged = mergeResponseDetails(target?.details ?? null, item.responses, GOOD_NEWS_RESPONSE_LABELS)
  const positiveForSharer = target?.details.positiveForSharer ?? item.positiveForSharer
  // Good news the sharer may not read as good is never counted as a clear case.
  const modelDecision: IntimacyModelDecision =
    item.confidence === 'clear' && positiveForSharer === 'explicit_or_context_supported' ? 'included' : 'uncertain'
  context.usedAnchors.add(id)
  return [
    {
      id,
      kind: 'good_news_response',
      subjectMemberId,
      otherMemberId,
      anchorMessageId,
      anchorTs: target?.anchorTs ?? context.windowMessages.get(anchorMessageId)!.timestamp,
      evidence: mergeEvidence([
        ...(target?.evidence ?? []),
        ...buildEvidence(coreMessageIds, item.relatedMessageIds, context.windowMessages),
        ...buildResponseEvidence(item.responses, anchorMessageId, otherMemberId, context.windowMessages),
      ]),
      observation: target && target.observation !== 'sufficient' ? target.observation : item.observation,
      origin: 'model',
      modelDecision: target?.modelDecision === 'uncertain' ? 'uncertain' : modelDecision,
      modelReason: target?.modelReason ?? item.reason,
      details: {
        kind: 'good_news_response',
        positiveForSharer,
        responseLabels: merged.labels,
        responseObservation: merged.observation,
      },
      createdAt: target?.createdAt ?? context.createdAt,
    },
  ]
}

export function resolveEventStatus(
  event: Pick<IntimacyEvent, 'origin' | 'modelDecision' | 'details'>,
  review: IntimacyEventReview | null
): IntimacyEventStatus {
  if (review?.decision === 'excluded') return 'excluded'
  if (review?.decision === 'included') return 'confirmed'
  if (event.origin === 'user') return 'confirmed'
  // A follow-up question whose earlier matter was never found is waiting for the user, not a counted pair.
  if (event.details.kind === 'follow_up' && event.details.matchConfidence !== 'supported') return 'uncertain'
  return event.modelDecision === 'uncertain' ? 'uncertain' : 'auto'
}

/** What the pairing step found for one follow-up question; empty evidence leaves the question waiting. */
export interface FollowUpPairing {
  priorEvidence: IntimacyEvidence[]
  priorEventId: string | null
  matchConfidence: FollowUpMatchConfidence
  initiation: FollowUpInitiation
  candidateMessageIds: number[]
  lookbackStartTs: number
}

/** Write a pairing onto a follow-up event: the cited earlier messages plus everything derived from them. */
export function applyFollowUpPairing(event: IntimacyEventRecord, pairing: FollowUpPairing): IntimacyEventRecord {
  if (event.details.kind !== 'follow_up') return event
  const evidence = mergeEvidence([...event.evidence, ...pairing.priorEvidence])
  const prior = evidence.filter((item) => item.role === 'prior')
  const supported = pairing.matchConfidence === 'supported' && prior.length > 0
  return {
    ...event,
    evidence,
    details: {
      ...event.details,
      priorEventId: pairing.priorEventId,
      matchConfidence: supported ? 'supported' : 'uncertain',
      initiationInObservedRecord: supported ? pairing.initiation : 'uncertain',
      gapSeconds: prior.length === 0 ? null : event.anchorTs - Math.min(...prior.map((item) => item.timestamp)),
      lookbackStartTs: pairing.lookbackStartTs,
      candidateMessageIds: pairing.candidateMessageIds,
    },
  }
}

/** The sharing event a message belongs to, so two questions about one coded matter count as one matter. */
export function findSharingEventCovering(
  events: IntimacyEventRecord[],
  messageId: number,
  subjectMemberId: number
): string | null {
  const found = events.find(
    (event) =>
      event.kind === 'sharing' &&
      event.subjectMemberId === subjectMemberId &&
      event.evidence.some((evidence) => evidence.messageId === messageId)
  )
  return found?.id ?? null
}

/** Apply a user revision on top of the stored labels so display and counts use the same values. */
export function applyReviewDetails(
  details: IntimacyEventDetails,
  review: IntimacyEventReview | null
): IntimacyEventDetails {
  const revision = review?.details
  if (!revision) return details
  if (details.kind === 'sharing') {
    const revised = revision as Partial<Omit<SharingDetails, 'kind'>>
    return {
      kind: 'sharing',
      categories:
        revised.categories && revised.categories.length > 0
          ? normalizeCategories(revised.categories)
          : details.categories,
      topic: revised.topic ?? details.topic,
      isDistressDisclosure: revised.isDistressDisclosure ?? details.isDistressDisclosure,
    }
  }
  if (details.kind === 'support_response') {
    const revised = revision as Partial<Omit<SupportResponseDetails, 'kind'>>
    return {
      ...details,
      responseLabels: reviseResponseLabels(details, revised.responseLabels, SUPPORT_RESPONSE_LABELS),
    }
  }
  if (details.kind === 'follow_up') {
    // The user picked the earlier messages; the service resolved the pairing before storing the revision.
    const revised = revision as FollowUpReviewDetails
    if (!revised.priorMessageIds || revised.priorMessageIds.length === 0) return details
    return {
      ...details,
      matter: revised.matter ?? details.matter,
      priorEventId: revised.priorEventId ?? null,
      matchConfidence: revised.matchConfidence ?? 'supported',
      initiationInObservedRecord: revised.initiationInObservedRecord ?? 'uncertain',
      gapSeconds: revised.gapSeconds ?? null,
    }
  }
  if (details.kind === 'shared_plan') {
    // The stages themselves are evidence; the user may only say where the plan stands now.
    const revised = revision as SharedPlanReviewDetails
    return revised.lastObservedStage ? { ...details, lastObservedStage: revised.lastObservedStage } : details
  }
  const revised = revision as Partial<Omit<GoodNewsResponseDetails, 'kind'>>
  return {
    ...details,
    positiveForSharer: revised.positiveForSharer ?? details.positiveForSharer,
    responseLabels: reviseResponseLabels(details, revised.responseLabels, GOOD_NEWS_RESPONSE_LABELS),
  }
}

export function summarizeSharing(events: IntimacyEvent[], members: IntimacyMember[]): IntimacyMemberSummary[] {
  return members.map((member) => {
    const own = events.filter((event) => event.kind === 'sharing' && event.subjectMemberId === member.memberId)
    const counted = own.filter((event) => event.status === 'auto' || event.status === 'confirmed')
    const byCategory = Object.fromEntries(SHARING_CATEGORIES.map((category) => [category, 0])) as Record<
      SharingCategory,
      number
    >
    for (const event of counted) {
      if (event.details.kind !== 'sharing') continue
      for (const category of event.details.categories) byCategory[category] += 1
    }
    return {
      memberId: member.memberId,
      counted: counted.length,
      autoCount: own.filter((event) => event.status === 'auto').length,
      confirmedCount: own.filter((event) => event.status === 'confirmed').length,
      uncertainCount: own.filter((event) => event.status === 'uncertain').length,
      byCategory,
    }
  })
}

/**
 * Count one kind of response event per responder. Every counted event has exactly one observation, and only an
 * event with a visible reply contributes labels, so a reply nobody can see is never read as a bad response.
 */
export function summarizeResponses(
  events: IntimacyEvent[],
  members: IntimacyMember[],
  kind: 'support_response' | 'good_news_response'
): IntimacyResponseMemberSummary[] {
  const labels = kind === 'support_response' ? SUPPORT_RESPONSE_LABELS : GOOD_NEWS_RESPONSE_LABELS
  return members.map((member) => {
    const counted = events.filter(
      (event) =>
        event.kind === kind &&
        event.otherMemberId === member.memberId &&
        (event.status === 'auto' || event.status === 'confirmed')
    )
    const byLabel = Object.fromEntries(labels.map((label) => [label, 0])) as Record<string, number>
    for (const event of counted) {
      const details = responseDetailsOf(event)
      if (!details || details.responseObservation !== 'visible_response') continue
      for (const label of details.responseLabels) byLabel[label] += 1
    }
    const countObservation = (observation: ResponseObservation) =>
      counted.filter((event) => responseDetailsOf(event)?.responseObservation === observation).length
    return {
      memberId: member.memberId,
      anchors: counted.length,
      visibleResponse: countObservation('visible_response'),
      noVisibleResponse: countObservation('no_visible_response'),
      insufficientContext: countObservation('insufficient_context'),
      byLabel,
    }
  })
}

/**
 * Count follow-up questions per asker. A question whose earlier matter was never found stays out of the pairs and
 * is reported on its own, so an unmatched question is never read as "they asked about nothing".
 */
export function summarizeFollowUps(
  events: IntimacyEvent[],
  members: IntimacyMember[]
): IntimacyFollowUpMemberSummary[] {
  return members.map((member) => {
    const own = events.filter((event) => event.kind === 'follow_up' && event.otherMemberId === member.memberId)
    const counted = own.filter((event) => event.status === 'auto' || event.status === 'confirmed')
    const countInitiation = (initiation: FollowUpInitiation) =>
      counted.filter((event) => followUpDetailsOf(event)?.initiationInObservedRecord === initiation).length
    return {
      memberId: member.memberId,
      pairs: counted.length,
      matters: new Set(counted.flatMap((event) => matterKeyOf(event) ?? [])).size,
      uncertain: own.filter((event) => event.status === 'uncertain').length,
      beforeReintroduced: countInitiation('before_subject_reintroduced'),
      afterReintroduced: countInitiation('after_subject_reintroduced'),
      initiationUncertain: countInitiation('uncertain'),
    }
  })
}

/**
 * The plan as it stood at the end of the target range. An arrangement keeps moving after a range ends, and a view
 * of last month should not show this month's cancellation, so the stages the range does not reach are left out and
 * where the plan stood is read from what remains.
 */
export function clampSharedPlanDetails(details: SharedPlanDetails, endTs?: number): SharedPlanDetails {
  if (endTs === undefined) return details
  const stages = details.stages.filter((stage) => stage.at <= endTs)
  if (stages.length === 0 || stages.length === details.stages.length) return details
  return { ...details, stages, lastObservedStage: stages[stages.length - 1]!.stage }
}

/** The target range a summary describes; an open end counts everything that is there. */
export interface SharedPlanRange {
  startTs?: number
  endTs?: number
}

/**
 * Count shared plans. One arrangement counts once however many times it was moved, and the stages it reached
 * after the target range are not part of this view: the caller hands over events whose stages already end with
 * the range, so `byLastStage` describes where each plan stood then and its entries add up to `updatedInRange`.
 */
export function summarizeSharedPlans(
  events: IntimacyEvent[],
  members: IntimacyMember[],
  range?: SharedPlanRange
): SharedPlanSummary {
  const counted = events.filter(
    (event) => event.kind === 'shared_plan' && (event.status === 'auto' || event.status === 'confirmed')
  )
  const byLastStage = Object.fromEntries(SHARED_PLAN_STAGES.map((stage) => [stage, 0])) as Record<
    SharedPlanStage,
    number
  >
  const proposedBy = Object.fromEntries(members.map((member) => [member.memberId, 0])) as Record<number, number>
  const confirmedBy = Object.fromEntries(members.map((member) => [member.memberId, 0])) as Record<number, number>
  let newlyProposed = 0
  let updatedInRange = 0

  for (const event of counted) {
    const details = sharedPlanDetailsOf(event)
    if (!details) continue
    if (!details.stages.some((stage) => withinPlanRange(stage.at, range))) continue
    updatedInRange += 1
    byLastStage[details.lastObservedStage] += 1
    if (details.proposerMemberId !== null) {
      if (proposedBy[details.proposerMemberId] !== undefined) proposedBy[details.proposerMemberId] += 1
      if (withinPlanRange(event.anchorTs, range)) newlyProposed += 1
    }
    const confirmers = new Set(
      details.stages.filter((stage) => stage.stage === 'mutually_confirmed').map((stage) => stage.actorMemberId)
    )
    for (const memberId of confirmers) {
      if (confirmedBy[memberId] !== undefined) confirmedBy[memberId] += 1
    }
  }
  return { kind: 'shared_plan', newlyProposed, updatedInRange, byLastStage, proposedBy, confirmedBy }
}

function withinPlanRange(timestamp: number, range?: SharedPlanRange): boolean {
  if (range?.startTs !== undefined && timestamp < range.startTs) return false
  return !(range?.endTs !== undefined && timestamp > range.endTs)
}

function sharedPlanDetailsOf(event: IntimacyEvent): SharedPlanDetails | null {
  return event.details.kind === 'shared_plan' ? event.details : null
}

/** Two questions about the same earlier matter are one matter, whether or not that matter is a coded K1 event. */
function matterKeyOf(event: IntimacyEvent): string | null {
  const details = followUpDetailsOf(event)
  if (!details) return null
  if (details.priorEventId) return details.priorEventId
  const prior = event.evidence.filter((evidence) => evidence.role === 'prior')
  return prior.length === 0 ? null : `message:${Math.min(...prior.map((evidence) => evidence.messageId))}`
}

function followUpDetailsOf(event: IntimacyEvent): FollowUpDetails | null {
  return event.details.kind === 'follow_up' ? event.details : null
}

function responseDetailsOf(event: IntimacyEvent): SupportResponseDetails | GoodNewsResponseDetails | null {
  return event.details.kind === 'support_response' || event.details.kind === 'good_news_response' ? event.details : null
}

/** Labels describe a reply the analysis actually cited, so a revision never labels a reply that was not seen. */
function reviseResponseLabels<T extends string>(
  details: { responseObservation: ResponseObservation; responseLabels: T[] },
  revised: T[] | undefined,
  order: readonly T[]
): T[] {
  if (!revised || revised.length === 0 || details.responseObservation !== 'visible_response') {
    return details.responseLabels
  }
  const unique = new Set(revised)
  return order.filter((label) => unique.has(label))
}

function findContinuedEvent<T extends IntimacyEventRecord>(
  previousWindowEvents: IntimacyEventRecord[],
  isKind: (event: IntimacyEventRecord) => event is T,
  subjectMemberId: number,
  contextIds: Set<number>
): T | null {
  const candidates = previousWindowEvents.filter(
    (event): event is T =>
      isKind(event) &&
      event.subjectMemberId === subjectMemberId &&
      event.evidence.some((evidence) => contextIds.has(evidence.messageId))
  )
  if (candidates.length === 0) return null
  return candidates.reduce((latest, event) =>
    event.anchorTs > latest.anchorTs ||
    (event.anchorTs === latest.anchorTs && event.anchorMessageId > latest.anchorMessageId)
      ? event
      : latest
  )
}

function isSharingRecord(event: IntimacyEventRecord): event is SharingEventRecord {
  return event.details.kind === 'sharing'
}

function isSupportRecord(event: IntimacyEventRecord): event is SupportEventRecord {
  return event.details.kind === 'support_response'
}

function isGoodNewsRecord(event: IntimacyEventRecord): event is GoodNewsEventRecord {
  return event.details.kind === 'good_news_response'
}

function isSharedPlanRecord(event: IntimacyEventRecord): event is SharedPlanEventRecord {
  return event.details.kind === 'shared_plan'
}

function mergeContinuedSharing(
  previous: SharingEventRecord,
  addition: {
    evidence: IntimacyEvidence[]
    details: SharingDetails
    modelDecision: IntimacyModelDecision
    observation: IntimacyObservation
  }
): SharingEventRecord {
  return {
    ...previous,
    evidence: mergeEvidence([...previous.evidence, ...addition.evidence]),
    // A limited observation from either window survives the merge; only one of the two can be more informative.
    observation: previous.observation === 'sufficient' ? addition.observation : previous.observation,
    modelDecision:
      previous.modelDecision === 'uncertain' || addition.modelDecision === 'uncertain' ? 'uncertain' : 'included',
    details: {
      kind: 'sharing',
      categories: normalizeCategories([...previous.details.categories, ...addition.details.categories]),
      topic: previous.details.topic,
      isDistressDisclosure: mergeDistress(previous.details.isDistressDisclosure, addition.details.isDistressDisclosure),
    },
  }
}

/**
 * A reply seen in either window keeps the event marked as answered and the labels are unioned; a window that saw
 * no reply never overwrites one that did, and a missing reply keeps its own observation with no labels at all.
 */
function mergeResponseDetails<Label extends string>(
  previous: { responseObservation: ResponseObservation; responseLabels: Label[] } | null,
  responses: ParsedResponseGroup<Label> | null,
  order: readonly Label[]
): { observation: ResponseObservation; labels: Label[] } {
  if (!previous) {
    return responses
      ? { observation: responses.observation, labels: responses.labels }
      : { observation: 'no_visible_response', labels: [] }
  }
  if (!responses) return { observation: previous.responseObservation, labels: previous.responseLabels }
  const seen = new Set<Label>([...previous.responseLabels, ...responses.labels])
  return {
    observation:
      previous.responseObservation === 'visible_response' || responses.observation === 'visible_response'
        ? 'visible_response'
        : responses.observation,
    labels: order.filter((label) => seen.has(label)),
  }
}

function buildEvidence(
  coreMessageIds: number[],
  relatedMessageIds: number[],
  windowMessages: Map<number, IntimacySourceMessage>
): IntimacyEvidence[] {
  const evidence: IntimacyEvidence[] = []
  for (const [messageIds, role] of [
    [coreMessageIds, 'core'],
    [relatedMessageIds, 'related'],
  ] as const) {
    for (const messageId of messageIds) {
      const message = windowMessages.get(messageId)
      if (!message) continue
      evidence.push({ messageId, timestamp: message.timestamp, senderId: message.senderId, role })
    }
  }
  return mergeEvidence(evidence)
}

/**
 * The reply evidence is re-checked against the window here because a continued event anchors in the previous one:
 * the model response alone cannot show that the reply came after the message it answers.
 */
function buildResponseEvidence(
  responses: ParsedResponseGroup<string> | null,
  anchorMessageId: number,
  otherMemberId: number,
  windowMessages: Map<number, IntimacySourceMessage>
): IntimacyEvidence[] {
  return (responses?.messageIds ?? []).map((messageId) => {
    const message = windowMessages.get(messageId)
    if (!message) throw new Error(`Response message ${messageId} is not part of this window`)
    if (message.senderId !== otherMemberId) {
      throw new Error(`Response message ${messageId} was not sent by the other participant`)
    }
    if (messageId <= anchorMessageId) {
      throw new Error(`Response message ${messageId} does not follow the message it answers`)
    }
    return { messageId, timestamp: message.timestamp, senderId: message.senderId, role: 'response' as const }
  })
}

/** First citation wins, so core evidence never turns into related or response evidence on a later window. */
function mergeEvidence(evidence: IntimacyEvidence[]): IntimacyEvidence[] {
  const byMessage = new Map<number, IntimacyEvidence>()
  for (const item of evidence) {
    if (!byMessage.has(item.messageId)) byMessage.set(item.messageId, item)
  }
  return [...byMessage.values()].sort((left, right) => left.messageId - right.messageId)
}

function normalizeCategories(categories: SharingCategory[]): SharingCategory[] {
  const unique = new Set(categories)
  return SHARING_CATEGORIES.filter((category) => unique.has(category))
}

function mergeDistress(
  previous: SharingDetails['isDistressDisclosure'],
  addition: SharingDetails['isDistressDisclosure']
): SharingDetails['isDistressDisclosure'] {
  if (previous === 'yes' || addition === 'yes') return 'yes'
  if (previous === 'uncertain' || addition === 'uncertain') return 'uncertain'
  return 'no'
}
