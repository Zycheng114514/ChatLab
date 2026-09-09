import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntimacyEventStatus, SharingCategory, SharingTopic } from '@openchatlab/shared-types'
import {
  buildIntimacyTopicFilterOptions,
  filterIntimacyEventsByTopic,
  partitionIntimacyEvents,
  resolveIntimacyStatusBadge,
  summarizeIntimacyEvents,
  type IntimacySharingEvent,
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
