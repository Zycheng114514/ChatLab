export type IntimacyKind =
  | 'sharing'
  | 'support_response'
  | 'follow_up'
  | 'good_news_response'
  | 'shared_plan'
  | 'repair_attempt'

/**
 * 全部六种都已实现：K1 个人分享、K2 倾诉后的回应、K3 事后追问、K4 好消息回应、K5 共同安排、
 * K6 分歧后的修复尝试。服务端对不在这个列表里的值返回 400。
 */
export const IMPLEMENTED_INTIMACY_KINDS: readonly IntimacyKind[] = [
  'sharing',
  'support_response',
  'follow_up',
  'good_news_response',
  'shared_plan',
  'repair_attempt',
]

export type IntimacyRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type IntimacyEventOrigin = 'model' | 'user'
export type IntimacyModelDecision = 'included' | 'uncertain'
export type IntimacyReviewDecision = 'included' | 'excluded'
export type IntimacyObservation = 'sufficient' | 'boundary_limited' | 'media_missing'
/** 展示状态（服务端派生）：auto 自动识别、uncertain 待核对、confirmed 用户确认、excluded 已排除 */
export type IntimacyEventStatus = 'auto' | 'uncertain' | 'confirmed' | 'excluded'
/**
 * response = 另一方针对锚点消息的回复；prior = K3 里被问者更早提到那件事的消息；
 * stage = K5 里推进同一个安排的消息（提议之后的商量 / 确认 / 改期 / 取消 / 回顾）；
 * disagreement = K6 里修复之前双方表现出不一致的消息；subsequent = K6 里另一方在修复之后的回复
 */
export type IntimacyEvidenceRole = 'core' | 'related' | 'response' | 'prior' | 'stage' | 'disagreement' | 'subsequent'

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
  /** 每段一次窗口调用，加上 K3 关联的估算（按每段一条追问算），实际次数记在 run 的 modelCalls 上 */
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

/** 追问与被问者更早提到那件事之间的关系；先前证据缺失时只有 uncertain */
export type FollowUpMatchConfidence = 'supported' | 'uncertain'

/**
 * 主动性：在被问者提到那件事与追问之间，被问者有没有自己又提起过。
 * 由程序判断（关键词命中或同一 K1 事件的后续证据），无法观察时为 uncertain。
 */
export type FollowUpInitiation = 'before_subject_reintroduced' | 'after_subject_reintroduced' | 'uncertain'

export interface FollowUpDetails {
  kind: 'follow_up'
  /** 先前消息所属的 K1 事件 id（`sharing:<anchorMessageId>`）；不属于任何分享事件时 null */
  priorEventId: string | null
  /** 模型给的事情描述，≤ 60 字，只用于列表标题 */
  matter: string
  /** 检索用词（≤ 5 个）：阶段 B 召回候选、程序判断主动性都用它 */
  matterKeywords: string[]
  matchConfidence: FollowUpMatchConfidence
  initiationInObservedRecord: FollowUpInitiation
  /** 追问锚点 − 先前锚点；没有先前证据时 null */
  gapSeconds: number | null
  /** 本次回查范围起点（追问前 30 天，且不早于聊天开始） */
  lookbackStartTs: number
  /** 阶段 B 给模型看过的候选消息 id（≤ 12，按时间倒序），供用户手动指定先前事件 */
  candidateMessageIds: number[]
}

/**
 * K5 的阶段：只描述聊天里可见的进展，不推断安排在现实中是否发生。
 * 一个安排无论改期几次都只是一个事件，阶段按时间排成一条时间线。
 */
export type SharedPlanStage =
  | 'proposed'
  | 'discussed'
  | 'mutually_confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'retrospective_mentioned'

export interface SharedPlanStageRecord {
  stage: SharedPlanStage
  /** mutually_confirmed 时是明确同意的一方；其余阶段的消息全部由该成员发送 */
  actorMemberId: number
  messageIds: number[]
  /** 该阶段最早一条消息的时间（秒） */
  at: number
}

export interface SharedPlanDetails {
  kind: 'shared_plan'
  /** 提议不在本次可见范围内（只看到后续阶段且没有关联到更早的安排）时为 null */
  proposerMemberId: number | null
  /** ≤ 40 字，只用证据里出现的活动 / 地点 / 时间词；「下周」保留原文，不解析成某天 */
  activitySummary: string
  /** 按时间升序 */
  stages: SharedPlanStageRecord[]
  /** 服务端派生：目标范围截止时的最后一个阶段，范围之后的阶段不算进来 */
  lastObservedStage: SharedPlanStage
  /** not_covered = 只看到后续阶段，较早的提议没有被覆盖到 */
  priorCoverage: 'covered' | 'not_covered'
}

/** K6 的修复方式，多标签；四种都是聊天里看得见的表达，不是对动机的判断 */
export type RepairLabel = 'apology' | 'clarification' | 'acknowledges_part' | 'deescalation_or_reconnect'

/**
 * 修复之后另一方可见的后续。接纳表达只表示对方说了「我明白你的意思了」这类话，
 * 不等于和解成功；没有后续也不等于对方不接受。
 */
export type SubsequentObservation =
  | 'explicit_acceptance_expression'
  | 'continued_discussion'
  | 'explicit_rejection_expression'
  | 'no_visible_follow_up'
  | 'uncertain'

export interface RepairAttemptDetails {
  kind: 'repair_attempt'
  /** `disagreement:<该组最早分歧消息 id>`；同一次分歧的多个修复尝试共用一个 */
  disagreementGroupId: string
  /** 非空，多标签 */
  repairLabels: RepairLabel[]
  subsequentObservation: SubsequentObservation
}

export type IntimacyEventDetails =
  | SharingDetails
  | SupportResponseDetails
  | GoodNewsResponseDetails
  | FollowUpDetails
  | SharedPlanDetails
  | RepairAttemptDetails

/**
 * K3 修订：用户从候选列表或被问者任意更早的消息里指定先前事件。客户端只传 `priorMessageIds`，
 * 服务端校验发送者与先后后，把算出来的配对结果一起写进修订。
 */
export interface FollowUpReviewDetails {
  /** 由被问者发送且早于追问锚点 */
  priorMessageIds: number[]
  priorEventId?: string | null
  matchConfidence?: FollowUpMatchConfidence
  initiationInObservedRecord?: FollowUpInitiation
  gapSeconds?: number | null
  matter?: string
}

/** K5 修订：用户只能改最后一个阶段，且只能选六种之一；把一个安排并入另一个留待后续 */
export interface SharedPlanReviewDetails {
  lastObservedStage: SharedPlanStage
}

/** K6 修订：改修复方式或后续表现；没有后续证据的事件不能改成接纳 / 继续讨论 / 拒绝 */
export interface RepairReviewDetails {
  repairLabels?: RepairLabel[]
  subsequentObservation?: SubsequentObservation
}

/** 用户改写的标签；服务端按事件 kind 校验，只接受该 kind 可改写的字段 */
export type IntimacyReviewDetails =
  | Partial<Omit<SharingDetails, 'kind'>>
  | Partial<Omit<SupportResponseDetails, 'kind'>>
  | Partial<Omit<GoodNewsResponseDetails, 'kind'>>
  | FollowUpReviewDetails
  | SharedPlanReviewDetails
  | RepairReviewDetails

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
  /** `${kind}:${anchorMessageId}`，会话内稳定身份，跨重跑关联修订；K3 的锚点是追问消息 */
  id: string
  sessionId: string
  /** 用户确认候选生成的事件为 null */
  runId: string | null
  kind: IntimacyKind
  /**
   * K1 = 分享者，K2 = 倾诉者，K3 = 被问者，K4 = 好消息的分享者，
   * K5 = 提议者（没有提议时是最早阶段的行为者），K6 = 修复发起者
   */
  subjectMemberId: number
  /** K2 / K4 = 回复方，K3 = 追问者，K5 / K6 = 另一方 */
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

/** 追问者的计数；主动性三项之和 = pairs，因为每个计入的配对恰好有一种主动性 */
export interface IntimacyFollowUpMemberSummary {
  /** 追问者 */
  memberId: number
  /** 计入的追问事件数（status ∈ auto、confirmed） */
  pairs: number
  /** 涉及的事情数：按先前事件去重（先前消息不属于 K1 事件时按该消息去重） */
  matters: number
  /** 没找到先前事件、待用户核对的追问数（不计入 pairs） */
  uncertain: number
  beforeReintroduced: number
  afterReintroduced: number
  initiationUncertain: number
}

export interface FollowUpSummary {
  kind: 'follow_up'
  members: IntimacyFollowUpMemberSummary[]
}

/**
 * 共同安排的计数。一个安排只计一次，无论它经历了几个阶段；`byLastStage` 各项之和 = `updatedInRange`。
 * 只统计 status ∈ auto、confirmed 的安排。
 */
export interface SharedPlanSummary {
  kind: 'shared_plan'
  /** 提议锚点落在目标范围内的安排数 */
  newlyProposed: number
  /** 任一阶段落在目标范围内的安排数 */
  updatedInRange: number
  /** 目标范围截止时的最后可见阶段；范围之后的阶段不泄漏到过去的视图里 */
  byLastStage: Record<SharedPlanStage, number>
  /** memberId → 该成员提议的安排数；两位成员都有条目（可能为 0） */
  proposedBy: Record<number, number>
  /** memberId → 该成员给出明确同意的安排数；两位成员都有条目（可能为 0） */
  confirmedBy: Record<number, number>
}

/** 修复发起者的计数；`bySubsequent` 各项之和 = `attempts`，因为每个尝试恰好有一种后续 */
export interface IntimacyRepairMemberSummary {
  /** 修复发起者 */
  memberId: number
  /** 该成员发起的修复尝试数（status ∈ auto、confirmed） */
  attempts: number
  /** 每尝试每标签一次，和可大于 attempts */
  byLabel: Record<RepairLabel, number>
  bySubsequent: Record<SubsequentObservation, number>
}

/** 分歧数与尝试数分开：同一次分歧里的两次修复是一个分歧、两个尝试 */
export interface RepairSummary {
  kind: 'repair_attempt'
  /** 计入的尝试涉及的不同 disagreementGroupId 数 */
  disagreements: number
  members: IntimacyRepairMemberSummary[]
}

export type IntimacyKindSummary = SharingSummary | ResponseSummary | FollowUpSummary | SharedPlanSummary | RepairSummary

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
  /** 事件证据（以及待核对追问的候选先前消息）用到的消息，从聊天库现取 */
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

/** K3 用户确认只需要事情描述，配对结果（先前事件、间隔、主动性）由服务端按证据算出 */
export type CreateFollowUpDetails = Pick<FollowUpDetails, 'matter'>

/** K5 用户确认的一个阶段；服务端按证据算出时间并校验发送者 */
export interface CreateSharedPlanStage {
  stage: SharedPlanStage
  actorMemberId: number
  messageIds: number[]
}

/** K5 用户确认：提议消息走 coreMessageIds，这里给活动描述与阶段列表；最后阶段由服务端派生 */
export interface CreateSharedPlanDetails {
  activitySummary: string
  stages: CreateSharedPlanStage[]
}

/**
 * K6 用户确认：分歧组由服务端按最早的分歧消息定；没有勾选后续消息时后续表现也由服务端定为
 * `no_visible_follow_up`，有后续消息时必须给出其余四种之一。
 */
export interface CreateRepairAttemptDetails {
  repairLabels: RepairLabel[]
  subsequentObservation?: SubsequentObservation
}

/** 服务端填 K2 的 disclosureEventId，并按有没有勾选回复消息派生 responseObservation */
export type CreateIntimacyEventDetails =
  | Omit<SharingDetails, 'kind'>
  | Omit<SupportResponseDetails, 'kind' | 'disclosureEventId' | 'responseObservation'>
  | Omit<GoodNewsResponseDetails, 'kind' | 'responseObservation'>
  | CreateFollowUpDetails
  | CreateSharedPlanDetails
  | CreateRepairAttemptDetails

export interface CreateIntimacyEventRequest {
  kind: IntimacyKind
  /** 核心消息的发送者：K1 / K2 / K4 是事件主体，K3 是追问者（事件主体是被问的另一方），K6 是修复发起者 */
  subjectMemberId: number
  /** 非空，全部由 subjectMemberId 发送；K3 是追问消息，K5 是提议消息，K6 是修复消息 */
  coreMessageIds: number[]
  relatedMessageIds?: number[]
  /** K2 / K4：另一方的回复消息；K6：另一方在修复之后的后续消息。都必须由 otherMemberId 发送且晚于锚点 */
  responseMessageIds?: number[]
  /** K3：另一方更早提到那件事的消息，必须由 otherMemberId 发送且 id 小于锚点 */
  priorMessageIds?: number[]
  /** K6：修复之前的分歧消息，双方各至少一条，全部早于修复锚点 */
  disagreementMessageIds?: number[]
  details: CreateIntimacyEventDetails
}

export interface ReviewIntimacyEventRequest {
  decision: IntimacyReviewDecision
  /** 首次修订传 0 */
  expectedRevision: number
  details?: IntimacyReviewDetails
}
