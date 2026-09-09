import type {
  GoodNewsResponseDetails,
  IntimacyEvent,
  IntimacyEventDetails,
  IntimacyEventReview,
  IntimacyEventStatus,
  IntimacyEvidence,
  IntimacyMember,
  IntimacyMemberSummary,
  IntimacyModelDecision,
  IntimacyObservation,
  IntimacyResponseMemberSummary,
  ResponseObservation,
  SharingCategory,
  SharingDetails,
  SupportResponseDetails,
} from '@openchatlab/shared-types'
import type { ParsedSharingEvent } from './model-protocol'
import { GOOD_NEWS_RESPONSE_LABELS, SHARING_CATEGORIES, SUPPORT_RESPONSE_LABELS } from './model-protocol'
import type { IntimacySourceMessage, IntimacyWindow } from './source'
import type { IntimacyEventRecord } from './store'

/** A stored K1 event, narrowed so the sharing labels can be read without re-checking the kind. */
type SharingEventRecord = IntimacyEventRecord & { details: SharingDetails }

/**
 * Turn one validated window response into storable events. Timestamps and senders are read back from the
 * window instead of the model response, and a sharing that continues from the previous window is merged into
 * the event that already covers it so one matter is never counted twice.
 */
export function buildSharingEvents(
  parsed: ParsedSharingEvent[],
  window: IntimacyWindow,
  members: [IntimacyMember, IntimacyMember],
  previousWindowEvents: IntimacyEventRecord[],
  createdAt: number
): IntimacyEventRecord[] {
  const windowMessages = new Map(window.messages.map((message) => [message.id, message]))
  const contextIds = new Set(window.messages.slice(0, window.contextCount).map((message) => message.id))
  const events: IntimacyEventRecord[] = []
  const usedAnchors = new Set<string>()
  const usedCoreIds = new Set<number>()

  for (const item of parsed) {
    const coreMessageIds = item.coreMessageIds.filter((messageId) => !usedCoreIds.has(messageId))
    if (coreMessageIds.length === 0) continue
    const subjectMemberId = members[item.discloser === 'A' ? 0 : 1].memberId
    const otherMemberId = members[item.discloser === 'A' ? 1 : 0].memberId
    const evidence = buildEvidence(coreMessageIds, item.relatedMessageIds, windowMessages)
    const details: SharingDetails = {
      kind: 'sharing',
      categories: normalizeCategories(item.categories),
      topic: item.topic,
      isDistressDisclosure: item.distress,
    }
    const modelDecision: IntimacyModelDecision = item.confidence === 'clear' ? 'included' : 'uncertain'
    const continued = item.continuesContextEvent
      ? findContinuedEvent(previousWindowEvents, subjectMemberId, contextIds)
      : null

    if (continued && !usedAnchors.has(continued.id)) {
      events.push(mergeContinuedEvent(continued, { evidence, details, modelDecision, observation: item.observation }))
      usedAnchors.add(continued.id)
      for (const messageId of coreMessageIds) usedCoreIds.add(messageId)
      continue
    }

    const anchorMessageId = Math.min(...coreMessageIds)
    const id = `sharing:${anchorMessageId}`
    if (usedAnchors.has(id)) continue
    usedAnchors.add(id)
    for (const messageId of coreMessageIds) usedCoreIds.add(messageId)
    events.push({
      id,
      kind: 'sharing',
      subjectMemberId,
      otherMemberId,
      anchorMessageId,
      anchorTs: windowMessages.get(anchorMessageId)!.timestamp,
      evidence,
      observation: item.observation,
      origin: 'model',
      modelDecision,
      modelReason: item.reason,
      details,
      createdAt,
    })
  }
  return events
}

export function resolveEventStatus(
  event: Pick<IntimacyEvent, 'origin' | 'modelDecision'>,
  review: IntimacyEventReview | null
): IntimacyEventStatus {
  if (review?.decision === 'excluded') return 'excluded'
  if (review?.decision === 'included') return 'confirmed'
  if (event.origin === 'user') return 'confirmed'
  return event.modelDecision === 'uncertain' ? 'uncertain' : 'auto'
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
      if (event.details.kind === 'sharing' || event.details.responseObservation !== 'visible_response') continue
      for (const label of event.details.responseLabels) byLabel[label] += 1
    }
    const countObservation = (observation: ResponseObservation) =>
      counted.filter((event) => event.details.kind !== 'sharing' && event.details.responseObservation === observation)
        .length
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

function findContinuedEvent(
  previousWindowEvents: IntimacyEventRecord[],
  subjectMemberId: number,
  contextIds: Set<number>
): SharingEventRecord | null {
  const candidates = previousWindowEvents.filter(
    (event): event is SharingEventRecord =>
      event.details.kind === 'sharing' &&
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

function mergeContinuedEvent(
  previous: SharingEventRecord,
  addition: {
    evidence: IntimacyEvidence[]
    details: SharingDetails
    modelDecision: IntimacyModelDecision
    observation: IntimacyObservation
  }
): SharingEventRecord {
  const evidence = [...previous.evidence]
  const seen = new Set(evidence.map((item) => item.messageId))
  for (const item of addition.evidence) {
    if (seen.has(item.messageId)) continue
    seen.add(item.messageId)
    evidence.push(item)
  }
  return {
    ...previous,
    evidence: evidence.sort((left, right) => left.messageId - right.messageId),
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

function buildEvidence(
  coreMessageIds: number[],
  relatedMessageIds: number[],
  windowMessages: Map<number, IntimacySourceMessage>
): IntimacyEvidence[] {
  const evidence: IntimacyEvidence[] = []
  const seen = new Set<number>()
  for (const [messageIds, role] of [
    [coreMessageIds, 'core'],
    [relatedMessageIds, 'related'],
  ] as const) {
    for (const messageId of messageIds) {
      const message = windowMessages.get(messageId)
      if (!message || seen.has(messageId)) continue
      seen.add(messageId)
      evidence.push({ messageId, timestamp: message.timestamp, senderId: message.senderId, role })
    }
  }
  return evidence.sort((left, right) => left.messageId - right.messageId)
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
