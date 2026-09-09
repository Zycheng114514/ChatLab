import type {
  CreateIntimacyEventRequest,
  FollowUpDetails,
  GoodNewsResponseDetails,
  GoodNewsResponseLabel,
  IntimacyAnalysisRequest,
  IntimacyCandidateRequest,
  IntimacyCandidates,
  IntimacyEvent,
  IntimacyEventDetails,
  IntimacyEventStatus,
  IntimacyKind,
  IntimacyKindSummary,
  IntimacyMember,
  IntimacyMemberSummary,
  IntimacyMessageSnippet,
  IntimacyPreflight,
  IntimacyResponseMemberSummary,
  IntimacyResults,
  IntimacyReviewDetails,
  IntimacyRun,
  ResponseObservation,
  ReviewIntimacyEventRequest,
  SharingCategory,
  SharingDetails,
  SharingTopic,
  StartIntimacyRunRequest,
  SupportResponseDetails,
  SupportResponseLabel,
} from '@openchatlab/shared-types'

/** 结果按事件锚点过滤的范围（秒），来自页面时间筛选 */
export interface IntimacyResultRange {
  startTs?: number
  endTs?: number
}

export interface IntimacyAdapter {
  preflight(sessionId: string, request: IntimacyAnalysisRequest): Promise<IntimacyPreflight>
  start(sessionId: string, request: StartIntimacyRunRequest): Promise<IntimacyRun>
  getLatestRun(sessionId: string): Promise<IntimacyRun | null>
  getRun(sessionId: string, runId: string): Promise<IntimacyRun>
  pause(sessionId: string, runId: string): Promise<IntimacyRun>
  resume(sessionId: string, runId: string): Promise<IntimacyRun>
  cancel(sessionId: string, runId: string): Promise<IntimacyRun>
  /** 一次返回所有已实现 kind 的事件与汇总，页面自己拆给各张卡片 */
  getResults(sessionId: string, range?: IntimacyResultRange): Promise<IntimacyResults>
  searchCandidates(sessionId: string, request: IntimacyCandidateRequest): Promise<IntimacyCandidates>
  createUserEvent(sessionId: string, request: CreateIntimacyEventRequest): Promise<IntimacyResults>
  reviewEvent(sessionId: string, eventId: string, request: ReviewIntimacyEventRequest): Promise<IntimacyResults>
  clearResults(sessionId: string, options: { includeReviews: boolean }): Promise<boolean>
}

/**
 * Carries the HTTP status so callers can tell a stale review (409) from other failures
 * and reload instead of showing a generic error.
 */
export class IntimacyRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'IntimacyRequestError'
    this.status = status
  }
}

export type {
  CreateIntimacyEventRequest,
  FollowUpDetails,
  GoodNewsResponseDetails,
  GoodNewsResponseLabel,
  IntimacyAnalysisRequest,
  IntimacyCandidateRequest,
  IntimacyCandidates,
  IntimacyEvent,
  IntimacyEventDetails,
  IntimacyEventStatus,
  IntimacyKind,
  IntimacyKindSummary,
  IntimacyMember,
  IntimacyMemberSummary,
  IntimacyMessageSnippet,
  IntimacyPreflight,
  IntimacyResponseMemberSummary,
  IntimacyResults,
  IntimacyReviewDetails,
  IntimacyRun,
  ResponseObservation,
  ReviewIntimacyEventRequest,
  SharingCategory,
  SharingDetails,
  SharingTopic,
  StartIntimacyRunRequest,
  SupportResponseDetails,
  SupportResponseLabel,
}
