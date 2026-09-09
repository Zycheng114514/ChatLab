export type IntimacyKind =
  | 'sharing'
  | 'support_response'
  | 'follow_up'
  | 'good_news_response'
  | 'shared_plan'
  | 'repair_attempt'

/** 已实现 K1 个人分享、K2 倾诉后的回应、K4 好消息回应；其余值先占位，服务端对未实现的 kind 返回 400 */
export const IMPLEMENTED_INTIMACY_KINDS: readonly IntimacyKind[] = ['sharing', 'support_response', 'good_news_response']

export type IntimacyRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type IntimacyEventOrigin = 'model' | 'user'
export type IntimacyModelDecision = 'included' | 'uncertain'
export type IntimacyReviewDecision = 'included' | 'excluded'
export type IntimacyObservation = 'sufficient' | 'boundary_limited' | 'media_missing'
/** 展示状态（服务端派生）：auto 自动识别、uncertain 待核对、confirmed 用户确认、excluded 已排除 */
export type IntimacyEventStatus = 'auto' | 'uncertain' | 'confirmed' | 'excluded'
/** response = 另一方针对锚点消息的回复 */
export type IntimacyEvidenceRole = 'core' | 'related' | 'response'

export interface IntimacyMember {
  memberId: number
  name: string
  isOwner: boolean
}

/** 所有 *Ts 字段为秒（与 TimeFilter、聊天库一致）；run 的 createdAt/updatedAt 为毫秒（与 ChatTopicRun 一致） */
export interface IntimacyAnalysisRequest {
  startTs?: number
  endTs?: number
  kinds: IntimacyKind[]
  locale?: string
  /** IANA time zone name (e.g. 'Asia/Shanghai') the model reads message times in; defaults to 'UTC' */
  timezone?: string
}

export interface StartIntimacyRunRequest extends IntimacyAnalysisRequest {
  preprocessConfig?: Record<string, unknown>
}

export interface IntimacyPreflight {
  sessionId: string
  /** 恰好 2 人 */
  members: IntimacyMember[]
  /** 解析后的目标范围（含） */
  targetStartTs: number
  /** 含 */
  targetEndTs: number
  /** 范围内非系统消息数 */
  messageCount: number
  textMessageCount: number
  estimatedWindows: number
  /** = estimatedWindows */
  estimatedCalls: number
  /** null = 未配置 LLM */
  modelId: string | null
  semanticSearchAvailable: boolean
  /** 本次将分析的 kind（已过滤为已实现的） */
  kinds: IntimacyKind[]
}

export interface IntimacyRun {
  id: string
  sessionId: string
  status: IntimacyRunStatus
  kinds: IntimacyKind[]
  locale: string | null
  /** IANA time zone name the run's prompts render message times in */
  timezone: string
  targetStartTs: number
  targetEndTs: number
  /** sha256，同话题算法 */
  sourceSignature: string
  sourceMessageCount: number
  sourceMaxMessageId: number
  totalWindows: number
  completedWindows: number
  currentWindowIndex: number | null
  failedWindowIndexes: number[]
  modelId: string | null
  promptVersion: string
  algorithmVersion: string
  inputTokens: number
  outputTokens: number
  modelCalls: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type SharingCategory = 'experience_or_update' | 'feeling' | 'worry_or_need'
export type SharingTopic = 'work_study' | 'health' | 'family' | 'relationships' | 'daily_life' | 'other'

export interface SharingDetails {
  kind: 'sharing'
  /** 非空，多标签 */
  categories: SharingCategory[]
  topic: SharingTopic
  /** 只为 K2 触发预留，不是心理判断 */
  isDistressDisclosure: 'yes' | 'no' | 'uncertain'
}

/** K2 回复方式，多标签；「嗯」「抱抱」这类语境不足的回复只给 unclear */
export type SupportResponseLabel =
  | 'acknowledges_feeling'
  | 'addresses_situation'
  | 'asks_details'
  | 'offers_advice_or_help'
  | 'shares_related_experience'
  | 'unclear'

/** K4 回复方式，多标签；explicitly_diminishes 必须有明确贬低的原话 */
export type GoodNewsResponseLabel =
  | 'congratulates_or_affirms'
  | 'asks_or_elaborates'
  | 'explicitly_diminishes'
  | 'other_visible_response'
  | 'unclear'

/** 回复观察；缺失的回复永远单列，不映射到任何负面标签 */
export type ResponseObservation = 'visible_response' | 'no_visible_response' | 'insufficient_context'

export interface SupportResponseDetails {
  kind: 'support_response'
  /** 对应的 K1 倾诉事件 id（`sharing:<anchorMessageId>`） */
  disclosureEventId: string
  /** 恰好在 responseObservation 为 visible_response 时非空 */
  responseLabels: SupportResponseLabel[]
  responseObservation: ResponseObservation
}

export interface GoodNewsResponseDetails {
  kind: 'good_news_response'
  /** 对分享者本人是否明确是好事 */
  positiveForSharer: 'explicit_or_context_supported' | 'uncertain'
  /** 恰好在 responseObservation 为 visible_response 时非空 */
  responseLabels: GoodNewsResponseLabel[]
  responseObservation: ResponseObservation
}

export type IntimacyEventDetails = SharingDetails | SupportResponseDetails | GoodNewsResponseDetails

/** 用户改写的标签；服务端按事件 kind 校验，只接受该 kind 可改写的字段 */
export type IntimacyReviewDetails =
  | Partial<Omit<SharingDetails, 'kind'>>
  | Partial<Omit<SupportResponseDetails, 'kind'>>
  | Partial<Omit<GoodNewsResponseDetails, 'kind'>>

export interface IntimacyEvidence {
  messageId: number
  timestamp: number
  senderId: number
  role: IntimacyEvidenceRole
}

export interface IntimacyEventReview {
  decision: IntimacyReviewDecision
  /** 用户改写的标签（覆盖显示与计数） */
  details: IntimacyReviewDetails | null
  revision: number
  updatedAt: number
}

export interface IntimacyEvent {
  /** `${kind}:${anchorMessageId}`，会话内稳定身份，跨重跑关联修订 */
  id: string
  sessionId: string
  /** 用户确认候选生成的事件为 null */
  runId: string | null
  kind: IntimacyKind
  /** K1 = 分享者，K2 = 倾诉者，K4 = 好消息的分享者 */
  subjectMemberId: number
  /** K2 / K4 = 回复方 */
  otherMemberId: number
  anchorMessageId: number
  anchorTs: number
  evidence: IntimacyEvidence[]
  observation: IntimacyObservation
  origin: IntimacyEventOrigin
  /** origin=user 时 null */
  modelDecision: IntimacyModelDecision | null
  /** ≤ 300 字符，模型输出语言 = locale */
  modelReason: string | null
  /** 已应用 review.details 覆盖后的最终值 */
  details: IntimacyEventDetails
  review: IntimacyEventReview | null
  status: IntimacyEventStatus
  /** 任一证据消息在聊天库中已不存在 */
  stale: boolean
}

export interface IntimacyMessageSnippet {
  messageId: number
  senderId: number
  senderName: string
  timestamp: number
  type: number
  /** 原文（非文本消息给空串） */
  content: string
}

export interface IntimacyMemberSummary {
  memberId: number
  /** status ∈ {auto, confirmed} */
  counted: number
  autoCount: number
  confirmedCount: number
  uncertainCount: number
  /** 每事件每标签一次，和可大于 counted */
  byCategory: Record<SharingCategory, number>
}

export interface SharingSummary {
  kind: 'sharing'
  members: IntimacyMemberSummary[]
}

/** 回复方的计数；每个计入的事件恰好有一种观察，所以三项之和 = anchors */
export interface IntimacyResponseMemberSummary {
  /** 回复方 */
  memberId: number
  /** 另一方的倾诉 / 好消息事件数（status ∈ auto、confirmed） */
  anchors: number
  visibleResponse: number
  noVisibleResponse: number
  insufficientContext: number
  /** 每事件每标签一次，只统计有可见回复的事件 */
  byLabel: Record<string, number>
}

export interface ResponseSummary {
  kind: 'support_response' | 'good_news_response'
  members: IntimacyResponseMemberSummary[]
}

export type IntimacyKindSummary = SharingSummary | ResponseSummary

export interface IntimacyResults {
  /** 提供事件的那次 run；只有用户确认事件时为 null */
  run: IntimacyRun | null
  /** 最新 run（用于进度 / 错误显示，可能与 run 相同） */
  latestRun: IntimacyRun | null
  members: IntimacyMember[]
  coverage: {
    targetStartTs: number
    targetEndTs: number
    totalWindows: number
    completedWindows: number
    failedWindows: number
    /** completedWindows === totalWindows && failedWindows === 0 */
    complete: boolean
    /** 范围内消息数或最大 id 与 run 记录不同 */
    sourceChanged: boolean
  } | null
  /** 按 anchorTs 升序；含 excluded（前端默认折叠） */
  events: IntimacyEvent[]
  /** 事件证据用到的消息，从聊天库现取 */
  messages: Record<number, IntimacyMessageSnippet>
  /** 每个已实现 kind 一条，顺序同 IMPLEMENTED_INTIMACY_KINDS */
  summaries: IntimacyKindSummary[]
  /** 有修订但当前结果里没有对应事件（需重核） */
  orphanReviews: number
  semanticSearchAvailable: boolean
  modelId: string | null
}

export interface IntimacyCandidateRequest {
  kind: IntimacyKind
  query: string
  startTs?: number
  endTs?: number
}

export interface IntimacyCandidates {
  /** ≤ 30，按时间倒序 */
  keyword: IntimacyMessageSnippet[]
  /** ≤ 10 个 chunk，各 ≤ 40 条 */
  semantic: Array<{ score: number; messages: IntimacyMessageSnippet[] }>
  semanticAvailable: boolean
}

/** 服务端填 K2 的 disclosureEventId，并按有没有勾选回复消息派生 responseObservation */
export type CreateIntimacyEventDetails =
  | Omit<SharingDetails, 'kind'>
  | Omit<SupportResponseDetails, 'kind' | 'disclosureEventId' | 'responseObservation'>
  | Omit<GoodNewsResponseDetails, 'kind' | 'responseObservation'>

export interface CreateIntimacyEventRequest {
  kind: IntimacyKind
  subjectMemberId: number
  /** 非空，全部由 subjectMemberId 发送 */
  coreMessageIds: number[]
  relatedMessageIds?: number[]
  /** K2 / K4：另一方的回复消息，必须由 otherMemberId 发送且 id 大于锚点 */
  responseMessageIds?: number[]
  details: CreateIntimacyEventDetails
}

export interface ReviewIntimacyEventRequest {
  decision: IntimacyReviewDecision
  /** 首次修订传 0 */
  expectedRevision: number
  details?: IntimacyReviewDetails
}
