import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  GoodNewsResponseLabel,
  IntimacyEventStatus,
  IntimacyFollowUpMemberSummary,
  IntimacyKindSummary,
  ResponseObservation,
  SharingCategory,
  SharingTopic,
  SupportResponseLabel,
} from '@openchatlab/shared-types'
import {
  buildFollowUpInitiationCounts,
  buildIntimacyTopicFilterOptions,
  filterIntimacyEventsByTopic,
  formatIntimacyGap,
  partitionIntimacyEvents,
  resolveIntimacyStatusBadge,
  selectFollowUpEvents,
  selectFollowUpSummary,
  selectGoodNewsEvents,
  selectResponseSummary,
  selectSharingEvents,
  selectSupportEvents,
  summarizeIntimacyEvents,
  type IntimacyFollowUpEvent,
  type IntimacyGoodNewsEvent,
  type IntimacySharingEvent,
  type IntimacySupportEvent,
} from './intimacy-summary'

const members = [
  { memberId: 1, name: 'A', isOwner: true },
  { memberId: 2, name: 'B', isOwner: false },
]

function event(
  id: number,
  subjectMemberId: number,
  status: IntimacyEventStatus,
  topic: SharingTopic,
  categories: SharingCategory[]
): IntimacySharingEvent {
  return {
    id: `sharing:${id}`,
    sessionId: 's',
    runId: 'run',
    kind: 'sharing',
    subjectMemberId,
    otherMemberId: subjectMemberId === 1 ? 2 : 1,
    anchorMessageId: id,
    anchorTs: 1_700_000_000 + id,
    evidence: [{ messageId: id, timestamp: 1_700_000_000 + id, senderId: subjectMemberId, role: 'core' }],
    observation: 'sufficient',
    origin: status === 'confirmed' ? 'user' : 'model',
    modelDecision: status === 'uncertain' ? 'uncertain' : 'included',
    modelReason: null,
    details: { kind: 'sharing', categories, topic, isDistressDisclosure: 'no' },
    review: null,
    status,
    stale: false,
  }
}

const events = [
  event(1, 1, 'auto', 'work_study', ['experience_or_update']),
  event(2, 1, 'confirmed', 'health', ['feeling', 'worry_or_need']),
  event(3, 1, 'uncertain', 'work_study', ['feeling']),
  event(4, 1, 'excluded', 'work_study', ['experience_or_update']),
  event(5, 2, 'auto', 'family', ['experience_or_update', 'feeling']),
]

test('counts only confirmed and automatically identified events, never uncertain or excluded ones', () => {
  const [a, b] = summarizeIntimacyEvents(events, members)

  assert.deepEqual(a, {
    memberId: 1,
    counted: 2,
    autoCount: 1,
    confirmedCount: 1,
    uncertainCount: 1,
    // 多标签：事件 2 同时算进 feeling 与 worry_or_need，所以三类之和大于 counted
    byCategory: { experience_or_update: 1, feeling: 1, worry_or_need: 1 },
  })
  assert.deepEqual(b, {
    memberId: 2,
    counted: 1,
    autoCount: 1,
    confirmedCount: 0,
    uncertainCount: 0,
    byCategory: { experience_or_update: 1, feeling: 1, worry_or_need: 0 },
  })
})

test('topic filter narrows the list and the counts together', () => {
  const workStudy = filterIntimacyEventsByTopic(events, 'work_study')
  assert.deepEqual(
    workStudy.map((item) => item.id),
    ['sharing:1', 'sharing:3', 'sharing:4']
  )

  const [a, b] = summarizeIntimacyEvents(workStudy, members)
  assert.equal(a.counted, 1)
  assert.equal(a.uncertainCount, 1)
  assert.equal(b.counted, 0)

  assert.equal(filterIntimacyEventsByTopic(events, 'all').length, events.length)
})

test('topic chips list only the topics present, with counts that match the filtered list', () => {
  const options = buildIntimacyTopicFilterOptions(events)

  assert.deepEqual(options, [
    { topic: 'all', count: 5 },
    { topic: 'work_study', count: 3 },
    { topic: 'health', count: 1 },
    { topic: 'family', count: 1 },
  ])
  for (const option of options) {
    assert.equal(filterIntimacyEventsByTopic(events, option.topic).length, option.count)
  }
})

test('excluded events are split out of the main list but kept', () => {
  const { listed, excluded } = partitionIntimacyEvents(events)

  assert.deepEqual(
    listed.map((item) => item.id),
    ['sharing:1', 'sharing:2', 'sharing:3', 'sharing:5']
  )
  assert.deepEqual(
    excluded.map((item) => item.id),
    ['sharing:4']
  )
})

test('every display status has its own badge label', () => {
  const statuses: IntimacyEventStatus[] = ['auto', 'confirmed', 'uncertain', 'excluded']
  const labels = statuses.map((status) => resolveIntimacyStatusBadge(status).labelKey)

  assert.deepEqual(labels, [
    'views.intimacy.status.auto',
    'views.intimacy.status.confirmed',
    'views.intimacy.status.uncertain',
    'views.intimacy.status.excluded',
  ])
  assert.equal(new Set(labels).size, statuses.length)
})

function responseEvent(
  kind: 'support_response' | 'good_news_response',
  id: number,
  subjectMemberId: number,
  status: IntimacyEventStatus,
  observation: ResponseObservation
) {
  return {
    ...event(id, subjectMemberId, status, 'other', ['worry_or_need']),
    id: `${kind}:${id}`,
    kind,
    evidence: [
      { messageId: id, timestamp: 1_700_000_000 + id, senderId: subjectMemberId, role: 'core' as const },
      ...(observation === 'visible_response'
        ? [
            {
              messageId: id + 1,
              timestamp: 1_700_000_001 + id,
              senderId: subjectMemberId === 1 ? 2 : 1,
              role: 'response' as const,
            },
          ]
        : []),
    ],
  }
}

function supportEvent(
  id: number,
  subjectMemberId: number,
  status: IntimacyEventStatus,
  observation: ResponseObservation,
  responseLabels: SupportResponseLabel[]
): IntimacySupportEvent {
  return {
    ...responseEvent('support_response', id, subjectMemberId, status, observation),
    kind: 'support_response',
    details: {
      kind: 'support_response',
      disclosureEventId: `sharing:${id}`,
      responseLabels,
      responseObservation: observation,
    },
  }
}

function goodNewsEvent(
  id: number,
  subjectMemberId: number,
  status: IntimacyEventStatus,
  observation: ResponseObservation,
  responseLabels: GoodNewsResponseLabel[]
): IntimacyGoodNewsEvent {
  return {
    ...responseEvent('good_news_response', id, subjectMemberId, status, observation),
    kind: 'good_news_response',
    details: {
      kind: 'good_news_response',
      positiveForSharer: 'explicit_or_context_supported',
      responseLabels,
      responseObservation: observation,
    },
  }
}

/**
 * K3 的角色是反过来的：事件主体是被问的那一方，追问者记在 otherMemberId 上。
 * 没有先前消息（`prior` 为 null）的追问就是待核对的那一类。
 */
function followUpEvent(
  id: number,
  askerMemberId: number,
  status: IntimacyEventStatus,
  prior: number | null
): IntimacyFollowUpEvent {
  const askedMemberId = askerMemberId === 1 ? 2 : 1
  return {
    ...event(id, askedMemberId, status, 'other', ['experience_or_update']),
    id: `follow_up:${id}`,
    kind: 'follow_up',
    subjectMemberId: askedMemberId,
    otherMemberId: askerMemberId,
    evidence: [
      ...(prior === null
        ? []
        : [{ messageId: prior, timestamp: 1_700_000_000 + prior, senderId: askedMemberId, role: 'prior' as const }]),
      { messageId: id, timestamp: 1_700_000_000 + id, senderId: askerMemberId, role: 'core' as const },
    ],
    details: {
      kind: 'follow_up',
      priorEventId: prior === null ? null : `sharing:${prior}`,
      matter: 'the check-up result',
      matterKeywords: ['check-up'],
      matchConfidence: prior === null ? 'uncertain' : 'supported',
      initiationInObservedRecord: prior === null ? 'uncertain' : 'before_subject_reintroduced',
      gapSeconds: prior === null ? null : id - prior,
      lookbackStartTs: 1_699_000_000,
      candidateMessageIds: prior === null ? [11, 12] : [],
    },
  }
}

// 一次结果里混着四种 kind，K1 的分享事件与 K4 的好消息事件可以共用同一条核心消息。
const mixedEvents = [
  ...events,
  supportEvent(2, 1, 'auto', 'visible_response', ['acknowledges_feeling']),
  supportEvent(3, 1, 'uncertain', 'no_visible_response', []),
  goodNewsEvent(5, 2, 'auto', 'visible_response', ['congratulates_or_affirms']),
  followUpEvent(9, 2, 'auto', 1),
  followUpEvent(10, 2, 'uncertain', null),
]

test('each card only sees its own kind, so a response event is never counted as personal sharing', () => {
  assert.deepEqual(
    selectSharingEvents(mixedEvents).map((item) => item.id),
    events.map((item) => item.id)
  )
  assert.deepEqual(
    selectSupportEvents(mixedEvents).map((item) => item.id),
    ['support_response:2', 'support_response:3']
  )
  assert.deepEqual(
    selectGoodNewsEvents(mixedEvents).map((item) => item.id),
    ['good_news_response:5']
  )
  assert.deepEqual(
    selectFollowUpEvents(mixedEvents).map((item) => item.id),
    ['follow_up:9', 'follow_up:10']
  )

  const [a, b] = summarizeIntimacyEvents(selectSharingEvents(mixedEvents), members)
  assert.equal(a.counted, 2)
  assert.equal(b.counted, 1)
})

test('the topic filter only ever works on sharing events', () => {
  const sharing = selectSharingEvents(mixedEvents)

  assert.deepEqual(buildIntimacyTopicFilterOptions(sharing), buildIntimacyTopicFilterOptions(events))
  assert.deepEqual(
    filterIntimacyEventsByTopic(sharing, 'other').map((item) => item.id),
    []
  )
})

const followUpMembers: IntimacyFollowUpMemberSummary[] = [
  {
    memberId: 1,
    pairs: 3,
    matters: 2,
    uncertain: 1,
    beforeReintroduced: 2,
    afterReintroduced: 1,
    initiationUncertain: 0,
  },
  {
    memberId: 2,
    pairs: 2,
    matters: 2,
    uncertain: 0,
    beforeReintroduced: 0,
    afterReintroduced: 1,
    initiationUncertain: 1,
  },
]

test('every card reads the summary of its own kind, and shows nothing when that kind is missing', () => {
  const support = { memberId: 2, anchors: 2, visibleResponse: 1, noVisibleResponse: 1, insufficientContext: 0 }
  const goodNews = { memberId: 1, anchors: 1, visibleResponse: 1, noVisibleResponse: 0, insufficientContext: 0 }
  const summaries: IntimacyKindSummary[] = [
    { kind: 'sharing', members: summarizeIntimacyEvents(events, members) },
    {
      kind: 'support_response',
      members: [{ ...support, byLabel: { acknowledges_feeling: 1 } }],
    },
    // 追问汇总的字段和回应汇总完全不同，回应卡拿到它就会显示别人的数字。
    { kind: 'follow_up', members: followUpMembers },
    {
      kind: 'good_news_response',
      members: [{ ...goodNews, byLabel: { congratulates_or_affirms: 1 } }],
    },
  ]

  assert.deepEqual(selectResponseSummary(summaries, 'support_response'), [
    { ...support, byLabel: { acknowledges_feeling: 1 } },
  ])
  assert.deepEqual(selectResponseSummary(summaries, 'good_news_response'), [
    { ...goodNews, byLabel: { congratulates_or_affirms: 1 } },
  ])
  assert.deepEqual(selectFollowUpSummary(summaries), followUpMembers)
  assert.deepEqual(selectResponseSummary([summaries[0]!], 'support_response'), [])
  assert.deepEqual(selectFollowUpSummary([summaries[0]!]), [])
})

test('the three initiation cells restate the counted pairs instead of adding a fourth number', () => {
  const cells = buildFollowUpInitiationCounts(followUpMembers)

  assert.deepEqual(cells, [
    { initiation: 'before_subject_reintroduced', labelKey: 'views.intimacy.initiation.beforeReintroduced', count: 2 },
    { initiation: 'after_subject_reintroduced', labelKey: 'views.intimacy.initiation.afterReintroduced', count: 2 },
    { initiation: 'uncertain', labelKey: 'views.intimacy.initiation.uncertain', count: 1 },
  ])
  assert.equal(
    cells.reduce((total, cell) => total + cell.count, 0),
    followUpMembers.reduce((total, summary) => total + summary.pairs, 0)
  )
  assert.deepEqual(
    buildFollowUpInitiationCounts([]).map((cell) => cell.count),
    [0, 0, 0]
  )
})

test('the gap between the two messages is stated in whole days, never to the second', () => {
  assert.equal(formatIntimacyGap(null), null)
  assert.deepEqual(formatIntimacyGap(0), { labelKey: 'views.intimacy.k3.gapWithinDay', count: 0 })
  assert.deepEqual(formatIntimacyGap(3 * 3600 + 17), { labelKey: 'views.intimacy.k3.gapWithinDay', count: 0 })
  assert.deepEqual(formatIntimacyGap(86_400), { labelKey: 'views.intimacy.k3.gapOneDay', count: 1 })
  assert.deepEqual(formatIntimacyGap(3 * 86_400 + 4_237), { labelKey: 'views.intimacy.k3.gapDays', count: 3 })
})

test('excluded response events are split out the same way as sharing events', () => {
  const { listed, excluded } = partitionIntimacyEvents([
    supportEvent(7, 1, 'auto', 'visible_response', ['asks_details']),
    supportEvent(8, 1, 'excluded', 'no_visible_response', []),
  ])

  assert.deepEqual(
    listed.map((item) => item.id),
    ['support_response:7']
  )
  assert.deepEqual(
    excluded.map((item) => item.id),
    ['support_response:8']
  )
})
