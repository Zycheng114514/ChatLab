export type IntimacyKind =
  | 'sharing'
  | 'support_response'
  | 'follow_up'
  | 'good_news_response'
  | 'shared_plan'
  | 'repair_attempt'

/** PR-1 只实现 sharing；其余值先占位，服务端对未实现的 kind 返回 400 */
export const IMPLEMENTED_INTIMACY_KINDS: readonly IntimacyKind[] = ['sharing']

export type IntimacyRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type IntimacyEventOrigin = 'model' | 'user'
export type IntimacyModelDecision = 'included' | 'uncertain'
export type IntimacyReviewDecision = 'included' | 'excluded'
export type IntimacyObservation = 'sufficient' | 'boundary_limited' | 'media_missing'
/** 展示状态（服务端派生）：auto 自动识别、uncertain 待核对、confirmed 用户确认、excluded 已排除 */
export type IntimacyEventStatus = 'auto' | 'uncertain' | 'confirmed' | 'excluded'
export type IntimacyEvidenceRole = 'core' | 'related'

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

export type IntimacyEventDetails = SharingDetails

export interface IntimacyEvidence {
  messageId: number
  timestamp: number
  senderId: number
  role: IntimacyEvidenceRole
}

export interface IntimacyEventReview {
  decision: IntimacyReviewDecision
  /** 用户改写的标签（覆盖显示与计数） */
  details: Partial<Omit<SharingDetails, 'kind'>> | null
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
  /** K1 = 分享者 */
  subjectMemberId: number
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
  summary: {
    kind: IntimacyKind
    members: IntimacyMemberSummary[]
    /** 有修订但当前结果里没有对应事件（需重核） */
    orphanReviews: number
  }
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

export interface CreateIntimacyEventRequest {
  kind: 'sharing'
  subjectMemberId: number
  /** 非空，全部由 subjectMemberId 发送 */
  coreMessageIds: number[]
  relatedMessageIds?: number[]
  details: Omit<SharingDetails, 'kind'>
}

export interface ReviewIntimacyEventRequest {
  decision: IntimacyReviewDecision
  /** 首次修订传 0 */
  expectedRevision: number
  details?: Partial<Omit<SharingDetails, 'kind'>>
}
