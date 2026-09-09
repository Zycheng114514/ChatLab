import { randomUUID } from 'node:crypto'
import {
  getMessagesByIds,
  getMessagesInIdRange,
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
  type IntimacyEvent,
  type IntimacyEventReview,
  type IntimacyKind,
  type IntimacyMessageSnippet,
  type IntimacyPreflight,
  type IntimacyResults,
  type IntimacyRun,
  type ReviewIntimacyEventRequest,
  type SharingDetails,
  type StartIntimacyRunRequest,
} from '@openchatlab/shared-types'
import { isRuntimeVersionAtLeast, raiseDataDirMinRuntimeVersion, type RuntimeIdentity } from '../../data-dir-compat'
import { appLogger } from '../../logging/app-logger'
import type { SemanticIndexRuntime } from '../../semantic-index'
import type { SessionRuntimeAdapter } from '../adapters'
import type { ChatTopicModelClient, ChatTopicModelResult } from '../topics/model-client'
import { assertValidTimezone } from '../topics/time'
import { chatTopicWorkCoordinator } from '../topics/work-coordinator'
import { applyReviewDetails, buildSharingEvents, resolveEventStatus, summarizeSharing } from './events'
import {
  INTIMACY_ALGORITHM_VERSION,
  INTIMACY_PROMPT_VERSION,
  SHARING_CATEGORIES,
  SHARING_TOPICS,
  buildSharingWindowPrompt,
  parseSharingResponse,
  resolveIntimacyPreprocess,
} from './model-protocol'
import { getIntimacyDbPath } from './paths'
import {
  estimateIntimacyWindows,
  loadIntimacySource,
  readIntimacySourceFingerprint,
  resolveIntimacyMembers,
  resolveIntimacyRange,
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
  getResults(sessionId: string, kind: IntimacyKind, range?: IntimacyResultRange): Promise<IntimacyResults>
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
      estimatedCalls: estimate.estimatedWindows,
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

  async function getResults(
    sessionId: string,
    kind: IntimacyKind,
    range?: IntimacyResultRange
  ): Promise<IntimacyResults> {
    assertOpen()
    requireImplementedKinds([kind])
    const db = deps.runtime.ensureReadonly(sessionId)
    const members = resolveIntimacyMembers(db)
    const latestRun = store.getLatestRun(sessionId)
    const resultRun = store.getLatestRunWithResults(sessionId)
    const reviews = new Map(store.listReviews(sessionId).map((review) => [review.eventId, toReview(review)]))
    const runEvents = resultRun ? store.listEvents(sessionId, kind, resultRun.id) : []
    const runEventIds = new Set(runEvents.map((event) => event.id))
    const userEvents = store
      .listEvents(sessionId, kind, INTIMACY_USER_RUN_ID)
      .filter((event) => !runEventIds.has(event.id))

    const messages = loadEvidenceSnippets(db, [...runEvents, ...userEvents])
    const events = [...runEvents, ...userEvents]
      .map((event) => toIntimacyEvent(event, reviews.get(event.id) ?? null, messages))
      .filter((event) => withinRange(event.anchorTs, range))
      .sort((left, right) => left.anchorTs - right.anchorTs || left.anchorMessageId - right.anchorMessageId)
    const eventIds = new Set(events.map((event) => event.id))

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
      summary: {
        kind,
        members: summarizeSharing(events, members),
        orphanReviews: [...reviews.keys()].filter((eventId) => !eventIds.has(eventId)).length,
      },
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
    if (request.kind !== 'sharing') {
      throw Object.assign(new Error(`Unsupported intimacy kind: ${String(request.kind)}`), { statusCode: 400 })
    }
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
    const details = requireSharingDetails(request.details)
    const found = new Map(getMessagesByIds(db, [...coreMessageIds, ...relatedMessageIds]).map((m) => [m.id, m]))
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

    const anchorMessageId = Math.min(...coreMessageIds)
    const eventId = `sharing:${anchorMessageId}`
    const timestamp = now()
    const existing = store.getLatestRunWithResults(sessionId)
    const alreadyGenerated =
      existing && store.listEvents(sessionId, 'sharing', existing.id).some((event) => event.id === eventId)
    if (alreadyGenerated) {
      const current = store.listReviews(sessionId).find((review) => review.eventId === eventId)
      store.upsertReview(sessionId, eventId, 'included', null, current?.revision ?? 0, timestamp)
    } else {
      store.createUserEvent(sessionId, {
        id: eventId,
        kind: 'sharing',
        subjectMemberId: subject.memberId,
        otherMemberId: other.memberId,
        anchorMessageId,
        anchorTs: found.get(anchorMessageId)!.timestamp,
        evidence: [
          ...coreMessageIds.map((messageId) => toEvidence(found.get(messageId)!, 'core')),
          ...relatedMessageIds.map((messageId) => toEvidence(found.get(messageId)!, 'related')),
        ].sort((left, right) => left.messageId - right.messageId),
        observation: 'sufficient',
        origin: 'user',
        modelDecision: null,
        modelReason: null,
        details,
        createdAt: timestamp,
      })
    }
    return getResults(sessionId, 'sharing')
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
    const results = await getResults(sessionId, 'sharing')
    if (!results.events.some((event) => event.id === eventId)) {
      throw Object.assign(new Error(`Intimacy event not found: ${eventId}`), { statusCode: 404 })
    }
    const details = request.details ? requirePartialSharingDetails(request.details) : null
    const review = store.upsertReview(
      sessionId,
      eventId,
      request.decision,
      details ? JSON.stringify(details) : null,
      request.expectedRevision,
      now()
    )
    if (!review) throw Object.assign(new Error('Review revision conflict'), { statusCode: 409 })
    return getResults(sessionId, 'sharing')
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
      let previousWindowEvents: IntimacyEventRecord[] =
        startWindow === 0 ? [] : store.listEvents(run.sessionId, 'sharing', run.id)
      const failedWindowIndexes = [...run.failedWindowIndexes]

      for (let index = startWindow; index < source.windows.length; index += 1) {
        execution.controller.signal.throwIfAborted()
        const window = source.windows[index]!
        run = updateRun(run, { currentWindowIndex: index })
        const prompts = buildSharingWindowPrompt({
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
              buildSharingEvents(
                parseSharingResponse(text, window, source.members),
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
        store.insertWindowEvents(run.sessionId, run.id, events, executionLeaseGuard())
        previousWindowEvents = events
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

function requireSharingDetails(details: Omit<SharingDetails, 'kind'>): SharingDetails {
  const partial = requirePartialSharingDetails(details)
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

function requirePartialSharingDetails(
  details: Partial<Omit<SharingDetails, 'kind'>>
): Partial<Omit<SharingDetails, 'kind'>> {
  const result: Partial<Omit<SharingDetails, 'kind'>> = {}
  if (details.categories !== undefined) {
    if (!Array.isArray(details.categories) || details.categories.some((c) => !SHARING_CATEGORIES.includes(c))) {
      throw Object.assign(new Error('Invalid sharing categories'), { statusCode: 400 })
    }
    result.categories = [...new Set(details.categories)]
  }
  if (details.topic !== undefined) {
    if (!SHARING_TOPICS.includes(details.topic)) {
      throw Object.assign(new Error(`Invalid sharing topic: ${String(details.topic)}`), { statusCode: 400 })
    }
    result.topic = details.topic
  }
  if (details.isDistressDisclosure !== undefined) {
    if (!['yes', 'no', 'uncertain'].includes(details.isDistressDisclosure)) {
      throw Object.assign(new Error('Invalid distress disclosure value'), { statusCode: 400 })
    }
    result.isDistressDisclosure = details.isDistressDisclosure
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

function toEvidence(message: MappedMessage, role: 'core' | 'related') {
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
