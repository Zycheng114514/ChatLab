import { randomUUID } from 'node:crypto'
import {
  getMessagesByIds,
  getMessagesInIdRange,
  getSessionOverview,
  searchMessagesByKeywords,
  type DatabaseAdapter,
  type MappedMessage,
  type PathProvider,
} from '@openchatlab/core'
import {
  IMPLEMENTED_INTIMACY_KINDS,
  type CreateIntimacyEventRequest,
  type IntimacyAnalysisRequest,
  type IntimacyCandidateRequest,
  type IntimacyCandidates,
  type CreateIntimacyEventDetails,
  type FollowUpMatchConfidence,
  type GoodNewsResponseDetails,
  type IntimacyEvent,
  type IntimacyEventReview,
  type IntimacyEvidence,
  type IntimacyEvidenceRole,
  type IntimacyKind,
  type IntimacyKindSummary,
  type IntimacyMember,
  type IntimacyMessageSnippet,
  type IntimacyPreflight,
  type IntimacyResults,
  type IntimacyReviewDetails,
  type IntimacyRun,
  type ResponseObservation,
  type ReviewIntimacyEventRequest,
  type SharingDetails,
  type StartIntimacyRunRequest,
  type SupportResponseDetails,
} from '@openchatlab/shared-types'
import { isRuntimeVersionAtLeast, raiseDataDirMinRuntimeVersion, type RuntimeIdentity } from '../../data-dir-compat'
import { appLogger } from '../../logging/app-logger'
import type { SemanticIndexRuntime } from '../../semantic-index'
import type { SessionRuntimeAdapter } from '../adapters'
import type { ChatTopicModelClient, ChatTopicModelResult } from '../topics/model-client'
import { assertValidTimezone } from '../topics/time'
import { chatTopicWorkCoordinator } from '../topics/work-coordinator'
import {
  INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS,
  applyFollowUpPairing,
  applyReviewDetails,
  buildIntimacyEvents,
  findSharingEventCovering,
  resolveEventStatus,
  summarizeFollowUps,
  summarizeResponses,
  summarizeSharing,
} from './events'
import {
  buildFollowUpMatchPrompt,
  collectFollowUpCandidates,
  parseFollowUpMatch,
  resolveFollowUpInitiation,
  type FollowUpMatch,
  type FollowUpMatchPromptInput,
} from './follow-up-matcher'
import {
  GOOD_NEWS_RESPONSE_LABELS,
  INTIMACY_ALGORITHM_VERSION,
  INTIMACY_PROMPT_VERSION,
  POSITIVE_FOR_SHARER_VALUES,
  SHARING_CATEGORIES,
  SHARING_TOPICS,
  SUPPORT_RESPONSE_LABELS,
  buildIntimacyWindowPrompt,
  parseIntimacyResponse,
  resolveIntimacyPreprocess,
  type IntimacyPreprocessOptions,
} from './model-protocol'
import { getIntimacyDbPath } from './paths'
import {
  estimateIntimacyWindows,
  loadIntimacySource,
  readIntimacySourceFingerprint,
  resolveIntimacyMembers,
  resolveIntimacyRange,
  type IntimacyWindow,
} from './source'
import {
  INTIMACY_USER_RUN_ID,
  IntimacyStore,
  type IntimacyEventRecord,
  type StoredIntimacyEvent,
  type StoredIntimacyReview,
} from './store'

export interface IntimacyServiceDeps {
  runtime: SessionRuntimeAdapter
  pathProvider: PathProvider
  runtimeIdentity: RuntimeIdentity
  getModelClient(): ChatTopicModelClient | null
  semanticIndex?: SemanticIndexRuntime
  nativeBinding?: string
  now?: () => number
  generateId?: () => string
  runtimeId?: string
}

export interface IntimacyService {
  preflight(sessionId: string, request: IntimacyAnalysisRequest): Promise<IntimacyPreflight>
  start(sessionId: string, request: StartIntimacyRunRequest): IntimacyRun
  getRun(sessionId: string, runId: string): IntimacyRun | null
  getLatestRun(sessionId: string): IntimacyRun | null
  pause(sessionId: string, runId: string): IntimacyRun
  resume(sessionId: string, runId: string): IntimacyRun
  cancel(sessionId: string, runId: string): IntimacyRun
  getResults(sessionId: string, range?: IntimacyResultRange): Promise<IntimacyResults>
  searchCandidates(sessionId: string, request: IntimacyCandidateRequest): Promise<IntimacyCandidates>
  createUserEvent(sessionId: string, request: CreateIntimacyEventRequest): Promise<IntimacyResults>
  reviewEvent(sessionId: string, eventId: string, request: ReviewIntimacyEventRequest): Promise<IntimacyResults>
  clearResults(sessionId: string, options: { includeReviews: boolean }): boolean
  close(): void
}

export interface IntimacyResultRange {
  startTs?: number
  endTs?: number
}

interface ActiveExecution {
  runId: string
  controller: AbortController
  requestedStatus: 'paused' | 'cancelled' | 'preempted' | null
  leaseLost: boolean
}

const INTIMACY_EXECUTION_LEASE_DURATION_MS = 30_000
const INTIMACY_EXECUTION_HEARTBEAT_MS = 10_000
const INTIMACY_KEYWORD_CANDIDATE_LIMIT = 30
const INTIMACY_SEMANTIC_CANDIDATE_LIMIT = 10
const INTIMACY_SEMANTIC_BLOCK_MESSAGE_LIMIT = 40
/** How many follow-up questions of one window may be paired by a model call; the rest wait for the user. */
const INTIMACY_FOLLOW_UP_MATCH_CALLS_PER_WINDOW = 10
const INTIMACY_WINDOW_INVALID = 'INTIMACY_WINDOW_INVALID'
const INTIMACY_EXECUTION_LEASE_LOST = 'INTIMACY_EXECUTION_LEASE_LOST'
// Version to publish this store with. The release workflow bumps package metadata later, so the guard below keeps
// local development builds from locking themselves out. TODO: confirm the first published version with the maintainer.
const INTIMACY_MIN_RUNTIME_VERSION = '0.38.0'
const INTIMACY_DATA_COMPATIBILITY_VERSION = 1

export function createIntimacyService(deps: IntimacyServiceDeps): IntimacyService {
  const now = deps.now ?? Date.now
  const generateId = deps.generateId ?? randomUUID
  const runtimeId = deps.runtimeId ?? randomUUID()
  const store = new IntimacyStore(getIntimacyDbPath(deps.pathProvider.getUserDataDir()), {
    nativeBinding: deps.nativeBinding,
  })
  try {
    raiseIntimacyCompatibilityGate(deps.pathProvider, deps.runtimeIdentity)
  } catch (error) {
    store.close()
    throw error
  }
  store.recoverInterruptedRuns(now())
  let activeExecution: ActiveExecution | null = null
  let closed = false
  let storeClosed = false
  let preemptedRunId: string | null = null
  let leaseHeartbeat: { runId: string; timer: ReturnType<typeof setInterval> } | null = null
  const unsubscribeCoordinator = chatTopicWorkCoordinator.subscribe(handleInteractiveStateChange)
  const unsubscribeSessionDelete = chatTopicWorkCoordinator.subscribeSessionDelete(prepareSessionDelete)
  const executionWaiters: Array<{ runId: string; resolve: () => void }> = []

  async function preflight(sessionId: string, request: IntimacyAnalysisRequest): Promise<IntimacyPreflight> {
    assertOpen()
    const kinds = requireImplementedKinds(request.kinds)
    const db = deps.runtime.ensureReadonly(sessionId)
    const members = resolveIntimacyMembers(db)
    const range = resolveIntimacyRange(db, request)
    const estimate = estimateIntimacyWindows(db, range)
    return {
      sessionId,
      members,
      targetStartTs: range.startTs,
      targetEndTs: range.endTs,
      messageCount: estimate.messageCount,
      textMessageCount: estimate.textMessageCount,
      estimatedWindows: estimate.estimatedWindows,
      // One call per window, plus the follow-up pairing calls the window may need (about one per window).
      estimatedCalls: estimate.estimatedWindows * 2,
      modelId: deps.getModelClient()?.modelId ?? null,
      semanticSearchAvailable: await canSearchSemantically(sessionId),
      kinds,
    }
  }

  function start(sessionId: string, request: StartIntimacyRunRequest): IntimacyRun {
    const modelClient = requireModelClient()
    const kinds = requireImplementedKinds(request.kinds)
    const timezone = resolveRequestTimezone(request.timezone)
    const source = loadIntimacySource(deps.runtime.ensureReadonly(sessionId), request)
    store.recoverInterruptedRuns(now())
    const active = store.getActiveRun()
    if (active) {
      throw Object.assign(new Error(`An intimacy analysis is already ${active.status}`), {
        statusCode: 409,
        activeRun: active,
      })
    }
    const timestamp = now()
    const run: IntimacyRun = {
      id: generateId(),
      sessionId,
      status: source.windows.length === 0 ? 'completed' : 'pending',
      kinds,
      locale: request.locale ?? null,
      timezone,
      targetStartTs: source.targetStartTs,
      targetEndTs: source.targetEndTs,
      sourceSignature: source.sourceSignature,
      sourceMessageCount: source.sourceMessageCount,
      sourceMaxMessageId: source.sourceMaxMessageId,
      totalWindows: source.windows.length,
      completedWindows: 0,
      currentWindowIndex: null,
      failedWindowIndexes: [],
      modelId: modelClient.modelId,
      promptVersion: INTIMACY_PROMPT_VERSION,
      algorithmVersion: INTIMACY_ALGORITHM_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    store.createRun(run, resolveIntimacyPreprocess(request.preprocessConfig))
    if (run.status === 'pending') {
      if (!acquireExecutionLease(run.id)) {
        store.updateRun({ ...run, status: 'cancelled', lastError: 'Another runtime owns intimacy analysis' })
        const competing = store.getActiveRun()
        throw Object.assign(new Error('Another ChatLab runtime is already analysing intimacy events'), {
          statusCode: 409,
          activeRun: competing,
        })
      }
      launch(run.id)
    }
    return run
  }

  function getRun(sessionId: string, runId: string): IntimacyRun | null {
    store.recoverInterruptedRuns(now())
    const run = store.getRun(runId)
    return run?.sessionId === sessionId ? run : null
  }

  function getLatestRun(sessionId: string): IntimacyRun | null {
    store.recoverInterruptedRuns(now())
    return store.getLatestRun(sessionId)
  }

  function pause(sessionId: string, runId: string): IntimacyRun {
    const run = requireRun(sessionId, runId)
    if (run.status === 'pending' && activeExecution?.runId !== runId) {
      requireExecutionLease(runId)
      if (preemptedRunId === runId) preemptedRunId = null
      return updateRun(run, { status: 'paused' })
    }
    if (run.status !== 'running' && run.status !== 'pending') return run
    if (activeExecution?.runId === runId) {
      preemptedRunId = null
      activeExecution.requestedStatus = 'paused'
      activeExecution.controller.abort()
      return run
    }
    requireExecutionLease(runId)
    return updateRun(run, { status: 'paused' })
  }

  function resume(sessionId: string, runId: string): IntimacyRun {
    const run = requireRun(sessionId, runId)
    if (run.status !== 'paused' && run.status !== 'failed') return run
    requireModelClient()
    const active = store.getActiveRun()
    if (active && active.id !== runId) {
      throw Object.assign(new Error(`An intimacy analysis is already ${active.status}`), { statusCode: 409 })
    }
    if (!acquireExecutionLease(runId)) {
      throw Object.assign(new Error('Another ChatLab runtime is already analysing intimacy events'), {
        statusCode: 409,
      })
    }
    try {
      const resumed = updateRun(run, { status: 'pending', lastError: null })
      launch(runId)
      return resumed
    } catch (error) {
      releaseExecutionLease(runId)
      throw error
    }
  }

  function cancel(sessionId: string, runId: string): IntimacyRun {
    const run = requireRun(sessionId, runId)
    if (run.status === 'completed' || run.status === 'cancelled') return run
    if (activeExecution?.runId === runId) {
      preemptedRunId = null
      activeExecution.requestedStatus = 'cancelled'
      activeExecution.controller.abort()
      return run
    }
    if (!acquireExecutionLease(runId)) {
      throw Object.assign(new Error('Another ChatLab runtime is already analysing intimacy events'), {
        statusCode: 409,
      })
    }
    return updateRun(run, { status: 'cancelled' })
  }

  /** One call returns every implemented kind: a single window call coded them all, and the page shows them together. */
  async function getResults(sessionId: string, range?: IntimacyResultRange): Promise<IntimacyResults> {
    assertOpen()
    const db = deps.runtime.ensureReadonly(sessionId)
    const members = resolveIntimacyMembers(db)
    const latestRun = store.getLatestRun(sessionId)
    const resultRun = store.getLatestRunWithResults(sessionId)
    const reviews = new Map(store.listReviews(sessionId).map((review) => [review.eventId, toReview(review)]))
    const runEvents = resultRun ? store.listEvents(sessionId, resultRun.id) : []
    const runEventIds = new Set(runEvents.map((event) => event.id))
    const userEvents = store.listEvents(sessionId, INTIMACY_USER_RUN_ID).filter((event) => !runEventIds.has(event.id))

    const stored = [...runEvents, ...userEvents]
    const messages = loadEvidenceSnippets(db, stored)
    // A decision on an event outside the requested range still has an event behind it, so it is not orphaned.
    const storedIds = new Set(stored.map((event) => event.id))
    const events = stored
      .map((event) => toIntimacyEvent(event, reviews.get(event.id) ?? null, messages))
      .filter((event) => withinRange(event.anchorTs, range))
      .sort((left, right) => left.anchorTs - right.anchorTs || left.anchorMessageId - right.anchorMessageId)

    const coverageRun = resultRun ?? latestRun
    return {
      run: resultRun,
      latestRun,
      members,
      coverage: coverageRun ? buildCoverage(db, coverageRun) : null,
      events,
      messages: Object.fromEntries(
        events.flatMap((event) =>
          event.evidence.flatMap((evidence) => {
            const snippet = messages.get(evidence.messageId)
            return snippet ? [[evidence.messageId, snippet] as const] : []
          })
        )
      ),
      summaries: buildSummaries(events, members),
      orphanReviews: [...reviews.keys()].filter((eventId) => !storedIds.has(eventId)).length,
      semanticSearchAvailable: await canSearchSemantically(sessionId),
      modelId: deps.getModelClient()?.modelId ?? null,
    }
  }

  async function searchCandidates(sessionId: string, request: IntimacyCandidateRequest): Promise<IntimacyCandidates> {
    assertOpen()
    requireImplementedKinds([request.kind])
    const query = request.query.trim()
    if (query === '') throw Object.assign(new Error('A candidate search needs a query'), { statusCode: 400 })
    const db = deps.runtime.ensureReadonly(sessionId)
    const keyword = searchMessagesByKeywords(db, [query], {
      startTs: request.startTs,
      endTs: request.endTs,
      limit: INTIMACY_KEYWORD_CANDIDATE_LIMIT,
      sort: 'desc',
    })
    const semanticAvailable = await canSearchSemantically(sessionId)
    const semantic =
      semanticAvailable && deps.semanticIndex
        ? await deps.semanticIndex.search(sessionId, query, {
            finalTopK: INTIMACY_SEMANTIC_CANDIDATE_LIMIT,
            timeRangeMs: {
              startTs: request.startTs === undefined ? undefined : request.startTs * 1000,
              endTs: request.endTs === undefined ? undefined : request.endTs * 1000,
            },
          })
        : null

    return {
      keyword: keyword.messages.map((message) => ({
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
        timestamp: message.timestamp,
        type: message.type,
        content: message.type === 0 ? message.content : '',
      })),
      semantic: (semantic?.blocks ?? []).map((block) => ({
        score: block.score,
        messages: getMessagesInIdRange(
          db,
          block.startMessageId,
          block.endMessageId,
          INTIMACY_SEMANTIC_BLOCK_MESSAGE_LIMIT
        ).map(toSnippet),
      })),
      semanticAvailable,
    }
  }

  async function createUserEvent(sessionId: string, request: CreateIntimacyEventRequest): Promise<IntimacyResults> {
    assertOpen()
    const [kind] = requireImplementedKinds([request.kind])
    const db = deps.runtime.ensureReadonly(sessionId)
    const members = resolveIntimacyMembers(db)
    const subject = members.find((member) => member.memberId === request.subjectMemberId)
    if (!subject) {
      throw Object.assign(new Error('The selected participant is not part of this chat'), { statusCode: 400 })
    }
    const other = members.find((member) => member.memberId !== subject.memberId)!
    const coreMessageIds = [...new Set(request.coreMessageIds)]
    if (coreMessageIds.length === 0) {
      throw Object.assign(new Error('A confirmed event needs at least one message'), { statusCode: 400 })
    }
    const relatedMessageIds = [...new Set(request.relatedMessageIds ?? [])].filter(
      (messageId) => !coreMessageIds.includes(messageId)
    )
    // A sharing event has no reply of its own; the reply belongs to the response kinds.
    const responseMessageIds = kind === 'sharing' ? [] : [...new Set(request.responseMessageIds ?? [])]
    const found = new Map(
      getMessagesByIds(db, [...coreMessageIds, ...relatedMessageIds, ...responseMessageIds]).map((m) => [m.id, m])
    )
    for (const messageId of coreMessageIds) {
      const message = found.get(messageId)
      if (!message) {
        throw Object.assign(new Error(`Message ${messageId} is not part of this chat`), { statusCode: 400 })
      }
      if (message.senderId !== subject.memberId) {
        throw Object.assign(new Error(`Message ${messageId} was not sent by the selected participant`), {
          statusCode: 400,
        })
      }
      if (message.type !== 0 || message.content === '') {
        throw Object.assign(new Error(`Message ${messageId} has no readable text`), { statusCode: 400 })
      }
    }
    for (const messageId of relatedMessageIds) {
      if (!found.has(messageId)) {
        throw Object.assign(new Error(`Message ${messageId} is not part of this chat`), { statusCode: 400 })
      }
    }

    const timestamp = now()
    // A message supports one event per kind: confirming messages that already carry one relabels that event
    // instead of counting the same matter twice.
    const resultRun = store.getLatestRunWithResults(sessionId)
    const currentEvents = [
      ...(resultRun ? store.listEvents(sessionId, resultRun.id) : []),
      ...store.listEvents(sessionId, INTIMACY_USER_RUN_ID),
    ]
    const coreEvidence = coreMessageIds
      .map((messageId) => toEvidence(found.get(messageId)!, 'core'))
      .sort((left, right) => left.messageId - right.messageId)

    if (kind === 'sharing') {
      const record: IntimacyEventRecord = {
        id: `sharing:${coreEvidence[0]!.messageId}`,
        kind: 'sharing',
        subjectMemberId: subject.memberId,
        otherMemberId: other.memberId,
        anchorMessageId: coreEvidence[0]!.messageId,
        anchorTs: coreEvidence[0]!.timestamp,
        evidence: [
          ...coreEvidence,
          ...relatedMessageIds.map((messageId) => toEvidence(found.get(messageId)!, 'related')),
        ].sort((left, right) => left.messageId - right.messageId),
        observation: 'sufficient',
        origin: 'user',
        modelDecision: null,
        modelReason: null,
        details: requireSharingDetails(request.details),
        createdAt: timestamp,
      }
      confirmEvent(sessionId, record, { currentEvents, coreMessageIds, timestamp })
      return getResults(sessionId)
    }

    if (kind === 'follow_up') {
      throw Object.assign(new Error('A confirmed follow-up question needs the earlier message it asks about'), {
        statusCode: 400,
      })
    }

    // K2 counts a reply to a disclosure, so the disclosure has to exist as a K1 event of its own.
    const disclosure =
      kind === 'support_response'
        ? ensureDisclosureEvent(sessionId, currentEvents, {
            subject,
            other,
            coreEvidence,
            relatedEvidence: relatedMessageIds.map((messageId) => toEvidence(found.get(messageId)!, 'related')),
            timestamp,
          })
        : null
    const anchorMessageId = disclosure?.anchorMessageId ?? coreEvidence[0]!.messageId
    const responseEvidence = responseMessageIds.map((messageId) => {
      const message = found.get(messageId)
      if (!message) {
        throw Object.assign(new Error(`Message ${messageId} is not part of this chat`), { statusCode: 400 })
      }
      if (message.senderId !== other.memberId) {
        throw Object.assign(new Error(`Message ${messageId} was not sent by the other participant`), {
          statusCode: 400,
        })
      }
      if (messageId <= anchorMessageId) {
        throw Object.assign(new Error(`Message ${messageId} does not follow the message it answers`), {
          statusCode: 400,
        })
      }
      return toEvidence(message, 'response')
    })
    const details = disclosure
      ? buildConfirmedSupportDetails(disclosure.id, request.details, responseEvidence.length)
      : buildConfirmedGoodNewsDetails(request.details, responseEvidence.length)
    const anchorEvidence = (disclosure?.evidence ?? coreEvidence).filter((evidence) => evidence.role === 'core')
    const record: IntimacyEventRecord = {
      id: `${kind}:${anchorMessageId}`,
      kind,
      subjectMemberId: subject.memberId,
      otherMemberId: other.memberId,
      anchorMessageId,
      anchorTs: disclosure?.anchorTs ?? coreEvidence[0]!.timestamp,
      evidence: [...anchorEvidence, ...responseEvidence].sort((left, right) => left.messageId - right.messageId),
      observation: 'sufficient',
      origin: 'user',
      modelDecision: null,
      modelReason: null,
      details,
      createdAt: timestamp,
    }
    confirmEvent(sessionId, record, { currentEvents, coreMessageIds, timestamp })
    return getResults(sessionId)
  }

  /** Write the confirmed event, or turn the confirmation into a decision on the event that already covers it. */
  function confirmEvent(
    sessionId: string,
    record: IntimacyEventRecord,
    context: {
      currentEvents: StoredIntimacyEvent[]
      coreMessageIds: number[]
      timestamp: number
    }
  ): void {
    const overlapping = findOverlappingEvent(context.currentEvents, record.kind, record.id, context.coreMessageIds)
    if (!overlapping) {
      store.createUserEvent(sessionId, record)
      return
    }
    const current = store.listReviews(sessionId).find((review) => review.eventId === overlapping.id)
    store.upsertReview(
      sessionId,
      overlapping.id,
      'included',
      JSON.stringify(toReviewDetails(record)),
      current?.revision ?? 0,
      context.timestamp
    )
  }

  /** The K1 event a confirmed support response answers; a disclosure the user coded by hand is created here. */
  function ensureDisclosureEvent(
    sessionId: string,
    currentEvents: StoredIntimacyEvent[],
    input: {
      subject: IntimacyMember
      other: IntimacyMember
      coreEvidence: IntimacyEvidence[]
      relatedEvidence: IntimacyEvidence[]
      timestamp: number
    }
  ): { id: string; anchorMessageId: number; anchorTs: number; evidence: IntimacyEvidence[] } {
    const anchor = input.coreEvidence[0]!
    const existing = findOverlappingEvent(
      currentEvents,
      'sharing',
      `sharing:${anchor.messageId}`,
      input.coreEvidence.map((evidence) => evidence.messageId)
    )
    if (existing) return existing
    const record: IntimacyEventRecord = {
      id: `sharing:${anchor.messageId}`,
      kind: 'sharing',
      subjectMemberId: input.subject.memberId,
      otherMemberId: input.other.memberId,
      anchorMessageId: anchor.messageId,
      anchorTs: anchor.timestamp,
      evidence: [...input.coreEvidence, ...input.relatedEvidence].sort(
        (left, right) => left.messageId - right.messageId
      ),
      observation: 'sufficient',
      origin: 'user',
      modelDecision: null,
      modelReason: null,
      // The user confirmed a reply to it, so the disclosure itself is the worry or need that triggered the reply.
      details: { kind: 'sharing', categories: ['worry_or_need'], topic: 'other', isDistressDisclosure: 'yes' },
      createdAt: input.timestamp,
    }
    store.createUserEvent(sessionId, record)
    return record
  }

  async function reviewEvent(
    sessionId: string,
    eventId: string,
    request: ReviewIntimacyEventRequest
  ): Promise<IntimacyResults> {
    assertOpen()
    if (request.decision !== 'included' && request.decision !== 'excluded') {
      throw Object.assign(new Error(`Unsupported review decision: ${String(request.decision)}`), { statusCode: 400 })
    }
    const results = await getResults(sessionId)
    const event = results.events.find((item) => item.id === eventId)
    if (!event) {
      throw Object.assign(new Error(`Intimacy event not found: ${eventId}`), { statusCode: 404 })
    }
    const details = request.details ? requireRevisableDetails(event, request.details) : null
    const review = store.upsertReview(
      sessionId,
      eventId,
      request.decision,
      details ? JSON.stringify(details) : null,
      request.expectedRevision,
      now()
    )
    if (!review) throw Object.assign(new Error('Review revision conflict'), { statusCode: 409 })
    return getResults(sessionId)
  }

  function clearResults(sessionId: string, options: { includeReviews: boolean }): boolean {
    assertOpen()
    store.recoverInterruptedRuns(now())
    const active = store.getActiveRun()
    if (active?.sessionId === sessionId) {
      throw Object.assign(new Error('Cancel the active intimacy analysis before clearing its results'), {
        statusCode: 409,
      })
    }
    return store.deleteSessionResults(sessionId, options)
  }

  function close(): void {
    if (closed) return
    closed = true
    unsubscribeCoordinator()
    unsubscribeSessionDelete()
    if (activeExecution) {
      activeExecution.requestedStatus = 'paused'
      activeExecution.controller.abort()
      return
    }
    if (preemptedRunId) {
      const pending = store.getRun(preemptedRunId)
      if (pending && store.ownsExecutionLease(pending.id, runtimeId, now())) {
        updateRun(pending, { status: 'paused' })
      }
      preemptedRunId = null
    }
    stopLeaseHeartbeat()
    closeStore()
  }

  function launch(runId: string): void {
    if (activeExecution) {
      throw Object.assign(new Error('An intimacy analysis is already executing'), { statusCode: 409 })
    }
    if (chatTopicWorkCoordinator.isInteractiveActive) {
      preemptedRunId = runId
      return
    }
    const execution: ActiveExecution = {
      runId,
      controller: new AbortController(),
      requestedStatus: null,
      leaseLost: false,
    }
    activeExecution = execution
    queueMicrotask(() => {
      void executeRun(execution).finally(() => {
        if (activeExecution === execution) activeExecution = null
        resolveExecutionWaiters(execution.runId)
        resumePreemptedRun()
        if (closed) closeStore()
      })
    })
  }

  async function executeRun(execution: ActiveExecution): Promise<void> {
    let run = store.getRun(execution.runId)
    if (!run) return
    if (execution.leaseLost) return
    if (execution.controller.signal.aborted) {
      finishRun(run, {
        status: execution.requestedStatus === 'preempted' ? 'pending' : (execution.requestedStatus ?? 'paused'),
      })
      return
    }
    const modelClient = deps.getModelClient()
    if (!modelClient) {
      finishRun(run, { status: 'failed', lastError: 'LLM service is not configured' })
      return
    }
    run = updateRun(run, { status: 'running', modelId: modelClient.modelId, lastError: null })
    appLogger.info('intimacy', 'intimacy analysis started', {
      runId: run.id,
      sessionId: run.sessionId,
      totalWindows: run.totalWindows,
    })

    try {
      const source = loadIntimacySource(deps.runtime.ensureReadonly(run.sessionId), {
        kinds: run.kinds,
        startTs: run.targetStartTs,
        endTs: run.targetEndTs,
      })
      if (source.sourceSignature !== run.sourceSignature) {
        throw new Error('Chat messages changed since the analysis started')
      }
      const preprocess = store.getRunPreprocess(run.id) ?? undefined
      const startWindow = Math.min(run.completedWindows, source.windows.length)
      const committedEvents: IntimacyEventRecord[] = startWindow === 0 ? [] : store.listEvents(run.sessionId, run.id)
      let previousWindowEvents: IntimacyEventRecord[] = committedEvents
      // The matter a follow-up asks about is looked for among the sharings this run has already coded.
      const codedSharings = new Map<string, IntimacyEventRecord>(
        committedEvents.filter((event) => event.kind === 'sharing').map((event) => [event.id, event])
      )
      const chatStartTs = getSessionOverview(deps.runtime.ensureReadonly(run.sessionId)).firstMessageTs ?? 0
      const semanticAvailable = await canSearchSemantically(run.sessionId)
      const failedWindowIndexes = [...run.failedWindowIndexes]

      for (let index = startWindow; index < source.windows.length; index += 1) {
        execution.controller.signal.throwIfAborted()
        const window = source.windows[index]!
        run = updateRun(run, { currentWindowIndex: index })
        const prompts = buildIntimacyWindowPrompt({
          window,
          members: source.members,
          totalWindows: source.windows.length,
          timezone: run.timezone,
          locale: run.locale ?? undefined,
          preprocess,
        })
        let events: IntimacyEventRecord[]
        try {
          const result = await completeValidated(
            run,
            modelClient,
            prompts,
            execution.controller.signal,
            (text) =>
              buildIntimacyEvents(
                parseIntimacyResponse(text, window, source.members),
                window,
                source.members,
                previousWindowEvents,
                now()
              ),
            `intimacy:${run.sessionId}:${index}`
          )
          run = result.run
          events = result.value
        } catch (error) {
          if ((error as { code?: string } | null)?.code !== INTIMACY_WINDOW_INVALID) throw error
          run = (error as { run?: IntimacyRun }).run ?? run
          failedWindowIndexes.push(index)
          // The window is skipped rather than failing the whole analysis; coverage reports it as incomplete.
          appLogger.warn('intimacy', 'intimacy analysis skipped an unreadable window', {
            runId: run.id,
            sessionId: run.sessionId,
            windowIndex: index,
          })
          run = updateRun(run, { completedWindows: index + 1, failedWindowIndexes, currentWindowIndex: null })
          previousWindowEvents = []
          continue
        }
        // Stage B runs before the window is committed, so a question and the pairing it got are stored together.
        const paired = await resolveFollowUpPairings(execution, modelClient, run, events, {
          window,
          members: source.members,
          codedSharings: [...codedSharings.values()],
          chatStartTs,
          semanticAvailable,
          timezone: run.timezone,
          preprocess,
        })
        run = paired.run
        store.insertWindowEvents(run.sessionId, run.id, paired.events, executionLeaseGuard())
        previousWindowEvents = paired.events
        for (const event of paired.events) {
          if (event.kind === 'sharing') codedSharings.set(event.id, event)
        }
        run = updateRun(run, { completedWindows: index + 1, currentWindowIndex: null })
      }

      run = finishRun(run, { status: 'completed', currentWindowIndex: null })
      appLogger.info('intimacy', 'intimacy analysis completed', {
        runId: run.id,
        sessionId: run.sessionId,
        totalWindows: run.totalWindows,
        modelCalls: run.modelCalls,
      })
    } catch (error) {
      if (execution.leaseLost || isExecutionLeaseLostError(error)) {
        appLogger.warn('intimacy', 'intimacy analysis stopped after execution lease was lost', {
          runId: execution.runId,
        })
        return
      }
      const latest = store.getRun(run.id) ?? run
      const requestedStatus = execution.requestedStatus
      const status = requestedStatus === 'preempted' ? 'pending' : (requestedStatus ?? 'failed')
      const message = requestedStatus ? null : error instanceof Error ? error.message : String(error)
      finishRun(latest, { status, lastError: message, currentWindowIndex: null })
      if (!requestedStatus) appLogger.error('intimacy', 'intimacy analysis failed', error)
    }
  }

  /**
   * Stage B of the follow-up coding. A question whose earlier matter was not visible in its own window gets a
   * server-built candidate list — the sharings coded so far, a keyword search and the semantic index — and one
   * model call that may only choose from it. A match that cannot be read stays unmatched instead of failing the
   * window: the question is kept for the user to pair by hand. The initiation is decided here from the record.
   */
  async function resolveFollowUpPairings(
    execution: ActiveExecution,
    modelClient: ChatTopicModelClient,
    initialRun: IntimacyRun,
    events: IntimacyEventRecord[],
    context: {
      window: IntimacyWindow
      members: [IntimacyMember, IntimacyMember]
      codedSharings: IntimacyEventRecord[]
      chatStartTs: number
      semanticAvailable: boolean
      timezone: string
      preprocess?: IntimacyPreprocessOptions
    }
  ): Promise<{ run: IntimacyRun; events: IntimacyEventRecord[] }> {
    let run = initialRun
    if (!events.some((event) => event.kind === 'follow_up')) return { run, events }
    const db = deps.runtime.ensureReadonly(run.sessionId)
    const knownEvents = [...context.codedSharings, ...events]
    const windowMessages = new Map(context.window.messages.map((message) => [message.id, message]))
    const resolved: IntimacyEventRecord[] = []
    let matchCalls = 0

    for (const event of events) {
      if (event.kind !== 'follow_up' || event.details.kind !== 'follow_up') {
        resolved.push(event)
        continue
      }
      execution.controller.signal.throwIfAborted()
      const askedMemberId = event.subjectMemberId
      const details = event.details
      let prior = event.evidence.filter((evidence) => evidence.role === 'prior')
      let matchConfidence: FollowUpMatchConfidence = prior.length > 0 ? 'supported' : 'uncertain'
      let candidateMessageIds: number[] = []
      let lookbackStartTs = Math.max(event.anchorTs - INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS, context.chatStartTs)

      if (prior.length === 0 && matchCalls < INTIMACY_FOLLOW_UP_MATCH_CALLS_PER_WINDOW) {
        const collected = await collectFollowUpCandidates({
          db,
          sessionId: run.sessionId,
          askedMemberId,
          followUp: {
            messageId: event.anchorMessageId,
            timestamp: event.anchorTs,
            matter: details.matter,
            matterKeywords: details.matterKeywords,
          },
          codedEvents: knownEvents,
          chatStartTs: context.chatStartTs,
          semanticIndex: deps.semanticIndex,
          semanticAvailable: context.semanticAvailable,
        })
        lookbackStartTs = collected.lookbackStartTs
        candidateMessageIds = collected.candidates.map((candidate) => candidate.id)
        if (collected.candidates.length > 0) {
          matchCalls += 1
          const question = event.evidence
            .filter((evidence) => evidence.role === 'core')
            .flatMap((evidence) => {
              const message = windowMessages.get(evidence.messageId)
              return message ? [message] : []
            })
          const matched = await matchFollowUp(run, modelClient, execution, {
            prompt: {
              members: context.members,
              question,
              matter: details.matter,
              candidates: collected.candidates,
              askedMemberId,
              timezone: context.timezone,
              preprocess: context.preprocess,
            },
            anchorMessageId: event.anchorMessageId,
          })
          run = matched.run
          if (matched.value && matched.value.priorMessageIds.length > 0) {
            prior = matched.value.priorMessageIds.flatMap((messageId) => {
              const candidate = collected.candidates.find((item) => item.id === messageId)
              return candidate
                ? [
                    {
                      messageId,
                      timestamp: candidate.timestamp,
                      senderId: candidate.senderId,
                      role: 'prior' as const,
                    },
                  ]
                : []
            })
            matchConfidence = matched.value.match
          }
        }
      }

      const priorAnchor = prior.length === 0 ? null : prior.reduce((a, b) => (a.messageId <= b.messageId ? a : b))
      const priorEventId = priorAnchor
        ? findSharingEventCovering(knownEvents, priorAnchor.messageId, askedMemberId)
        : null
      const priorEvent = priorEventId ? knownEvents.find((item) => item.id === priorEventId) : null
      resolved.push(
        applyFollowUpPairing(event, {
          priorEvidence: prior,
          priorEventId,
          matchConfidence,
          initiation: resolveFollowUpInitiation({
            db,
            askedMemberId,
            prior: priorAnchor && { messageId: priorAnchor.messageId, timestamp: priorAnchor.timestamp },
            followUp: { messageId: event.anchorMessageId, timestamp: event.anchorTs },
            matterKeywords: details.matterKeywords,
            priorEventEvidence: priorEvent?.evidence ?? [],
          }),
          candidateMessageIds,
          lookbackStartTs,
        })
      )
    }
    return { run, events: resolved }
  }

  /** One matching call. An unreadable answer costs the pairing, never the window it belongs to. */
  async function matchFollowUp(
    run: IntimacyRun,
    modelClient: ChatTopicModelClient,
    execution: ActiveExecution,
    input: { prompt: FollowUpMatchPromptInput; anchorMessageId: number }
  ): Promise<{ run: IntimacyRun; value: FollowUpMatch | null }> {
    try {
      const result = await completeValidated(
        run,
        modelClient,
        buildFollowUpMatchPrompt(input.prompt),
        execution.controller.signal,
        (text) =>
          parseFollowUpMatch(text, {
            candidates: input.prompt.candidates,
            askedMemberId: input.prompt.askedMemberId,
            anchorMessageId: input.anchorMessageId,
          }),
        `intimacy:${run.sessionId}:follow-up:${input.anchorMessageId}`
      )
      return { run: result.run, value: result.value }
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== INTIMACY_WINDOW_INVALID) throw error
      appLogger.warn('intimacy', 'intimacy analysis could not pair a follow-up question', {
        runId: run.id,
        sessionId: run.sessionId,
        anchorMessageId: input.anchorMessageId,
      })
      return { run: (error as { run?: IntimacyRun }).run ?? run, value: null }
    }
  }

  /** Terminal transitions drop superseded runs so results always come from a single generation. */
  function finishRun(run: IntimacyRun, updates: Partial<IntimacyRun>): IntimacyRun {
    const updated = updateRun(run, updates)
    if (updated.status === 'pending' || updated.status === 'running') return updated
    if (updated.completedWindows > 0) store.pruneRuns(updated.sessionId, updated.id)
    return updated
  }

  async function completeValidated<T>(
    initialRun: IntimacyRun,
    modelClient: ChatTopicModelClient,
    prompts: { systemPrompt: string; userPrompt: string },
    signal: AbortSignal,
    validate: (text: string) => T,
    sessionId: string
  ): Promise<{ run: IntimacyRun; value: T }> {
    let run = initialRun
    let lastValidationError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptPrompts =
        attempt === 0
          ? prompts
          : {
              ...prompts,
              userPrompt: `${prompts.userPrompt}\n\nYour previous response was invalid: ${validationErrorMessage(lastValidationError)}. Return corrected compact JSON only, citing only message IDs from this window.`,
            }
      const response = await modelClient.complete(attemptPrompts, { signal, sessionId })
      run = recordModelUsage(run, response)
      try {
        return { run, value: validate(response.text) }
      } catch (error) {
        if (isExecutionLeaseLostError(error)) throw error
        lastValidationError = error
      }
    }
    throw Object.assign(
      lastValidationError instanceof Error ? lastValidationError : new Error('Invalid intimacy model response'),
      { code: INTIMACY_WINDOW_INVALID, run }
    )
  }

  function recordModelUsage(run: IntimacyRun, result: ChatTopicModelResult): IntimacyRun {
    return updateRun(run, {
      inputTokens: run.inputTokens + result.inputTokens,
      outputTokens: run.outputTokens + result.outputTokens,
      modelCalls: run.modelCalls + 1,
    })
  }

  function buildCoverage(db: DatabaseAdapter, run: IntimacyRun): NonNullable<IntimacyResults['coverage']> {
    const fingerprint = readIntimacySourceFingerprint(db, {
      startTs: run.targetStartTs,
      endTs: run.targetEndTs,
    })
    return {
      targetStartTs: run.targetStartTs,
      targetEndTs: run.targetEndTs,
      totalWindows: run.totalWindows,
      completedWindows: run.completedWindows,
      failedWindows: run.failedWindowIndexes.length,
      complete: run.completedWindows === run.totalWindows && run.failedWindowIndexes.length === 0,
      sourceChanged:
        fingerprint.messageCount !== run.sourceMessageCount || fingerprint.maxMessageId !== run.sourceMaxMessageId,
    }
  }

  function loadEvidenceSnippets(
    db: DatabaseAdapter,
    events: StoredIntimacyEvent[]
  ): Map<number, IntimacyMessageSnippet> {
    const messageIds = [...new Set(events.flatMap((event) => event.evidence.map((item) => item.messageId)))]
    return new Map(getMessagesByIds(db, messageIds).map((message) => [message.id, toSnippet(message)]))
  }

  function toIntimacyEvent(
    event: StoredIntimacyEvent,
    review: IntimacyEventReview | null,
    messages: Map<number, IntimacyMessageSnippet>
  ): IntimacyEvent {
    return {
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId === INTIMACY_USER_RUN_ID ? null : event.runId,
      kind: event.kind,
      subjectMemberId: event.subjectMemberId,
      otherMemberId: event.otherMemberId,
      anchorMessageId: event.anchorMessageId,
      anchorTs: event.anchorTs,
      evidence: event.evidence,
      observation: event.observation,
      origin: event.origin,
      modelDecision: event.modelDecision,
      modelReason: event.modelReason,
      details: applyReviewDetails(event.details, review),
      review,
      status: resolveEventStatus(event, review),
      stale: event.evidence.some((evidence) => !messages.has(evidence.messageId)),
    }
  }

  async function canSearchSemantically(sessionId: string): Promise<boolean> {
    if (!deps.semanticIndex) return false
    return (await deps.semanticIndex.canSearch(sessionId)) === true
  }

  function acquireExecutionLease(runId: string): boolean {
    const acquired = store.tryAcquireExecutionLease(
      runId,
      runtimeId,
      now(),
      now() + INTIMACY_EXECUTION_LEASE_DURATION_MS
    )
    if (acquired) startLeaseHeartbeat(runId)
    return acquired
  }

  function startLeaseHeartbeat(runId: string): void {
    stopLeaseHeartbeat()
    const timer = setInterval(() => {
      if (closed || storeClosed) return
      const renewed = store.renewExecutionLease(runId, runtimeId, now() + INTIMACY_EXECUTION_LEASE_DURATION_MS)
      if (renewed) return
      stopLeaseHeartbeat(runId)
      if (preemptedRunId === runId) preemptedRunId = null
      if (activeExecution?.runId === runId) {
        activeExecution.leaseLost = true
        activeExecution.controller.abort()
      }
    }, INTIMACY_EXECUTION_HEARTBEAT_MS)
    timer.unref?.()
    leaseHeartbeat = { runId, timer }
  }

  function stopLeaseHeartbeat(runId?: string): void {
    if (!leaseHeartbeat || (runId && leaseHeartbeat.runId !== runId)) return
    clearInterval(leaseHeartbeat.timer)
    leaseHeartbeat = null
  }

  function releaseExecutionLease(runId: string): void {
    stopLeaseHeartbeat(runId)
    store.releaseExecutionLease(runId, runtimeId)
  }

  function requireExecutionLease(runId: string): void {
    if (store.ownsExecutionLease(runId, runtimeId, now())) return
    throw Object.assign(new Error('This intimacy analysis is active in another ChatLab runtime'), { statusCode: 409 })
  }

  function executionLeaseGuard() {
    return { ownerId: runtimeId, now: now() }
  }

  function updateRun(run: IntimacyRun, updates: Partial<IntimacyRun>): IntimacyRun {
    const updated = { ...run, ...updates, updatedAt: now() }
    if (!store.updateRunIfOwned(updated, executionLeaseGuard())) {
      throw Object.assign(new Error('Intimacy execution lease was lost'), { code: INTIMACY_EXECUTION_LEASE_LOST })
    }
    if (['completed', 'failed', 'paused', 'cancelled'].includes(updated.status)) {
      releaseExecutionLease(updated.id)
    }
    return updated
  }

  function requireRun(sessionId: string, runId: string): IntimacyRun {
    const run = getRun(sessionId, runId)
    if (!run) throw Object.assign(new Error(`Intimacy run not found: ${runId}`), { statusCode: 404 })
    return run
  }

  function requireModelClient(): ChatTopicModelClient {
    assertOpen()
    const client = deps.getModelClient()
    if (!client) throw Object.assign(new Error('LLM service is not configured'), { statusCode: 400 })
    return client
  }

  function assertOpen(): void {
    if (closed) throw new Error('Intimacy service is closed')
  }

  function closeStore(): void {
    if (storeClosed) return
    stopLeaseHeartbeat()
    storeClosed = true
    store.close()
  }

  function handleInteractiveStateChange(active: boolean): void {
    if (closed) return
    if (active) {
      if (activeExecution && activeExecution.requestedStatus === null) {
        preemptedRunId = activeExecution.runId
        activeExecution.requestedStatus = 'preempted'
        activeExecution.controller.abort()
      }
      return
    }
    resumePreemptedRun()
  }

  function resumePreemptedRun(): void {
    if (closed || chatTopicWorkCoordinator.isInteractiveActive || activeExecution || !preemptedRunId) return
    const runId = preemptedRunId
    const pending = store.getRun(runId)
    if (pending?.status !== 'pending' || !store.ownsExecutionLease(runId, runtimeId, now())) {
      preemptedRunId = null
      return
    }
    preemptedRunId = null
    launch(runId)
  }

  async function prepareSessionDelete(sessionId: string): Promise<void> {
    const preemptedRun = preemptedRunId ? store.getRun(preemptedRunId) : null
    if (preemptedRun?.sessionId === sessionId) preemptedRunId = null
    if (activeExecution) {
      const activeRun = store.getRun(activeExecution.runId)
      if (activeRun?.sessionId === sessionId) {
        activeExecution.requestedStatus = 'cancelled'
        activeExecution.controller.abort()
        await waitForExecution(activeExecution.runId)
      }
    }
    const activeRun = store.getActiveRun()
    if (activeRun?.sessionId === sessionId) {
      cancel(sessionId, activeRun.id)
    }
  }

  function waitForExecution(runId: string): Promise<void> {
    if (activeExecution?.runId !== runId) return Promise.resolve()
    return new Promise((resolve) => executionWaiters.push({ runId, resolve }))
  }

  function resolveExecutionWaiters(runId: string): void {
    for (let index = executionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = executionWaiters[index]
      if (waiter?.runId !== runId) continue
      executionWaiters.splice(index, 1)
      waiter.resolve()
    }
  }

  return {
    preflight,
    start,
    getRun,
    getLatestRun,
    pause,
    resume,
    cancel,
    getResults,
    searchCandidates,
    createUserEvent,
    reviewEvent,
    clearResults,
    close,
  }
}

/** One summary per implemented kind, so the page can show every card without asking for each kind. */
function buildSummaries(events: IntimacyEvent[], members: IntimacyMember[]): IntimacyKindSummary[] {
  return [
    { kind: 'sharing', members: summarizeSharing(events, members) },
    { kind: 'support_response', members: summarizeResponses(events, members, 'support_response') },
    { kind: 'follow_up', members: summarizeFollowUps(events, members) },
    { kind: 'good_news_response', members: summarizeResponses(events, members, 'good_news_response') },
  ]
}

function raiseIntimacyCompatibilityGate(pathProvider: PathProvider, runtime: RuntimeIdentity): void {
  // The source branch still reports the last released version until the release workflow bumps package metadata.
  // Do not make local development builds block themselves.
  if (!isRuntimeVersionAtLeast(runtime.version, INTIMACY_MIN_RUNTIME_VERSION)) return
  raiseDataDirMinRuntimeVersion(pathProvider, {
    minRuntimeVersion: INTIMACY_MIN_RUNTIME_VERSION,
    dataCompatibilityVersion: INTIMACY_DATA_COMPATIBILITY_VERSION,
    reason: 'intimacy-store',
    runtime,
    module: 'intimacy',
  })
}

/** The model reads message times in the caller's zone; an unset zone keeps the stored default. */
function resolveRequestTimezone(timezone: string | undefined): string {
  const resolved = timezone ?? 'UTC'
  assertValidTimezone(resolved)
  return resolved
}

function requireImplementedKinds(kinds: IntimacyKind[] | undefined): IntimacyKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw Object.assign(new Error('Intimacy analysis requires at least one kind'), { statusCode: 400 })
  }
  for (const kind of kinds) {
    if (!IMPLEMENTED_INTIMACY_KINDS.includes(kind)) {
      throw Object.assign(new Error(`Unsupported intimacy kind: ${String(kind)}`), { statusCode: 400 })
    }
  }
  return [...new Set(kinds)]
}

/** An event of the same kind already built on these messages; the same matter is never counted twice. */
function findOverlappingEvent(
  events: StoredIntimacyEvent[],
  kind: IntimacyKind,
  eventId: string,
  coreMessageIds: number[]
): StoredIntimacyEvent | undefined {
  return events.find(
    (event) =>
      event.kind === kind &&
      (event.id === eventId || event.evidence.some((evidence) => coreMessageIds.includes(evidence.messageId)))
  )
}

function buildConfirmedSupportDetails(
  disclosureEventId: string,
  details: CreateIntimacyEventDetails,
  responseCount: number
): SupportResponseDetails {
  const responseLabels = requirePartialSupportDetails(details).responseLabels ?? []
  return {
    kind: 'support_response',
    disclosureEventId,
    responseLabels,
    responseObservation: resolveConfirmedObservation(responseCount, responseLabels.length),
  }
}

function buildConfirmedGoodNewsDetails(
  details: CreateIntimacyEventDetails,
  responseCount: number
): GoodNewsResponseDetails {
  const revised = requirePartialGoodNewsDetails(details)
  const responseLabels = revised.responseLabels ?? []
  return {
    kind: 'good_news_response',
    positiveForSharer: revised.positiveForSharer ?? 'uncertain',
    responseLabels,
    responseObservation: resolveConfirmedObservation(responseCount, responseLabels.length),
  }
}

/**
 * A user confirming a response sees the whole chat, so the reply is either there with labels or not there at all.
 * A reply nobody selected is recorded as "no visible response", never as a label about how it went.
 */
function resolveConfirmedObservation(responseCount: number, labelCount: number): ResponseObservation {
  if (responseCount > 0 && labelCount > 0) return 'visible_response'
  if (responseCount === 0 && labelCount === 0) return 'no_visible_response'
  throw Object.assign(new Error('A confirmed response needs both the reply messages and how they answered'), {
    statusCode: 400,
  })
}

/** The revisable part of an event, used when a confirmation lands on an event that already exists. */
function toReviewDetails(record: IntimacyEventRecord): IntimacyReviewDetails {
  const details = record.details
  if (details.kind === 'sharing') {
    return { categories: details.categories, topic: details.topic, isDistressDisclosure: details.isDistressDisclosure }
  }
  if (details.kind === 'support_response') return { responseLabels: details.responseLabels }
  if (details.kind === 'good_news_response') {
    return { positiveForSharer: details.positiveForSharer, responseLabels: details.responseLabels }
  }
  return {
    priorMessageIds: record.evidence
      .filter((evidence) => evidence.role === 'prior')
      .map((evidence) => evidence.messageId),
    priorEventId: details.priorEventId,
    matchConfidence: details.matchConfidence,
    initiationInObservedRecord: details.initiationInObservedRecord,
    gapSeconds: details.gapSeconds,
    matter: details.matter,
  }
}

/** A revision may only touch the fields of the kind it is about, and only label a reply that was seen. */
function requireRevisableDetails(event: IntimacyEvent, details: IntimacyReviewDetails): IntimacyReviewDetails {
  if (event.details.kind === 'sharing') return requirePartialSharingDetails(details)
  if (event.details.kind === 'follow_up') {
    throw Object.assign(new Error('A follow-up revision needs the earlier messages it asks about'), {
      statusCode: 400,
    })
  }
  const revised =
    event.details.kind === 'support_response'
      ? requirePartialSupportDetails(details)
      : requirePartialGoodNewsDetails(details)
  if ((revised.responseLabels?.length ?? 0) > 0 && event.details.responseObservation !== 'visible_response') {
    throw Object.assign(new Error('Response labels need a visible response'), { statusCode: 400 })
  }
  return revised
}

function requirePartialSupportDetails(
  details: IntimacyReviewDetails | CreateIntimacyEventDetails
): Partial<Omit<SupportResponseDetails, 'kind'>> {
  const revised = details as Partial<Omit<SupportResponseDetails, 'kind'>>
  if (revised.responseLabels === undefined) return {}
  return { responseLabels: requireLabels(revised.responseLabels, SUPPORT_RESPONSE_LABELS, 'support response labels') }
}

function requirePartialGoodNewsDetails(
  details: IntimacyReviewDetails | CreateIntimacyEventDetails
): Partial<Omit<GoodNewsResponseDetails, 'kind'>> {
  const revised = details as Partial<Omit<GoodNewsResponseDetails, 'kind'>>
  const result: Partial<Omit<GoodNewsResponseDetails, 'kind'>> = {}
  if (revised.responseLabels !== undefined) {
    result.responseLabels = requireLabels(
      revised.responseLabels,
      GOOD_NEWS_RESPONSE_LABELS,
      'good news response labels'
    )
  }
  if (revised.positiveForSharer !== undefined) {
    if (!POSITIVE_FOR_SHARER_VALUES.includes(revised.positiveForSharer)) {
      throw Object.assign(new Error(`Invalid good news value: ${String(revised.positiveForSharer)}`), {
        statusCode: 400,
      })
    }
    result.positiveForSharer = revised.positiveForSharer
  }
  return result
}

function requireLabels<T extends string>(value: T[], allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.some((label) => !allowed.includes(label))) {
    throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 })
  }
  const unique = new Set(value)
  return allowed.filter((label) => unique.has(label))
}

function requireSharingDetails(details: CreateIntimacyEventDetails): SharingDetails {
  const partial = requirePartialSharingDetails(details as Partial<Omit<SharingDetails, 'kind'>>)
  if (!partial.categories || partial.categories.length === 0) {
    throw Object.assign(new Error('A confirmed event needs at least one category'), { statusCode: 400 })
  }
  return {
    kind: 'sharing',
    categories: partial.categories,
    topic: partial.topic ?? 'other',
    isDistressDisclosure: partial.isDistressDisclosure ?? 'uncertain',
  }
}

function requirePartialSharingDetails(details: IntimacyReviewDetails): Partial<Omit<SharingDetails, 'kind'>> {
  const result: Partial<Omit<SharingDetails, 'kind'>> = {}
  const revised = details as Partial<Omit<SharingDetails, 'kind'>>
  if (revised.categories !== undefined) {
    if (!Array.isArray(revised.categories) || revised.categories.some((c) => !SHARING_CATEGORIES.includes(c))) {
      throw Object.assign(new Error('Invalid sharing categories'), { statusCode: 400 })
    }
    result.categories = [...new Set(revised.categories)]
  }
  if (revised.topic !== undefined) {
    if (!SHARING_TOPICS.includes(revised.topic)) {
      throw Object.assign(new Error(`Invalid sharing topic: ${String(revised.topic)}`), { statusCode: 400 })
    }
    result.topic = revised.topic
  }
  if (revised.isDistressDisclosure !== undefined) {
    if (!['yes', 'no', 'uncertain'].includes(revised.isDistressDisclosure)) {
      throw Object.assign(new Error('Invalid distress disclosure value'), { statusCode: 400 })
    }
    result.isDistressDisclosure = revised.isDistressDisclosure
  }
  return result
}

function withinRange(anchorTs: number, range?: IntimacyResultRange): boolean {
  if (range?.startTs !== undefined && anchorTs < range.startTs) return false
  return !(range?.endTs !== undefined && anchorTs > range.endTs)
}

function toSnippet(message: MappedMessage): IntimacyMessageSnippet {
  return {
    messageId: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    timestamp: message.timestamp,
    type: message.type,
    content: message.type === 0 ? message.content : '',
  }
}

function toEvidence(message: MappedMessage, role: IntimacyEvidenceRole): IntimacyEvidence {
  return { messageId: message.id, timestamp: message.timestamp, senderId: message.senderId, role }
}

function toReview(review: StoredIntimacyReview): IntimacyEventReview {
  return { decision: review.decision, details: review.details, revision: review.revision, updatedAt: review.updatedAt }
}

function isExecutionLeaseLostError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === INTIMACY_EXECUTION_LEASE_LOST
}

function validationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500)
}
