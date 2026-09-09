import type { FastifyInstance } from 'fastify'
import { createChatTopicModelClient, createIntimacyService, type IntimacyService } from '@openchatlab/node-runtime'
import {
  IMPLEMENTED_INTIMACY_KINDS,
  type CreateIntimacyEventRequest,
  type IntimacyAnalysisRequest,
  type IntimacyCandidateRequest,
  type IntimacyKind,
  type ReviewIntimacyEventRequest,
  type SharingDetails,
  type StartIntimacyRunRequest,
} from '@openchatlab/shared-types'
import type { AiRouteContext } from '../../context/ai'
import type { RuntimeRouteContext } from '../../context/runtime'

type IntimacyRouteContext = Pick<
  RuntimeRouteContext,
  'sessionAdapter' | 'pathProvider' | 'runtimeIdentity' | 'nativeBinding'
> &
  Pick<AiRouteContext, 'llmConfigStore' | 'semanticIndexService'>

export function registerAiIntimacyRoutes(server: FastifyInstance, ctx: IntimacyRouteContext): void {
  let service: IntimacyService | null = null
  const getService = () => {
    if (!ctx.runtimeIdentity) throw new Error('Intimacy routes require a runtime identity')
    service ??= createIntimacyService({
      runtime: ctx.sessionAdapter,
      pathProvider: ctx.pathProvider,
      runtimeIdentity: ctx.runtimeIdentity,
      nativeBinding: ctx.nativeBinding,
      semanticIndex: ctx.semanticIndexService,
      getModelClient() {
        const config = ctx.llmConfigStore?.getFastModelConfig()
        return config ? createChatTopicModelClient(config) : null
      },
    })
    return service
  }

  server.addHook('onClose', async () => {
    service?.close()
  })

  server.post<{ Params: { id: string }; Body: IntimacyAnalysisRequest }>(
    '/_web/sessions/:id/intimacy/preflight',
    async (request) => getService().preflight(request.params.id, requireAnalysisRequest(request.body))
  )

  server.post<{ Params: { id: string }; Body: StartIntimacyRunRequest }>(
    '/_web/sessions/:id/intimacy/runs',
    async (request, reply) => {
      const run = getService().start(request.params.id, {
        ...requireAnalysisRequest(request.body),
        preprocessConfig: requirePreprocessConfig(request.body?.preprocessConfig),
      })
      return reply.code(run.status === 'completed' ? 200 : 202).send(run)
    }
  )

  server.get<{ Params: { id: string } }>('/_web/sessions/:id/intimacy/runs/latest', async (request) =>
    getService().getLatestRun(request.params.id)
  )

  server.get<{ Params: { id: string; runId: string } }>(
    '/_web/sessions/:id/intimacy/runs/:runId',
    async (request, reply) => {
      const run = getService().getRun(request.params.id, request.params.runId)
      return run ?? reply.code(404).send({ error: 'Intimacy run not found' })
    }
  )

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    server.post<{ Params: { id: string; runId: string } }>(
      `/_web/sessions/:id/intimacy/runs/:runId/${action}`,
      async (request) => getService()[action](request.params.id, request.params.runId)
    )
  }

  server.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    '/_web/sessions/:id/intimacy/results',
    async (request) => getService().getResults(request.params.id, requireKind(request.query.kind))
  )

  server.post<{ Params: { id: string }; Body: IntimacyCandidateRequest }>(
    '/_web/sessions/:id/intimacy/candidates',
    async (request) => getService().searchCandidates(request.params.id, requireCandidateRequest(request.body))
  )

  server.post<{ Params: { id: string }; Body: CreateIntimacyEventRequest }>(
    '/_web/sessions/:id/intimacy/events',
    async (request) => getService().createUserEvent(request.params.id, requireCreateEventRequest(request.body))
  )

  server.put<{ Params: { id: string; eventId: string }; Body: ReviewIntimacyEventRequest }>(
    '/_web/sessions/:id/intimacy/events/:eventId/review',
    async (request) =>
      getService().reviewEvent(request.params.id, request.params.eventId, requireReviewRequest(request.body))
  )

  server.delete<{ Params: { id: string }; Querystring: { reviews?: string } }>(
    '/_web/sessions/:id/intimacy/results',
    async (request) => ({
      success: getService().clearResults(request.params.id, { includeReviews: request.query.reviews === '1' }),
    })
  )
}

function requireAnalysisRequest(value: IntimacyAnalysisRequest | undefined): IntimacyAnalysisRequest {
  return {
    kinds: requireKinds(value?.kinds),
    startTs: optionalTimestamp(value?.startTs, 'startTs'),
    endTs: optionalTimestamp(value?.endTs, 'endTs'),
    locale: typeof value?.locale === 'string' ? value.locale : undefined,
    timezone: typeof value?.timezone === 'string' ? value.timezone : undefined,
  }
}

function requireCandidateRequest(value: IntimacyCandidateRequest | undefined): IntimacyCandidateRequest {
  if (typeof value?.query !== 'string' || value.query.trim() === '') {
    throw Object.assign(new Error('A candidate search needs a query'), { statusCode: 400 })
  }
  return {
    kind: requireKind(value.kind),
    query: value.query,
    startTs: optionalTimestamp(value.startTs, 'startTs'),
    endTs: optionalTimestamp(value.endTs, 'endTs'),
  }
}

function requireCreateEventRequest(value: CreateIntimacyEventRequest | undefined): CreateIntimacyEventRequest {
  if (requireKind(value?.kind) !== 'sharing') {
    throw Object.assign(new Error('Unsupported intimacy kind'), { statusCode: 400 })
  }
  if (!Number.isInteger(value?.subjectMemberId)) {
    throw Object.assign(new Error('A confirmed event needs a participant'), { statusCode: 400 })
  }
  return {
    kind: 'sharing',
    subjectMemberId: value!.subjectMemberId,
    coreMessageIds: requireMessageIds(value?.coreMessageIds, 'coreMessageIds'),
    relatedMessageIds:
      value?.relatedMessageIds === undefined
        ? undefined
        : requireMessageIds(value.relatedMessageIds, 'relatedMessageIds'),
    details: requireObject(value?.details, 'details') as Omit<SharingDetails, 'kind'>,
  }
}

function requireReviewRequest(value: ReviewIntimacyEventRequest | undefined): ReviewIntimacyEventRequest {
  if (value?.decision !== 'included' && value?.decision !== 'excluded') {
    throw Object.assign(new Error('A review needs a decision'), { statusCode: 400 })
  }
  if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw Object.assign(new Error('A review needs the revision it is based on'), { statusCode: 400 })
  }
  return {
    decision: value.decision,
    expectedRevision: value.expectedRevision,
    details: value.details === undefined ? undefined : requireObject(value.details, 'details'),
  }
}

function requireKinds(value: unknown): IntimacyKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw Object.assign(new Error('Intimacy analysis requires at least one kind'), { statusCode: 400 })
  }
  return value.map((kind) => requireKind(kind))
}

function requireKind(value: unknown): IntimacyKind {
  if (typeof value !== 'string' || !IMPLEMENTED_INTIMACY_KINDS.includes(value as IntimacyKind)) {
    throw Object.assign(new Error(`Unsupported intimacy kind: ${String(value)}`), { statusCode: 400 })
  }
  return value as IntimacyKind
}

function requireMessageIds(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((id) => !Number.isInteger(id))) {
    throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 })
  }
  return value as number[]
}

function requireObject<T>(value: T | undefined, field: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 })
  }
  return value
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isFinite(value)) throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 })
  return Number(value)
}

function requirePreprocessConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return requireObject(value as Record<string, unknown>, 'preprocessConfig')
}
