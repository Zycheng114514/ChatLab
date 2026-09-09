import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  IntimacyEvent,
  IntimacyEventDetails,
  IntimacyEventReview,
  IntimacyMember,
  SharingDetails,
} from '@openchatlab/shared-types'
import {
  applyReviewDetails,
  buildIntimacyEvents,
  resolveEventStatus,
  summarizeFollowUps,
  summarizeResponses,
  summarizeSharing,
} from './events'
import type { ParsedFollowUpEvent, ParsedGoodNewsEvent, ParsedSharingEvent } from './model-protocol'
import type { IntimacySourceMessage, IntimacyWindow } from './source'
import type { IntimacyEventRecord } from './store'

const baseTs = 1_786_200_000
const members: [IntimacyMember, IntimacyMember] = [
  { memberId: 1, name: 'Alice', isOwner: true },
  { memberId: 2, name: 'Bob', isOwner: false },
]

function sharingDetails(details: IntimacyEventDetails): SharingDetails {
  assert.ok(details.kind === 'sharing')
  return details
}

function message(id: number, senderId = 1): IntimacySourceMessage {
  return { id, senderId, timestamp: baseTs + id, type: 0, content: 'text', isText: true }
}

/** Ids 1-2 are the tail of the previous window, ids 3-6 belong to this one. */
const window: IntimacyWindow = {
  index: 1,
  contextCount: 2,
  messages: [message(1), message(2, 2), message(3), message(4, 2), message(5), message(6)],
}

function parsedEvent(overrides: Partial<ParsedSharingEvent> = {}): ParsedSharingEvent {
  return {
    kind: 'sharing',
    discloser: 'A',
    responses: null,
    coreMessageIds: [3],
    relatedMessageIds: [],
    categories: ['experience_or_update'],
    topic: 'work_study',
    distress: 'no',
    confidence: 'clear',
    continuesContextEvent: false,
    observation: 'sufficient',
    reason: 'Alice describes her own week.',
    ...overrides,
  }
}

function parsedGoodNews(overrides: Partial<ParsedGoodNewsEvent> = {}): ParsedGoodNewsEvent {
  return {
    kind: 'good_news',
    discloser: 'A',
    coreMessageIds: [3],
    relatedMessageIds: [],
    positiveForSharer: 'explicit_or_context_supported',
    confidence: 'clear',
    continuesContextEvent: false,
    observation: 'sufficient',
    reason: 'Alice reports her own offer.',
    responses: null,
    ...overrides,
  }
}

function parsedFollowUp(overrides: Partial<ParsedFollowUpEvent> = {}): ParsedFollowUpEvent {
  return {
    kind: 'follow_up',
    asker: 'B',
    coreMessageIds: [4],
    priorMessageIds: [],
    matter: 'Alice の check-up',
    matterKeywords: ['check-up'],
    confidence: 'clear',
    observation: 'sufficient',
    reason: 'Bob asks how it went.',
    ...overrides,
  }
}

function previousEvent(overrides: Partial<IntimacyEventRecord> = {}): IntimacyEventRecord {
  return {
    id: 'sharing:1',
    kind: 'sharing',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId: 1,
    anchorTs: baseTs + 1,
    evidence: [{ messageId: 1, timestamp: baseTs + 1, senderId: 1, role: 'core' }],
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: 'Alice started describing her week.',
    details: { kind: 'sharing', categories: ['experience_or_update'], topic: 'work_study', isDistressDisclosure: 'no' },
    createdAt: baseTs * 1000,
    ...overrides,
  }
}

function storedEvent(overrides: Partial<IntimacyEvent> = {}): IntimacyEvent {
  return {
    id: 'sharing:3',
    sessionId: 'private',
    runId: 'run-1',
    kind: 'sharing',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId: 3,
    anchorTs: baseTs + 3,
    evidence: [],
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: null,
    details: { kind: 'sharing', categories: ['experience_or_update'], topic: 'work_study', isDistressDisclosure: 'no' },
    review: null,
    status: 'auto',
    stale: false,
    ...overrides,
  }
}

test('one window turns into one event per matter, with evidence read back from the window', () => {
  const events = buildIntimacyEvents(
    [parsedEvent({ coreMessageIds: [3, 5], relatedMessageIds: [4] })],
    window,
    members,
    [],
    123
  )

  assert.equal(events.length, 1)
  const event = events[0]!
  assert.equal(event.id, 'sharing:3')
  assert.equal(event.anchorMessageId, 3)
  assert.equal(event.anchorTs, baseTs + 3)
  assert.equal(event.subjectMemberId, 1)
  assert.equal(event.otherMemberId, 2)
  assert.equal(event.origin, 'model')
  assert.equal(event.createdAt, 123)
  assert.deepEqual(
    event.evidence.map((evidence) => [evidence.messageId, evidence.senderId, evidence.role]),
    [
      [3, 1, 'core'],
      [4, 2, 'related'],
      [5, 1, 'core'],
    ]
  )
})

test('one matter is never counted twice inside a window', () => {
  const duplicateAnchor = buildIntimacyEvents(
    [parsedEvent({ coreMessageIds: [3, 5] }), parsedEvent({ coreMessageIds: [3] })],
    window,
    members,
    [],
    123
  )
  assert.deepEqual(
    duplicateAnchor.map((event) => event.id),
    ['sharing:3']
  )

  const sharedCoreId = buildIntimacyEvents(
    [parsedEvent({ coreMessageIds: [3] }), parsedEvent({ coreMessageIds: [3, 5] })],
    window,
    members,
    [],
    123
  )
  assert.deepEqual(
    sharedCoreId.map((event) => [event.id, event.evidence.map((evidence) => evidence.messageId)]),
    [
      ['sharing:3', [3]],
      ['sharing:5', [5]],
    ]
  )
})

test('a sharing continued from the previous window keeps one event instead of starting a second', () => {
  const events = buildIntimacyEvents(
    [
      parsedEvent({
        coreMessageIds: [3],
        continuesContextEvent: true,
        categories: ['feeling'],
        confidence: 'uncertain',
        distress: 'yes',
      }),
    ],
    window,
    members,
    [previousEvent()],
    123
  )

  const merged = events.find((event) => event.kind === 'sharing')!
  assert.equal(merged.id, 'sharing:1')
  assert.equal(merged.anchorMessageId, 1)
  assert.deepEqual(
    merged.evidence.map((evidence) => evidence.messageId),
    [1, 3]
  )
  assert.deepEqual(sharingDetails(merged.details).categories, ['experience_or_update', 'feeling'])
  assert.equal(sharingDetails(merged.details).isDistressDisclosure, 'yes')
  assert.equal(merged.modelDecision, 'uncertain')
})

test('a continuation without a matching previous event becomes its own event', () => {
  const otherSpeaker = buildIntimacyEvents(
    [parsedEvent({ continuesContextEvent: true })],
    window,
    members,
    [previousEvent({ subjectMemberId: 2, otherMemberId: 1 })],
    123
  )
  assert.deepEqual(
    otherSpeaker.map((event) => event.id),
    ['sharing:3']
  )

  const outsideContext = buildIntimacyEvents(
    [parsedEvent({ continuesContextEvent: true })],
    window,
    members,
    [previousEvent({ evidence: [{ messageId: 99, timestamp: baseTs, senderId: 1, role: 'core' }] })],
    123
  )
  assert.deepEqual(
    outsideContext.map((event) => event.id),
    ['sharing:3']
  )
})

test('a disclosure marked as distress gets one support event, a sharing without distress gets none', () => {
  const withDistress = buildIntimacyEvents(
    [
      parsedEvent({
        coreMessageIds: [3],
        distress: 'yes',
        responses: { observation: 'visible_response', messageIds: [4], labels: ['acknowledges_feeling'] },
      }),
    ],
    window,
    members,
    [],
    123
  )

  assert.deepEqual(
    withDistress.map((event) => event.id),
    ['sharing:3', 'support_response:3']
  )
  const support = withDistress[1]!
  assert.equal(support.subjectMemberId, 1, 'the discloser stays the subject')
  assert.equal(support.otherMemberId, 2, 'the participant who answered is the other side')
  assert.deepEqual(
    support.evidence.map((evidence) => [evidence.messageId, evidence.role]),
    [
      [3, 'core'],
      [4, 'response'],
    ]
  )
  assert.deepEqual(support.details, {
    kind: 'support_response',
    disclosureEventId: 'sharing:3',
    responseObservation: 'visible_response',
    responseLabels: ['acknowledges_feeling'],
  })

  const withoutDistress = buildIntimacyEvents([parsedEvent({ coreMessageIds: [3] })], window, members, [], 123)
  assert.deepEqual(
    withoutDistress.map((event) => event.id),
    ['sharing:3']
  )
})

test('a reply that only becomes visible in the next window joins the support event it answers', () => {
  const previousSharing = previousEvent({
    details: { kind: 'sharing', categories: ['worry_or_need'], topic: 'family', isDistressDisclosure: 'yes' },
  })
  const previousSupport: IntimacyEventRecord = {
    id: 'support_response:1',
    kind: 'support_response',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId: 1,
    anchorTs: baseTs + 1,
    evidence: [{ messageId: 1, timestamp: baseTs + 1, senderId: 1, role: 'core' }],
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: 'Alice said she is struggling.',
    details: {
      kind: 'support_response',
      disclosureEventId: 'sharing:1',
      responseLabels: [],
      responseObservation: 'insufficient_context',
    },
    createdAt: baseTs * 1000,
  }

  const events = buildIntimacyEvents(
    [
      parsedEvent({
        coreMessageIds: [],
        categories: [],
        continuesContextEvent: true,
        distress: 'yes',
        responses: { observation: 'visible_response', messageIds: [4], labels: ['offers_advice_or_help'] },
      }),
    ],
    window,
    members,
    [previousSharing, previousSupport],
    123
  )

  assert.deepEqual(
    events.map((event) => event.id),
    ['sharing:1', 'support_response:1'],
    'the answer joins the disclosure instead of opening a second support event'
  )
  const support = events[1]!
  assert.deepEqual(
    support.evidence.map((evidence) => [evidence.messageId, evidence.role]),
    [
      [1, 'core'],
      [4, 'response'],
    ]
  )
  assert.deepEqual(support.details, {
    kind: 'support_response',
    disclosureEventId: 'sharing:1',
    responseObservation: 'visible_response',
    responseLabels: ['offers_advice_or_help'],
  })
})

test('the same messages can be a sharing and good news, but never two events of one kind', () => {
  const events = buildIntimacyEvents(
    [
      parsedEvent({ coreMessageIds: [3] }),
      parsedGoodNews({
        coreMessageIds: [3],
        responses: { observation: 'visible_response', messageIds: [4], labels: ['explicitly_diminishes'] },
      }),
      parsedGoodNews({ coreMessageIds: [3] }),
    ],
    window,
    members,
    [],
    123
  )

  assert.deepEqual(
    events.map((event) => event.id),
    ['sharing:3', 'good_news_response:3']
  )
  assert.deepEqual(events[1]?.details, {
    kind: 'good_news_response',
    positiveForSharer: 'explicit_or_context_supported',
    responseObservation: 'visible_response',
    responseLabels: ['explicitly_diminishes'],
  })
})

test('good news the sharer may not welcome is never coded as a clear case', () => {
  const events = buildIntimacyEvents([parsedGoodNews({ positiveForSharer: 'uncertain' })], window, members, [], 123)

  assert.equal(events[0]?.modelDecision, 'uncertain')
  assert.equal(resolveEventStatus(storedEvent({ modelDecision: 'uncertain' }), null), 'uncertain')
})

const statusCases: Array<{
  name: string
  origin: IntimacyEvent['origin']
  modelDecision: IntimacyEvent['modelDecision']
  review: IntimacyEventReview | null
  expected: IntimacyEvent['status']
}> = [
  { name: 'a clear model event', origin: 'model', modelDecision: 'included', review: null, expected: 'auto' },
  {
    name: 'an unclear model event',
    origin: 'model',
    modelDecision: 'uncertain',
    review: null,
    expected: 'uncertain',
  },
  { name: 'a user created event', origin: 'user', modelDecision: null, review: null, expected: 'confirmed' },
  {
    name: 'an excluded event',
    origin: 'model',
    modelDecision: 'included',
    review: { decision: 'excluded', details: null, revision: 1, updatedAt: 1 },
    expected: 'excluded',
  },
  {
    name: 'a confirmed unclear event',
    origin: 'model',
    modelDecision: 'uncertain',
    review: { decision: 'included', details: null, revision: 1, updatedAt: 1 },
    expected: 'confirmed',
  },
]

for (const statusCase of statusCases) {
  test(`display status: ${statusCase.name}`, () => {
    assert.equal(
      resolveEventStatus(
        storedEvent({ origin: statusCase.origin, modelDecision: statusCase.modelDecision }),
        statusCase.review
      ),
      statusCase.expected
    )
  })
}

test('a user revision overrides the labels used for display and counting', () => {
  const details = applyReviewDetails(storedEvent().details, {
    decision: 'included',
    details: { categories: ['feeling', 'worry_or_need'], topic: 'health' },
    revision: 1,
    updatedAt: 1,
  })

  assert.deepEqual(sharingDetails(details).categories, ['feeling', 'worry_or_need'])
  assert.equal(sharingDetails(details).topic, 'health')
  assert.equal(sharingDetails(details).isDistressDisclosure, 'no')
})

test('a follow-up question is paired with the earlier message the window shows', () => {
  const events = buildIntimacyEvents([parsedFollowUp({ priorMessageIds: [3] })], window, members, [], 123)

  assert.equal(events.length, 1)
  const event = events[0]!
  assert.equal(event.id, 'follow_up:4')
  assert.equal(event.subjectMemberId, 1, 'the participant who is asked is the subject')
  assert.equal(event.otherMemberId, 2, 'the asker is the other side')
  assert.deepEqual(
    event.evidence.map((evidence) => [evidence.messageId, evidence.role]),
    [
      [3, 'prior'],
      [4, 'core'],
    ]
  )
  assert.ok(event.details.kind === 'follow_up')
  assert.equal(event.details.matchConfidence, 'supported')
  assert.equal(event.details.gapSeconds, 1)
  assert.equal(event.details.matter, 'Alice の check-up')
  assert.equal(
    resolveEventStatus({ origin: 'model', modelDecision: event.modelDecision, details: event.details }, null),
    'auto'
  )
})

test('a question whose earlier matter was not found is never counted as a pair', () => {
  const events = buildIntimacyEvents([parsedFollowUp()], window, members, [], 123)

  const event = events[0]!
  assert.ok(event.details.kind === 'follow_up')
  assert.equal(event.details.matchConfidence, 'uncertain')
  assert.equal(event.details.gapSeconds, null)
  assert.equal(
    resolveEventStatus({ origin: 'model', modelDecision: 'included', details: event.details }, null),
    'uncertain',
    'the question waits for the user instead of being counted'
  )
})

test('questions about one matter in one conversation are one event, a later conversation another', () => {
  const conversation: IntimacyWindow = {
    index: 0,
    contextCount: 0,
    messages: [
      { id: 1, senderId: 1, timestamp: baseTs, type: 0, content: 'text', isText: true },
      { id: 2, senderId: 2, timestamp: baseTs + 60, type: 0, content: 'text', isText: true },
      { id: 3, senderId: 2, timestamp: baseTs + 120, type: 0, content: 'text', isText: true },
      { id: 4, senderId: 2, timestamp: baseTs + 60 * 200, type: 0, content: 'text', isText: true },
    ],
  }
  const events = buildIntimacyEvents(
    [
      parsedFollowUp({ coreMessageIds: [2], priorMessageIds: [1] }),
      parsedFollowUp({ coreMessageIds: [3] }),
      parsedFollowUp({ coreMessageIds: [4] }),
    ],
    conversation,
    members,
    [],
    123
  )

  assert.deepEqual(
    events.map((event) => [event.id, event.evidence.map((evidence) => evidence.messageId)]),
    [
      ['follow_up:2', [1, 2, 3]],
      ['follow_up:4', [4]],
    ],
    'a second question minutes later joins the first, one hours later opens its own event'
  )
})

function followUpEvent(overrides: Partial<IntimacyEvent> = {}): IntimacyEvent {
  return {
    ...storedEvent(),
    id: 'follow_up:4',
    kind: 'follow_up',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId: 4,
    evidence: [{ messageId: 3, timestamp: baseTs + 3, senderId: 1, role: 'prior' }],
    details: {
      kind: 'follow_up',
      priorEventId: 'sharing:3',
      matter: 'check-up',
      matterKeywords: ['check-up'],
      matchConfidence: 'supported',
      initiationInObservedRecord: 'before_subject_reintroduced',
      gapSeconds: 3600,
      lookbackStartTs: baseTs - 100,
      candidateMessageIds: [],
    },
    ...overrides,
  }
}

test('follow-up summaries count the pairs, the matters behind them and the questions still waiting', () => {
  const events: IntimacyEvent[] = [
    followUpEvent(),
    // A second question about the same coded matter: another pair, still one matter.
    followUpEvent({ id: 'follow_up:9', status: 'confirmed' }),
    followUpEvent({
      id: 'follow_up:11',
      evidence: [{ messageId: 10, timestamp: baseTs + 10, senderId: 1, role: 'prior' }],
      details: {
        kind: 'follow_up',
        priorEventId: null,
        matter: 'the move',
        matterKeywords: ['move'],
        matchConfidence: 'supported',
        initiationInObservedRecord: 'after_subject_reintroduced',
        gapSeconds: 60,
        lookbackStartTs: baseTs - 100,
        candidateMessageIds: [],
      },
    }),
    followUpEvent({
      id: 'follow_up:13',
      status: 'uncertain',
      evidence: [],
      details: {
        kind: 'follow_up',
        priorEventId: null,
        matter: 'something',
        matterKeywords: ['something'],
        matchConfidence: 'uncertain',
        initiationInObservedRecord: 'uncertain',
        gapSeconds: null,
        lookbackStartTs: baseTs - 100,
        candidateMessageIds: [7, 8],
      },
    }),
    followUpEvent({ id: 'follow_up:15', status: 'excluded' }),
  ]

  const [alice, bob] = summarizeFollowUps(events, members)

  assert.equal(alice?.pairs, 0, 'the participant who was asked did not ask')
  assert.deepEqual(bob, {
    memberId: 2,
    pairs: 3,
    matters: 2,
    uncertain: 1,
    beforeReintroduced: 2,
    afterReintroduced: 1,
    initiationUncertain: 0,
  })
})

function responseEvent(overrides: Partial<IntimacyEvent> = {}): IntimacyEvent {
  return {
    ...storedEvent(),
    kind: 'support_response',
    details: {
      kind: 'support_response',
      disclosureEventId: 'sharing:3',
      responseLabels: ['acknowledges_feeling', 'asks_details'],
      responseObservation: 'visible_response',
    },
    ...overrides,
  }
}

test('response summaries count every answered disclosure once and leave a missing reply unlabelled', () => {
  const events: IntimacyEvent[] = [
    responseEvent({ id: 'support_response:3' }),
    responseEvent({
      id: 'support_response:5',
      status: 'confirmed',
      details: {
        kind: 'support_response',
        disclosureEventId: 'sharing:5',
        responseLabels: [],
        responseObservation: 'no_visible_response',
      },
    }),
    responseEvent({
      id: 'support_response:7',
      status: 'excluded',
      details: {
        kind: 'support_response',
        disclosureEventId: 'sharing:7',
        responseLabels: ['unclear'],
        responseObservation: 'visible_response',
      },
    }),
    responseEvent({
      id: 'support_response:9',
      status: 'uncertain',
      details: {
        kind: 'support_response',
        disclosureEventId: 'sharing:9',
        responseLabels: [],
        responseObservation: 'insufficient_context',
      },
    }),
  ]

  const [alice, bob] = summarizeResponses(events, members, 'support_response')

  assert.equal(alice?.anchors, 0, 'the discloser is not the one who could answer')
  assert.deepEqual(bob, {
    memberId: 2,
    anchors: 2,
    visibleResponse: 1,
    noVisibleResponse: 1,
    insufficientContext: 0,
    byLabel: {
      acknowledges_feeling: 1,
      addresses_situation: 0,
      asks_details: 1,
      offers_advice_or_help: 0,
      shares_related_experience: 0,
      unclear: 0,
    },
  })
})

test('a revision may relabel a reply that was seen but never one that was not', () => {
  const seen = applyReviewDetails(responseEvent().details, {
    decision: 'included',
    details: { responseLabels: ['offers_advice_or_help'] },
    revision: 1,
    updatedAt: 1,
  })
  assert.deepEqual(seen.kind === 'support_response' ? seen.responseLabels : [], ['offers_advice_or_help'])

  const missing = applyReviewDetails(
    {
      kind: 'support_response',
      disclosureEventId: 'sharing:5',
      responseLabels: [],
      responseObservation: 'no_visible_response',
    },
    { decision: 'included', details: { responseLabels: ['acknowledges_feeling'] }, revision: 1, updatedAt: 1 }
  )
  assert.deepEqual(missing.kind === 'support_response' ? missing.responseLabels : ['x'], [])
})

test('summaries count each confirmed or automatic event once and each of its labels once', () => {
  const events: IntimacyEvent[] = [
    storedEvent({
      id: 'sharing:3',
      details: {
        kind: 'sharing',
        categories: ['experience_or_update', 'feeling'],
        topic: 'work_study',
        isDistressDisclosure: 'no',
      },
    }),
    storedEvent({ id: 'sharing:5', status: 'confirmed', details: storedEvent().details }),
    storedEvent({ id: 'sharing:7', status: 'uncertain' }),
    storedEvent({ id: 'sharing:9', status: 'excluded' }),
    storedEvent({ id: 'sharing:11', subjectMemberId: 2, otherMemberId: 1, status: 'confirmed' }),
  ]

  const summary = summarizeSharing(events, members)

  assert.deepEqual(summary[0], {
    memberId: 1,
    counted: 2,
    autoCount: 1,
    confirmedCount: 1,
    uncertainCount: 1,
    byCategory: { experience_or_update: 2, feeling: 1, worry_or_need: 0 },
  })
  assert.deepEqual(summary[1], {
    memberId: 2,
    counted: 1,
    autoCount: 0,
    confirmedCount: 1,
    uncertainCount: 0,
    byCategory: { experience_or_update: 1, feeling: 0, worry_or_need: 0 },
  })
})
