import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntimacyMember } from '@openchatlab/shared-types'
import { buildIntimacyWindowPrompt, parseIntimacyResponse } from './model-protocol'
import type { IntimacySourceMessage, IntimacyWindow } from './source'

const members: [IntimacyMember, IntimacyMember] = [
  { memberId: 1, name: 'Alice', isOwner: true },
  { memberId: 2, name: 'Bob', isOwner: false },
]

function message(id: number, overrides: Partial<IntimacySourceMessage> = {}): IntimacySourceMessage {
  return { id, senderId: 1, timestamp: 1_786_200_000 + id, type: 0, content: 'text', isText: true, ...overrides }
}

/** Two context messages (ids 1, 2) followed by this window's own messages. */
const window: IntimacyWindow = {
  index: 1,
  contextCount: 2,
  messages: [
    message(1),
    message(2, { senderId: 2 }),
    message(3),
    message(4, { senderId: 2 }),
    message(5, { isText: false, content: '', type: 2 }),
    message(6),
  ],
}

function response(event: Record<string, unknown>): string {
  return JSON.stringify({ events: [event] })
}

const validEvent = {
  kind: 'sharing',
  discloser: 'A',
  coreMessageIds: [3, 6],
  relatedMessageIds: [4],
  categories: ['feeling', 'experience_or_update'],
  topic: 'work_study',
  distress: 'no',
  confidence: 'clear',
  continuesContextEvent: false,
  observation: 'sufficient',
  reason: 'Alice describes her own week.',
}

test('a valid window response is accepted, deduplicated and readable from a fenced reply', () => {
  const parsed = parseIntimacyResponse(
    '```json\n' + response({ ...validEvent, coreMessageIds: [3, 6, 3], relatedMessageIds: [4, 3] }) + '\n```',
    window,
    members
  )

  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0]?.coreMessageIds, [3, 6])
  assert.deepEqual(parsed[0]?.relatedMessageIds, [4])
  assert.equal(parsed[0]?.confidence, 'clear')
  assert.equal(parsed[0]?.topic, 'work_study')
})

test('optional label fields fall back to their neutral value and a long reason is bounded', () => {
  const parsed = parseIntimacyResponse(
    response({
      kind: 'sharing',
      discloser: 'B',
      coreMessageIds: [4],
      categories: ['worry_or_need'],
      confidence: 'uncertain',
      reason: 'r'.repeat(500),
    }),
    window,
    members
  )

  assert.equal(parsed[0]?.topic, 'other')
  assert.equal(parsed[0]?.distress, 'uncertain')
  assert.equal(parsed[0]?.observation, 'sufficient')
  assert.equal(parsed[0]?.continuesContextEvent, false)
  assert.deepEqual(parsed[0]?.relatedMessageIds, [])
  assert.equal(parsed[0]?.reason.length, 300)
})

const rejections: Array<{ name: string; payload: string }> = [
  {
    name: 'a core message that only appears as context of this window',
    payload: response({ ...validEvent, coreMessageIds: [1] }),
  },
  {
    name: 'a core message the other participant sent',
    payload: response({ ...validEvent, coreMessageIds: [3, 4] }),
  },
  {
    name: 'a core message with no readable text',
    payload: response({ ...validEvent, coreMessageIds: [5], discloser: 'A' }),
  },
  {
    name: 'a core message from outside the window',
    payload: response({ ...validEvent, coreMessageIds: [99] }),
  },
  { name: 'an empty core message list', payload: response({ ...validEvent, coreMessageIds: [] }) },
  { name: 'a non-integer core message id', payload: response({ ...validEvent, coreMessageIds: ['abc'] }) },
  {
    name: 'a related message from outside the window',
    payload: response({ ...validEvent, relatedMessageIds: [99] }),
  },
  { name: 'an unknown participant label', payload: response({ ...validEvent, discloser: 'C' }) },
  { name: 'an empty category list', payload: response({ ...validEvent, categories: [] }) },
  { name: 'an unknown category', payload: response({ ...validEvent, categories: ['mood'] }) },
  { name: 'an unknown topic', payload: response({ ...validEvent, topic: 'money' }) },
  { name: 'an unknown distress value', payload: response({ ...validEvent, distress: 'maybe' }) },
  { name: 'an unknown observation', payload: response({ ...validEvent, observation: 'partial' }) },
  { name: 'a missing confidence', payload: response({ ...validEvent, confidence: undefined }) },
  { name: 'a response that is not an object', payload: '[]' },
  { name: 'a response without an events array', payload: JSON.stringify({ events: 'none' }) },
  {
    name: 'more events than one window may contain',
    payload: JSON.stringify({ events: Array.from({ length: 31 }, () => validEvent) }),
  },
]

for (const rejection of rejections) {
  test(`window responses are rejected: ${rejection.name}`, () => {
    assert.throws(() => parseIntimacyResponse(rejection.payload, window, members))
  })
}

test('a window prompt lists one compact line per message under its date and keeps the context apart', () => {
  // 14:30 UTC is 22:30 in Shanghai; 16:05 UTC is already 00:05 the next day there.
  const at = (hour: number, minute: number) => Date.UTC(2026, 3, 30, hour, minute) / 1000
  const prompt = (contextCount: number) =>
    buildIntimacyWindowPrompt({
      window: {
        index: 1,
        contextCount,
        messages: [
          message(10, { timestamp: at(14, 30), content: '昨晚没睡好' }),
          message(11, { senderId: 2, timestamp: at(16, 5), content: 'first line\nsecond line' }),
          message(12, { timestamp: at(16, 6), type: 2, content: '', isText: false }),
        ],
      },
      members,
      totalWindows: 3,
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
    }).userPrompt

  const withContext = prompt(1)
  assert.match(withContext, /Window 2\/3/)
  assert.ok(
    withContext.includes(
      'Context (already coded in the previous window, never cite as coreMessageIds):\n[2026-04-30]\n10 A 22:30 昨晚没睡好\n\nMessages:\n[2026-05-01]\n11 B 00:05 first line\\nsecond line\n12 A 00:06 [type:voice]\n'
    ),
    withContext
  )

  const withoutContext = prompt(0)
  assert.ok(!withoutContext.includes('Context ('))
  assert.ok(withoutContext.includes('Messages:\n[2026-04-30]\n10 A 22:30 昨晚没睡好\n[2026-05-01]\n11 B 00:05'))
})
