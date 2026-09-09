import dayjs from 'dayjs'
import type {
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
  ResponseObservation,
  ResponseSummary,
  SharingCategory,
  SharingDetails,
  SharingTopic,
  SupportResponseDetails,
  SupportResponseLabel,
} from '@openchatlab/shared-types'

/** 话题筛选值：`all` = 不筛选 */
export type IntimacyTopicFilter = SharingTopic | 'all'

/** 一次结果里混着四种 kind，卡片各取自己那一份；details 与 kind 一一对应，narrow 后模板不必再判断。 */
export type IntimacySharingEvent = IntimacyEvent & { details: SharingDetails }
export type IntimacySupportEvent = IntimacyEvent & { details: SupportResponseDetails }
export type IntimacyGoodNewsEvent = IntimacyEvent & { details: GoodNewsResponseDetails }
export type IntimacyFollowUpEvent = IntimacyEvent & { details: FollowUpDetails }
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

export const SHARING_CATEGORIES = Object.keys(SHARING_CATEGORY_LABEL_KEYS) as SharingCategory[]
export const SHARING_TOPICS = Object.keys(SHARING_TOPIC_LABEL_KEYS) as SharingTopic[]
export const SUPPORT_RESPONSE_LABELS = Object.keys(SUPPORT_RESPONSE_LABEL_KEYS) as SupportResponseLabel[]
export const GOOD_NEWS_RESPONSE_LABELS = Object.keys(GOOD_NEWS_RESPONSE_LABEL_KEYS) as GoodNewsResponseLabel[]

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
  if (gapSeconds === null || gapSeconds < 0) return null
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
