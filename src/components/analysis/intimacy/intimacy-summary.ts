import type {
  IntimacyEvent,
  IntimacyEventStatus,
  IntimacyMember,
  IntimacyMemberSummary,
  SharingCategory,
  SharingTopic,
} from '@openchatlab/shared-types'

/** 话题筛选值：`all` = 不筛选 */
export type IntimacyTopicFilter = SharingTopic | 'all'

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

export const SHARING_CATEGORIES = Object.keys(SHARING_CATEGORY_LABEL_KEYS) as SharingCategory[]
export const SHARING_TOPICS = Object.keys(SHARING_TOPIC_LABEL_KEYS) as SharingTopic[]

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

/** 已排除的事件默认折叠，所以列表按这条界线分成两组。 */
export function partitionIntimacyEvents(events: IntimacyEvent[]): {
  listed: IntimacyEvent[]
  excluded: IntimacyEvent[]
} {
  return {
    listed: events.filter((event) => event.status !== 'excluded'),
    excluded: events.filter((event) => event.status === 'excluded'),
  }
}

export function filterIntimacyEventsByTopic(events: IntimacyEvent[], topic: IntimacyTopicFilter): IntimacyEvent[] {
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
export function buildIntimacyTopicFilterOptions(events: IntimacyEvent[]): IntimacyTopicFilterOption[] {
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
 * 不筛选时结果必须与 `results.summary.members` 一致。
 */
export function summarizeIntimacyEvents(events: IntimacyEvent[], members: IntimacyMember[]): IntimacyMemberSummary[] {
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
