import dayjs from 'dayjs'
import type {
  CreateSharedPlanStage,
  FollowUpDetails,
  FollowUpInitiation,
  FollowUpSummary,
  GoodNewsResponseDetails,
  GoodNewsResponseLabel,
  IntimacyEvent,
  IntimacyEventStatus,
  IntimacyFollowUpMemberSummary,
  IntimacyKindSummary,
  IntimacyMember,
  IntimacyMemberSummary,
  IntimacyResponseMemberSummary,
  RepairAttemptDetails,
  RepairLabel,
  RepairSummary,
  ResponseObservation,
  ResponseSummary,
  SharedPlanDetails,
  SharedPlanStage,
  SharedPlanSummary,
  SharingCategory,
  SharingDetails,
  SharingTopic,
  SubsequentObservation,
  SupportResponseDetails,
  SupportResponseLabel,
} from '@openchatlab/shared-types'

/** 话题筛选值：`all` = 不筛选 */
export type IntimacyTopicFilter = SharingTopic | 'all'

/** 一次结果里混着六种 kind，卡片各取自己那一份；details 与 kind 一一对应，narrow 后模板不必再判断。 */
export type IntimacySharingEvent = IntimacyEvent & { details: SharingDetails }
export type IntimacySupportEvent = IntimacyEvent & { details: SupportResponseDetails }
export type IntimacyGoodNewsEvent = IntimacyEvent & { details: GoodNewsResponseDetails }
export type IntimacyFollowUpEvent = IntimacyEvent & { details: FollowUpDetails }
export type IntimacySharedPlanEvent = IntimacyEvent & { details: SharedPlanDetails }
export type IntimacyRepairEvent = IntimacyEvent & { details: RepairAttemptDetails }
export type IntimacyResponseEvent = IntimacySupportEvent | IntimacyGoodNewsEvent

/**
 * 枚举值 → i18n key。写成 Record 而不是拼接，契约新增枚举值时这里会因缺键而类型报错，
 * 也顺带给出展示顺序。
 */
export const SHARING_CATEGORY_LABEL_KEYS: Record<SharingCategory, string> = {
  experience_or_update: 'views.intimacy.category.experienceOrUpdate',
  feeling: 'views.intimacy.category.feeling',
  worry_or_need: 'views.intimacy.category.worryOrNeed',
}

export const SHARING_TOPIC_LABEL_KEYS: Record<SharingTopic, string> = {
  work_study: 'views.intimacy.topic.workStudy',
  health: 'views.intimacy.topic.health',
  family: 'views.intimacy.topic.family',
  relationships: 'views.intimacy.topic.relationships',
  daily_life: 'views.intimacy.topic.dailyLife',
  other: 'views.intimacy.topic.other',
}

export const SUPPORT_RESPONSE_LABEL_KEYS: Record<SupportResponseLabel, string> = {
  acknowledges_feeling: 'views.intimacy.responseLabel.acknowledgesFeeling',
  addresses_situation: 'views.intimacy.responseLabel.addressesSituation',
  asks_details: 'views.intimacy.responseLabel.asksDetails',
  offers_advice_or_help: 'views.intimacy.responseLabel.offersAdviceOrHelp',
  shares_related_experience: 'views.intimacy.responseLabel.sharesRelatedExperience',
  unclear: 'views.intimacy.responseLabel.unclear',
}

export const GOOD_NEWS_RESPONSE_LABEL_KEYS: Record<GoodNewsResponseLabel, string> = {
  congratulates_or_affirms: 'views.intimacy.responseLabel.congratulatesOrAffirms',
  asks_or_elaborates: 'views.intimacy.responseLabel.asksOrElaborates',
  explicitly_diminishes: 'views.intimacy.responseLabel.explicitlyDiminishes',
  other_visible_response: 'views.intimacy.responseLabel.otherVisibleResponse',
  unclear: 'views.intimacy.responseLabel.unclear',
}

/** 缺失的回复只写「未见回复」，不映射成任何评价。 */
export const RESPONSE_OBSERVATION_LABEL_KEYS: Record<ResponseObservation, string> = {
  visible_response: 'views.intimacy.responseObservation.visibleResponse',
  no_visible_response: 'views.intimacy.responseObservation.noVisibleResponse',
  insufficient_context: 'views.intimacy.responseObservation.insufficientContext',
}

export const POSITIVE_FOR_SHARER_LABEL_KEYS: Record<GoodNewsResponseDetails['positiveForSharer'], string> = {
  explicit_or_context_supported: 'views.intimacy.positiveForSharer.supported',
  uncertain: 'views.intimacy.positiveForSharer.uncertain',
}

/** 三种说法只描述记录里看得到的先后顺序，都是事实陈述，「无法判断」也一样。 */
export const FOLLOW_UP_INITIATION_LABEL_KEYS: Record<FollowUpInitiation, string> = {
  before_subject_reintroduced: 'views.intimacy.initiation.beforeReintroduced',
  after_subject_reintroduced: 'views.intimacy.initiation.afterReintroduced',
  uncertain: 'views.intimacy.initiation.uncertain',
}

/**
 * K5 的六种阶段只说这个安排在记录里走到了哪一步，彼此之间没有好坏或先后优劣，
 * 所以按契约里的顺序固定展示，不排序也不着色。
 */
export const SHARED_PLAN_STAGE_LABEL_KEYS: Record<SharedPlanStage, string> = {
  proposed: 'views.intimacy.planStage.proposed',
  discussed: 'views.intimacy.planStage.discussed',
  mutually_confirmed: 'views.intimacy.planStage.mutuallyConfirmed',
  rescheduled: 'views.intimacy.planStage.rescheduled',
  cancelled: 'views.intimacy.planStage.cancelled',
  retrospective_mentioned: 'views.intimacy.planStage.retrospectiveMentioned',
}

/** K6 的四种修复方式都是聊天里看得见的表达，不是对动机的判断，所以按契约顺序展示，不排序也不着色。 */
export const REPAIR_LABEL_KEYS: Record<RepairLabel, string> = {
  apology: 'views.intimacy.repairLabel.apology',
  clarification: 'views.intimacy.repairLabel.clarification',
  acknowledges_part: 'views.intimacy.repairLabel.acknowledgesPart',
  deescalation_or_reconnect: 'views.intimacy.repairLabel.deescalationOrReconnect',
}

/**
 * 五种后续表现并列：接纳表达只是另一方说了那样一句话，不等于和解成功；「未见后续」也不等于修复失败。
 * 所以这五项既不排序也不着色，页面只按契约顺序把它们列出来。
 */
export const SUBSEQUENT_OBSERVATION_LABEL_KEYS: Record<SubsequentObservation, string> = {
  explicit_acceptance_expression: 'views.intimacy.subsequent.acceptance',
  continued_discussion: 'views.intimacy.subsequent.continuedDiscussion',
  explicit_rejection_expression: 'views.intimacy.subsequent.rejection',
  no_visible_follow_up: 'views.intimacy.subsequent.noVisibleFollowUp',
  uncertain: 'views.intimacy.subsequent.uncertain',
}

export const SHARING_CATEGORIES = Object.keys(SHARING_CATEGORY_LABEL_KEYS) as SharingCategory[]
export const SHARING_TOPICS = Object.keys(SHARING_TOPIC_LABEL_KEYS) as SharingTopic[]
export const SUPPORT_RESPONSE_LABELS = Object.keys(SUPPORT_RESPONSE_LABEL_KEYS) as SupportResponseLabel[]
export const GOOD_NEWS_RESPONSE_LABELS = Object.keys(GOOD_NEWS_RESPONSE_LABEL_KEYS) as GoodNewsResponseLabel[]
export const SHARED_PLAN_STAGES = Object.keys(SHARED_PLAN_STAGE_LABEL_KEYS) as SharedPlanStage[]
export const REPAIR_LABELS = Object.keys(REPAIR_LABEL_KEYS) as RepairLabel[]
export const SUBSEQUENT_OBSERVATIONS = Object.keys(SUBSEQUENT_OBSERVATION_LABEL_KEYS) as SubsequentObservation[]

export interface IntimacyStatusBadge {
  labelKey: string
  className: string
}

/**
 * 展示状态徽标。四种状态只描述这条事件是怎么来的（自动识别 / 用户确认 / 待核对 / 已排除），
 * 不带好坏含义，所以配色只用于区分，不用红绿。
 */
const STATUS_BADGES: Record<IntimacyEventStatus, IntimacyStatusBadge> = {
  auto: {
    labelKey: 'views.intimacy.status.auto',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  },
  confirmed: {
    labelKey: 'views.intimacy.status.confirmed',
    className: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
  },
  uncertain: {
    labelKey: 'views.intimacy.status.uncertain',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  excluded: {
    labelKey: 'views.intimacy.status.excluded',
    className: 'bg-gray-100 text-gray-400 line-through dark:bg-gray-800 dark:text-gray-500',
  },
}

export function resolveIntimacyStatusBadge(status: IntimacyEventStatus): IntimacyStatusBadge {
  return STATUS_BADGES[status]
}

export function selectSharingEvents(events: IntimacyEvent[]): IntimacySharingEvent[] {
  return events.filter((event): event is IntimacySharingEvent => event.details.kind === 'sharing')
}

export function selectSupportEvents(events: IntimacyEvent[]): IntimacySupportEvent[] {
  return events.filter((event): event is IntimacySupportEvent => event.details.kind === 'support_response')
}

export function selectGoodNewsEvents(events: IntimacyEvent[]): IntimacyGoodNewsEvent[] {
  return events.filter((event): event is IntimacyGoodNewsEvent => event.details.kind === 'good_news_response')
}

export function selectFollowUpEvents(events: IntimacyEvent[]): IntimacyFollowUpEvent[] {
  return events.filter((event): event is IntimacyFollowUpEvent => event.details.kind === 'follow_up')
}

export function selectSharedPlanEvents(events: IntimacyEvent[]): IntimacySharedPlanEvent[] {
  return events.filter((event): event is IntimacySharedPlanEvent => event.details.kind === 'shared_plan')
}

export function selectRepairEvents(events: IntimacyEvent[]): IntimacyRepairEvent[] {
  return events.filter((event): event is IntimacyRepairEvent => event.details.kind === 'repair_attempt')
}

/**
 * 回应方计数直接用后端的汇总：K2 / K4 的卡片没有前端筛选，重算一遍只会引入第二套规则。
 * 缺这一条 kind 时返回空数组，页面显示 0，而不是崩在 undefined 上。
 */
export function selectResponseSummary(
  summaries: IntimacyKindSummary[],
  kind: 'support_response' | 'good_news_response'
): IntimacyResponseMemberSummary[] {
  const summary = summaries.find((item): item is ResponseSummary => item.kind === kind)
  return summary?.members ?? []
}

/** 追问者计数同样直接用后端汇总（配对数 / 事情数 / 待核对数），K3 卡片也没有前端筛选。 */
export function selectFollowUpSummary(summaries: IntimacyKindSummary[]): IntimacyFollowUpMemberSummary[] {
  const summary = summaries.find((item): item is FollowUpSummary => item.kind === 'follow_up')
  return summary?.members ?? []
}

/** 共同安排的计数同样直接用后端汇总；这张卡也没有前端筛选，缺这一条 kind 时页面显示 0。 */
export function selectSharedPlanSummary(summaries: IntimacyKindSummary[]): SharedPlanSummary | null {
  return summaries.find((item): item is SharedPlanSummary => item.kind === 'shared_plan') ?? null
}

export interface IntimacySharedPlanStageCount {
  stage: SharedPlanStage
  labelKey: string
  count: number
}

/**
 * 六格「最后看到的一步」：拆的是「本期有更新」的那组安排（后端 `byLastStage` 的口径），
 * 所以六格之和等于 `updatedInRange`，而不是「本期新提议」。
 */
export function buildSharedPlanStageCounts(summary: SharedPlanSummary | null): IntimacySharedPlanStageCount[] {
  return SHARED_PLAN_STAGES.map((stage) => ({
    stage,
    labelKey: SHARED_PLAN_STAGE_LABEL_KEYS[stage],
    count: summary?.byLastStage[stage] ?? 0,
  }))
}

export interface IntimacySharedPlanMemberCount {
  memberId: number
  proposed: number
  confirmed: number
}

/**
 * 谁提议 / 谁确认：同样是「本期有更新」那一组的拆分。提议只计有提议记录的安排
 * （较早提议没被覆盖到的安排不算在任何人头上），确认计在明确说同意的那一方。
 */
export function buildSharedPlanMemberCounts(
  summary: SharedPlanSummary | null,
  members: IntimacyMember[]
): IntimacySharedPlanMemberCount[] {
  return members.map((member) => ({
    memberId: member.memberId,
    proposed: summary?.proposedBy[member.memberId] ?? 0,
    confirmed: summary?.confirmedBy[member.memberId] ?? 0,
  }))
}

/** 候选面板里正在拼的一步：阶段由用户选，行为者由消息的发送者决定，用户不用自己指认。 */
export interface SharedPlanStageDraft {
  stage: SharedPlanStage
  messageIds: number[]
}

export interface SharedPlanStageResolution {
  stages: CreateSharedPlanStage[]
  /** 不能提交时的提示文案 key；null = 通过前端这一遍检查 */
  errorKey: string | null
}

/**
 * 与后端 `checkSharedPlanStageSenders` 同一套规则：除「双方确认」外，一步里的消息全部由行为者本人发送；
 * 「双方确认」要两方各至少一条，行为者是后说话的那一方（同意在后）。前端先查一遍是为了点错时当场说清楚，
 * 后端仍会按聊天库里的真实发送者再查一次。
 */
export function resolveSharedPlanStages(
  drafts: SharedPlanStageDraft[],
  senderOf: (messageId: number) => number | undefined
): SharedPlanStageResolution {
  const stages: CreateSharedPlanStage[] = []
  let errorKey: string | null = null
  const fail = (key: string) => {
    errorKey ??= key
  }
  for (const draft of drafts) {
    const messageIds = [...new Set(draft.messageIds)].sort((left, right) => left - right)
    const senders = messageIds.flatMap((messageId) => {
      const senderId = senderOf(messageId)
      return senderId === undefined ? [] : [senderId]
    })
    if (messageIds.length === 0 || senders.length !== messageIds.length) {
      fail('views.intimacy.k5.stageNeedsMessage')
      continue
    }
    if (draft.stage === 'mutually_confirmed') {
      if (new Set(senders).size < 2) fail('views.intimacy.k5.confirmNeedsBoth')
    } else if (senders.some((senderId) => senderId !== senders[0])) {
      fail('views.intimacy.k5.oneSenderPerStage')
    }
    stages.push({
      stage: draft.stage,
      actorMemberId: draft.stage === 'mutually_confirmed' ? senders[senders.length - 1]! : senders[0]!,
      messageIds,
    })
  }
  if (stages.length === 0) fail('views.intimacy.k5.stageNeedsMessage')
  return { stages, errorKey }
}

/** 分歧后的修复尝试同样直接用后端汇总；这张卡也没有前端筛选，缺这一条 kind 时页面显示 0。 */
export function selectRepairSummary(summaries: IntimacyKindSummary[]): RepairSummary | null {
  return summaries.find((item): item is RepairSummary => item.kind === 'repair_attempt') ?? null
}

export interface IntimacyRepairMemberCount {
  memberId: number
  attempts: number
}

/** 修复尝试按发起者分开数：同一次分歧里两个人各修复一次，是一个分歧、两个尝试。 */
export function buildRepairMemberCounts(
  summary: RepairSummary | null,
  members: IntimacyMember[]
): IntimacyRepairMemberCount[] {
  return members.map((member) => ({
    memberId: member.memberId,
    attempts: summary?.members.find((item) => item.memberId === member.memberId)?.attempts ?? 0,
  }))
}

export interface IntimacyRepairLabelCount {
  label: RepairLabel
  labelKey: string
  count: number
}

/** 四格「修复方式」：多标签，一个尝试可以同时算进几格，所以四格之和可以大于尝试数。 */
export function buildRepairLabelCounts(summary: RepairSummary | null): IntimacyRepairLabelCount[] {
  return REPAIR_LABELS.map((label) => ({
    label,
    labelKey: REPAIR_LABEL_KEYS[label],
    count: (summary?.members ?? []).reduce((total, member) => total + (member.byLabel[label] ?? 0), 0),
  }))
}

export interface IntimacySubsequentCount {
  observation: SubsequentObservation
  labelKey: string
  count: number
}

/** 五格「后续表现」：每个计入的尝试恰好属于一种，所以五格之和等于尝试数。 */
export function buildSubsequentCounts(summary: RepairSummary | null): IntimacySubsequentCount[] {
  return SUBSEQUENT_OBSERVATIONS.map((observation) => ({
    observation,
    labelKey: SUBSEQUENT_OBSERVATION_LABEL_KEYS[observation],
    count: (summary?.members ?? []).reduce((total, member) => total + (member.bySubsequent[observation] ?? 0), 0),
  }))
}

/**
 * 与后端 `requireRepairReviewDetails` 同一条规则：没有引用后续消息的事件不能被改成「出现接纳表达」
 * 「继续讨论」「出现拒绝表达」——那三种说法都要有一条后续原话撑着。前端先把它们禁用，省得提交后才报错。
 */
export function canReadSubsequent(observation: SubsequentObservation, hasSubsequentEvidence: boolean): boolean {
  return hasSubsequentEvidence || observation === 'no_visible_follow_up' || observation === 'uncertain'
}

export interface IntimacyInitiationCount {
  initiation: FollowUpInitiation
  labelKey: string
  count: number
}

/**
 * 三格「问起的时机」：把两位追问者的汇总相加。每个计入的配对恰好属于一种情形，
 * 所以三格之和等于配对数之和。
 */
export function buildFollowUpInitiationCounts(members: IntimacyFollowUpMemberSummary[]): IntimacyInitiationCount[] {
  const total = (pick: (summary: IntimacyFollowUpMemberSummary) => number) =>
    members.reduce((sum, summary) => sum + pick(summary), 0)
  const counts: Array<[FollowUpInitiation, number]> = [
    ['before_subject_reintroduced', total((summary) => summary.beforeReintroduced)],
    ['after_subject_reintroduced', total((summary) => summary.afterReintroduced)],
    ['uncertain', total((summary) => summary.initiationUncertain)],
  ]
  return counts.map(([initiation, count]) => ({
    initiation,
    labelKey: FOLLOW_UP_INITIATION_LABEL_KEYS[initiation],
    count,
  }))
}

export interface IntimacyGapText {
  labelKey: string
  count: number
}

/**
 * 间隔只说到「天」这一级：读者要看的是隔了多久才问起，写到秒既没有意义，也会让页面像在计时。
 * 没有先前消息（`gapSeconds` 为 null）时不显示间隔。
 */
export function formatIntimacyGap(gapSeconds: number | null): IntimacyGapText | null {
  if (gapSeconds === null) return null
  const days = dayjs.unix(gapSeconds).diff(dayjs.unix(0), 'day')
  if (days === 0) return { labelKey: 'views.intimacy.k3.gapWithinDay', count: 0 }
  return { labelKey: days === 1 ? 'views.intimacy.k3.gapOneDay' : 'views.intimacy.k3.gapDays', count: days }
}

/** 已排除的事件默认折叠，所以列表按这条界线分成两组。 */
export function partitionIntimacyEvents<T extends IntimacyEvent>(events: T[]): { listed: T[]; excluded: T[] } {
  return {
    listed: events.filter((event) => event.status !== 'excluded'),
    excluded: events.filter((event) => event.status === 'excluded'),
  }
}

export function filterIntimacyEventsByTopic(
  events: IntimacySharingEvent[],
  topic: IntimacyTopicFilter
): IntimacySharingEvent[] {
  if (topic === 'all') return events
  return events.filter((event) => event.details.topic === topic)
}

export interface IntimacyTopicFilterOption {
  topic: IntimacyTopicFilter
  count: number
}

/**
 * 话题筛选 chips：只列出当前结果里出现过的话题，计数与 chip 选中后列表长度一致
 * （已排除的事件也算，它们仍会显示在「已排除」分组里）。
 */
export function buildIntimacyTopicFilterOptions(events: IntimacySharingEvent[]): IntimacyTopicFilterOption[] {
  const counts = new Map<SharingTopic, number>()
  for (const event of events) counts.set(event.details.topic, (counts.get(event.details.topic) ?? 0) + 1)
  return [
    { topic: 'all' as const, count: events.length },
    ...SHARING_TOPICS.filter((topic) => counts.has(topic)).map((topic) => ({ topic, count: counts.get(topic) ?? 0 })),
  ]
}

/**
 * 与后端 `summarizeSharing` 同一条规则的计数，用于话题筛选后重算：
 * 只有「自动识别」和「已确认」计入 counted，「待核对」单独列出、不计数，「已排除」不计数；
 * 类别是多标签，每个事件的每个标签各记一次，所以三类之和可以大于 counted。
 * 不筛选时结果必须与 `summaries` 里 `kind: 'sharing'` 的一条一致。
 */
export function summarizeIntimacyEvents(
  events: IntimacySharingEvent[],
  members: IntimacyMember[]
): IntimacyMemberSummary[] {
  return members.map((member) => {
    const own = events.filter((event) => event.subjectMemberId === member.memberId)
    const counted = own.filter((event) => event.status === 'auto' || event.status === 'confirmed')
    const byCategory = Object.fromEntries(SHARING_CATEGORIES.map((category) => [category, 0])) as Record<
      SharingCategory,
      number
    >
    for (const event of counted) {
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
