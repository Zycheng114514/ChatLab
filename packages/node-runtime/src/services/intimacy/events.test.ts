import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntimacyEvent, IntimacyEventReview, IntimacyMember } from '@openchatlab/shared-types'
import { applyReviewDetails, buildSharingEvents, resolveEventStatus, summarizeSharing } from './events'
import type { ParsedSharingEvent } from './model-protocol'
import type { IntimacySourceMessage, IntimacyWindow } from './source'
import type { IntimacyEventRecord } from './store'

const baseTs = 1_786_200_000
const members: [IntimacyMember, IntimacyMember] = [
  { memberId: 1, name: 'Alice', isOwner: true },
  { memberId: 2, name: 'Bob', isOwner: false },
]

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
    discloser: 'A',
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
  const events = buildSharingEvents(
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
  const duplicateAnchor = buildSharingEvents(
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

  const sharedCoreId = buildSharingEvents(
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
  const events = buildSharingEvents(
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

  assert.equal(events.length, 1)
  const merged = events[0]!
  assert.equal(merged.id, 'sharing:1')
  assert.equal(merged.anchorMessageId, 1)
  assert.deepEqual(
    merged.evidence.map((evidence) => evidence.messageId),
    [1, 3]
  )
  assert.deepEqual(merged.details.categories, ['experience_or_update', 'feeling'])
  assert.equal(merged.details.isDistressDisclosure, 'yes')
  assert.equal(merged.modelDecision, 'uncertain')
})

test('a continuation without a matching previous event becomes its own event', () => {
  const otherSpeaker = buildSharingEvents(
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

  const outsideContext = buildSharingEvents(
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
      resolveEventStatus({ origin: statusCase.origin, modelDecision: statusCase.modelDecision }, statusCase.review),
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

  assert.deepEqual(details.categories, ['feeling', 'worry_or_need'])
  assert.equal(details.topic, 'health')
  assert.equal(details.isDistressDisclosure, 'no')
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
