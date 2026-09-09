import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  GoodNewsResponseLabel,
  IntimacyEventStatus,
  IntimacyFollowUpMemberSummary,
  IntimacyKindSummary,
  RepairLabel,
  RepairSummary,
  ResponseObservation,
  SharedPlanStage,
  SharedPlanStageRecord,
  SharedPlanSummary,
  SharingCategory,
  SharingTopic,
  SubsequentObservation,
  SupportResponseLabel,
} from '@openchatlab/shared-types'
import {
  buildFollowUpInitiationCounts,
  buildIntimacyTopicFilterOptions,
  buildRepairLabelCounts,
  buildRepairMemberCounts,
  buildSharedPlanMemberCounts,
  buildSharedPlanStageCounts,
  buildSubsequentCounts,
  canReadSubsequent,
  filterIntimacyEventsByTopic,
  formatIntimacyGap,
  partitionIntimacyEvents,
  resolveIntimacyStatusBadge,
  resolveRepairSelection,
  resolveSharedPlanStages,
  selectFollowUpEvents,
  selectFollowUpSummary,
  selectGoodNewsEvents,
  selectRepairEvents,
  selectRepairSummary,
  selectResponseSummary,
  selectSharedPlanEvents,
  selectSharedPlanSummary,
  selectSharingEvents,
  selectSupportEvents,
  summarizeIntimacyEvents,
  type IntimacyFollowUpEvent,
  type IntimacyGoodNewsEvent,
  type IntimacyRepairEvent,
  type IntimacySharedPlanEvent,
  type IntimacySharingEvent,
  type IntimacySupportEvent,
  type RepairSelectionDraft,
  type SharedPlanStageDraft,
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

/**
 * K5 的事件主体是提议者；较早的提议没被覆盖到时没有提议者，事件主体退到最早那一步的行为者。
 * 一个安排无论走过几步都只是一个事件，所以时间线整条挂在这一行上。
 */
function sharedPlanEvent(
  id: number,
  proposerMemberId: number | null,
  status: IntimacyEventStatus,
  stages: SharedPlanStageRecord[]
): IntimacySharedPlanEvent {
  const subjectMemberId = proposerMemberId ?? stages[0]!.actorMemberId
  return {
    ...event(id, subjectMemberId, status, 'other', ['experience_or_update']),
    id: `shared_plan:${id}`,
    kind: 'shared_plan',
    evidence: stages.flatMap((stage) =>
      stage.messageIds.map((messageId) => ({
        messageId,
        timestamp: 1_700_000_000 + messageId,
        senderId: stage.actorMemberId,
        role: messageId === id ? ('core' as const) : ('stage' as const),
      }))
    ),
    details: {
      kind: 'shared_plan',
      proposerMemberId,
      activitySummary: 'the exhibition on Saturday',
      stages,
      lastObservedStage: stages[stages.length - 1]!.stage,
      priorCoverage: proposerMemberId === null ? 'not_covered' : 'covered',
    },
  }
}

function stage(name: SharedPlanStage, actorMemberId: number, messageIds: number[]): SharedPlanStageRecord {
  return { stage: name, actorMemberId, messageIds, at: 1_700_000_000 + Math.min(...messageIds) }
}

// 一次结果里混着五种 kind，K1 的分享事件与 K4 的好消息事件可以共用同一条核心消息。
const mixedEvents = [
  ...events,
  supportEvent(2, 1, 'auto', 'visible_response', ['acknowledges_feeling']),
  supportEvent(3, 1, 'uncertain', 'no_visible_response', []),
  goodNewsEvent(5, 2, 'auto', 'visible_response', ['congratulates_or_affirms']),
  followUpEvent(9, 2, 'auto', 1),
  followUpEvent(10, 2, 'uncertain', null),
  sharedPlanEvent(20, 1, 'auto', [stage('proposed', 1, [20]), stage('mutually_confirmed', 2, [21, 22])]),
  sharedPlanEvent(30, null, 'uncertain', [stage('retrospective_mentioned', 2, [30])]),
]

test('each card only sees its own kind, so a response event is never counted as personal sharing', () => {
  assert.deepEqual(
    selectSharingEvents(mixedEvents).map((item) => item.id),
    events.map((item) => item.id)
  )
  assert.deepEqual(
    selectSharedPlanEvents(mixedEvents).map((item) => item.id),
    ['shared_plan:20', 'shared_plan:30']
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

const planSummary: SharedPlanSummary = {
  kind: 'shared_plan',
  newlyProposed: 2,
  updatedInRange: 3,
  byLastStage: {
    proposed: 0,
    discussed: 1,
    mutually_confirmed: 1,
    rescheduled: 0,
    cancelled: 0,
    retrospective_mentioned: 1,
  },
  proposedBy: { 1: 2, 2: 0 },
  confirmedBy: { 1: 0, 2: 1 },
}

test('the shared plan card reads its own summary, and shows zeros when that kind is missing', () => {
  const summaries: IntimacyKindSummary[] = [
    { kind: 'sharing', members: summarizeIntimacyEvents(events, members) },
    { kind: 'follow_up', members: followUpMembers },
    planSummary,
  ]

  assert.deepEqual(selectSharedPlanSummary(summaries), planSummary)
  assert.equal(selectSharedPlanSummary([summaries[0]!, summaries[1]!]), null)
  assert.deepEqual(
    buildSharedPlanStageCounts(null).map((cell) => cell.count),
    [0, 0, 0, 0, 0, 0]
  )
  assert.deepEqual(buildSharedPlanMemberCounts(null, members), [
    { memberId: 1, proposed: 0, confirmed: 0 },
    { memberId: 2, proposed: 0, confirmed: 0 },
  ])
})

test('the six stage cells split the plans updated in range, not the ones newly suggested', () => {
  const cells = buildSharedPlanStageCounts(planSummary)

  assert.deepEqual(
    cells.map((cell) => cell.stage),
    ['proposed', 'discussed', 'mutually_confirmed', 'rescheduled', 'cancelled', 'retrospective_mentioned']
  )
  assert.deepEqual(
    cells.map((cell) => cell.labelKey),
    [
      'views.intimacy.planStage.proposed',
      'views.intimacy.planStage.discussed',
      'views.intimacy.planStage.mutuallyConfirmed',
      'views.intimacy.planStage.rescheduled',
      'views.intimacy.planStage.cancelled',
      'views.intimacy.planStage.retrospectiveMentioned',
    ]
  )
  assert.equal(
    cells.reduce((total, cell) => total + cell.count, 0),
    planSummary.updatedInRange
  )
  assert.notEqual(planSummary.updatedInRange, planSummary.newlyProposed)
})

test('who suggested and who agreed are read per member, so neither column borrows the other total', () => {
  assert.deepEqual(buildSharedPlanMemberCounts(planSummary, members), [
    { memberId: 1, proposed: 2, confirmed: 0 },
    { memberId: 2, proposed: 0, confirmed: 1 },
  ])
  // 汇总里没有这个成员时显示 0，而不是崩在 undefined 上。
  assert.deepEqual(buildSharedPlanMemberCounts(planSummary, [{ memberId: 3, name: 'C', isOwner: false }]), [
    { memberId: 3, proposed: 0, confirmed: 0 },
  ])
})

/**
 * 候选面板拼出来的时间线要和后端同一套发送者规则对上：拼错时后端会 400，
 * 用户看到的却只是「无法确认这个事件」，所以这一遍检查要在点选的当场拦住。
 */
const senders = new Map([
  [10, 1],
  [11, 2],
  [12, 1],
  [13, 2],
])

function resolve(drafts: SharedPlanStageDraft[]) {
  return resolveSharedPlanStages(drafts, (messageId) => senders.get(messageId))
}

test('a timeline the backend accepts resolves to the participant who acted in each step', () => {
  const resolved = resolve([
    { stage: 'proposed', messageIds: [10] },
    { stage: 'discussed', messageIds: [11] },
    // 「双方确认」引用两条：对方摆出可执行的安排（12），本人随后同意（13）
    { stage: 'mutually_confirmed', messageIds: [13, 12] },
  ])

  assert.equal(resolved.errorKey, null)
  assert.deepEqual(resolved.stages, [
    { stage: 'proposed', actorMemberId: 1, messageIds: [10] },
    { stage: 'discussed', actorMemberId: 2, messageIds: [11] },
    // 同意在后，所以行为者是后说话的那一方，消息按 id 升序送出去
    { stage: 'mutually_confirmed', actorMemberId: 2, messageIds: [12, 13] },
  ])
})

test('a step the backend would reject is named before the request is sent', () => {
  const cases: Array<[string, SharedPlanStageDraft[], string]> = [
    ['a step with no messages at all', [], 'views.intimacy.k5.stageNeedsMessage'],
    [
      'a message that is not in the search results',
      [{ stage: 'proposed', messageIds: [99] }],
      'views.intimacy.k5.stageNeedsMessage',
    ],
    [
      'two people in one ordinary step',
      [
        { stage: 'proposed', messageIds: [10] },
        { stage: 'discussed', messageIds: [11, 12] },
      ],
      'views.intimacy.k5.oneSenderPerStage',
    ],
    [
      'a mutual confirmation with only one side',
      [
        { stage: 'proposed', messageIds: [10] },
        { stage: 'mutually_confirmed', messageIds: [11] },
      ],
      'views.intimacy.k5.confirmNeedsBoth',
    ],
  ]

  for (const [name, drafts, errorKey] of cases) {
    assert.equal(resolve(drafts).errorKey, errorKey, name)
  }
})
/**
 * K6 的事件主体是修复发起者；同一次分歧的两个尝试共用一个 disagreementGroupId，
 * 后续证据只在另一方确实说了话时才存在。
 */
function repairEvent(
  id: number,
  repairerMemberId: number,
  status: IntimacyEventStatus,
  repairLabels: RepairLabel[],
  subsequentObservation: SubsequentObservation,
  disagreementGroupId: string
): IntimacyRepairEvent {
  const otherMemberId = repairerMemberId === 1 ? 2 : 1
  const cited = subsequentObservation !== 'no_visible_follow_up' && subsequentObservation !== 'uncertain'
  return {
    ...event(id, repairerMemberId, status, 'other', ['feeling']),
    id: `repair_attempt:${id}`,
    kind: 'repair_attempt',
    evidence: [
      { messageId: 80, timestamp: 1_700_000_080, senderId: repairerMemberId, role: 'disagreement' as const },
      { messageId: 81, timestamp: 1_700_000_081, senderId: otherMemberId, role: 'disagreement' as const },
      { messageId: id, timestamp: 1_700_000_000 + id, senderId: repairerMemberId, role: 'core' as const },
      ...(cited
        ? [
            {
              messageId: id + 1,
              timestamp: 1_700_000_001 + id,
              senderId: otherMemberId,
              role: 'subsequent' as const,
            },
          ]
        : []),
    ],
    details: { kind: 'repair_attempt', disagreementGroupId, repairLabels, subsequentObservation },
  }
}

const repairSummary: RepairSummary = {
  kind: 'repair_attempt',
  disagreements: 2,
  members: [
    {
      memberId: 1,
      attempts: 3,
      byLabel: { apology: 2, clarification: 2, acknowledges_part: 1, deescalation_or_reconnect: 0 },
      bySubsequent: {
        explicit_acceptance_expression: 1,
        continued_discussion: 1,
        explicit_rejection_expression: 0,
        no_visible_follow_up: 1,
        uncertain: 0,
      },
    },
    {
      memberId: 2,
      attempts: 1,
      byLabel: { apology: 0, clarification: 0, acknowledges_part: 0, deescalation_or_reconnect: 1 },
      bySubsequent: {
        explicit_acceptance_expression: 0,
        continued_discussion: 0,
        explicit_rejection_expression: 0,
        no_visible_follow_up: 0,
        uncertain: 1,
      },
    },
  ],
}

test('the repair card picks out its own events and its own summary, and shows zeros without them', () => {
  const mixed = [
    ...events,
    repairEvent(90, 1, 'auto', ['apology'], 'explicit_acceptance_expression', 'disagreement:80'),
    repairEvent(92, 2, 'auto', ['deescalation_or_reconnect'], 'uncertain', 'disagreement:80'),
  ]
  const summaries: IntimacyKindSummary[] = [
    { kind: 'sharing', members: summarizeIntimacyEvents(events, members) },
    planSummary,
    repairSummary,
  ]

  assert.deepEqual(
    selectRepairEvents(mixed).map((item) => item.id),
    ['repair_attempt:90', 'repair_attempt:92']
  )
  assert.equal(selectSharedPlanEvents(mixed).length, 0)
  assert.deepEqual(selectRepairSummary(summaries), repairSummary)
  // 缺这一条 kind 时四格 / 五格都显示 0，而不是崩在 undefined 上。
  assert.equal(selectRepairSummary([summaries[0]!, planSummary]), null)
  assert.deepEqual(
    buildRepairLabelCounts(null).map((cell) => cell.count),
    [0, 0, 0, 0]
  )
  assert.deepEqual(
    buildSubsequentCounts(null).map((cell) => cell.count),
    [0, 0, 0, 0, 0]
  )
  assert.deepEqual(buildRepairMemberCounts(null, members), [
    { memberId: 1, attempts: 0 },
    { memberId: 2, attempts: 0 },
  ])
})

test('disagreements and attempts stay separate numbers, split by whoever repaired', () => {
  assert.deepEqual(buildRepairMemberCounts(repairSummary, members), [
    { memberId: 1, attempts: 3 },
    { memberId: 2, attempts: 1 },
  ])
  // 同一次分歧里的两次修复是一个分歧、两个尝试，所以分歧数比尝试数小。
  assert.equal(
    buildRepairMemberCounts(repairSummary, members).reduce((total, item) => total + item.attempts, 0),
    4
  )
  assert.equal(repairSummary.disagreements, 2)
  // 汇总里没有这个成员时显示 0。
  assert.deepEqual(buildRepairMemberCounts(repairSummary, [{ memberId: 3, name: 'C', isOwner: false }]), [
    { memberId: 3, attempts: 0 },
  ])
})

test('the four repair cells are multi-label while the five follow-up cells add up to the attempts', () => {
  const labels = buildRepairLabelCounts(repairSummary)
  const subsequent = buildSubsequentCounts(repairSummary)
  const attempts = repairSummary.members.reduce((total, member) => total + member.attempts, 0)

  assert.deepEqual(
    labels.map((cell) => cell.label),
    ['apology', 'clarification', 'acknowledges_part', 'deescalation_or_reconnect']
  )
  assert.deepEqual(
    labels.map((cell) => cell.labelKey),
    [
      'views.intimacy.repairLabel.apology',
      'views.intimacy.repairLabel.clarification',
      'views.intimacy.repairLabel.acknowledgesPart',
      'views.intimacy.repairLabel.deescalationOrReconnect',
    ]
  )
  // 一个尝试可以同时贴几种修复方式，所以四格之和大于尝试数。
  assert.equal(
    labels.reduce((total, cell) => total + cell.count, 0),
    6
  )
  assert.ok(labels.reduce((total, cell) => total + cell.count, 0) > attempts)

  assert.deepEqual(
    subsequent.map((cell) => cell.observation),
    [
      'explicit_acceptance_expression',
      'continued_discussion',
      'explicit_rejection_expression',
      'no_visible_follow_up',
      'uncertain',
    ]
  )
  // 每个尝试恰好一种后续，所以五格之和就是尝试数——五格里没有一格是「好」或「坏」的合计。
  assert.equal(
    subsequent.reduce((total, cell) => total + cell.count, 0),
    attempts
  )
})

test('a follow-up nobody cited cannot be revised into one that was', () => {
  const withEvidence: SubsequentObservation[] = [
    'explicit_acceptance_expression',
    'continued_discussion',
    'explicit_rejection_expression',
    'no_visible_follow_up',
    'uncertain',
  ]

  assert.deepEqual(
    withEvidence.map((observation) => canReadSubsequent(observation, true)),
    [true, true, true, true, true]
  )
  // 没有后续证据时只剩「未见后续」与「无法判断」，其余三种后端会 400。
  assert.deepEqual(
    withEvidence.map((observation) => canReadSubsequent(observation, false)),
    [false, false, false, true, true]
  )
})

/**
 * 三步选出来的消息要和后端 `buildDisagreementEvidence` / `requireSubsequentMessage` 对上：
 * 拼错时后端只回 400，用户看到的却是「无法确认这个事件」，所以这一遍检查要在点选的当场拦住。
 */
const repairSenders = new Map([
  [20, 1],
  [21, 2],
  [22, 1],
  [23, 2],
  [24, 1],
])

function resolveRepair(draft: RepairSelectionDraft) {
  return resolveRepairSelection(draft, (messageId) => repairSenders.get(messageId))
}

test('a three-step selection the backend accepts names whoever sent the repairing messages', () => {
  const resolved = resolveRepair({
    disagreementMessageIds: [20, 21],
    repairMessageIds: [22],
    subsequentMessageIds: [23],
  })

  assert.deepEqual(resolved, { repairerMemberId: 1, errorKey: null })
  // 后续消息是可选的：没点后续时服务端记为「未见后续」，前端不该因此拦住提交。
  assert.deepEqual(
    resolveRepair({ disagreementMessageIds: [20, 21], repairMessageIds: [22], subsequentMessageIds: [] }),
    {
      repairerMemberId: 1,
      errorKey: null,
    }
  )
})

test('a selection the backend would reject is named before the request is sent', () => {
  const cases: Array<[string, RepairSelectionDraft, string]> = [
    [
      'a disagreement only one of them showed',
      { disagreementMessageIds: [20], repairMessageIds: [22], subsequentMessageIds: [] },
      'views.intimacy.k6.disagreementNeedsBoth',
    ],
    [
      'a message that is not in the search results',
      { disagreementMessageIds: [20, 99], repairMessageIds: [22], subsequentMessageIds: [] },
      'views.intimacy.k6.disagreementNeedsBoth',
    ],
    [
      'no repairing message at all',
      { disagreementMessageIds: [20, 21], repairMessageIds: [], subsequentMessageIds: [] },
      'views.intimacy.k6.repairNeedsMessage',
    ],
    [
      'repairing messages from both of them',
      { disagreementMessageIds: [20, 21], repairMessageIds: [22, 23], subsequentMessageIds: [] },
      'views.intimacy.k6.repairNeedsOneSender',
    ],
    [
      'a disagreement that comes after the repair',
      { disagreementMessageIds: [21, 24], repairMessageIds: [22], subsequentMessageIds: [] },
      'views.intimacy.k6.disagreementBeforeRepair',
    ],
    [
      'a follow-up from the person who repaired',
      { disagreementMessageIds: [20, 21], repairMessageIds: [22], subsequentMessageIds: [24] },
      'views.intimacy.k6.subsequentFromOther',
    ],
    [
      'a follow-up that comes before the repair',
      { disagreementMessageIds: [20, 21], repairMessageIds: [24], subsequentMessageIds: [23] },
      'views.intimacy.k6.subsequentAfterRepair',
    ],
  ]

  for (const [name, draft, errorKey] of cases) {
    assert.equal(resolveRepair(draft).errorKey, errorKey, name)
  }
})
