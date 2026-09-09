import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntimacyMember } from '@openchatlab/shared-types'
import {
  buildIntimacyWindowPrompt,
  parseIntimacyResponse,
  type ParsedFollowUpEvent,
  type ParsedIntimacyEvent,
  type ParsedSharingEvent,
} from './model-protocol'
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
    message(7, { senderId: 2 }),
  ],
}

function firstSharing(parsed: ParsedIntimacyEvent[]): ParsedSharingEvent {
  const event = parsed[0]
  assert.ok(event?.kind === 'sharing')
  return event
}

function firstFollowUp(parsed: ParsedIntimacyEvent[]): ParsedFollowUpEvent {
  const event = parsed[0]
  assert.ok(event?.kind === 'follow_up')
  return event
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
  assert.deepEqual(firstSharing(parsed).coreMessageIds, [3, 6])
  assert.deepEqual(firstSharing(parsed).relatedMessageIds, [4])
  assert.equal(firstSharing(parsed).confidence, 'clear')
  assert.equal(firstSharing(parsed).topic, 'work_study')
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

  assert.equal(firstSharing(parsed).topic, 'other')
  assert.equal(firstSharing(parsed).distress, 'uncertain')
  assert.equal(firstSharing(parsed).observation, 'sufficient')
  assert.equal(firstSharing(parsed).continuesContextEvent, false)
  assert.deepEqual(firstSharing(parsed).relatedMessageIds, [])
  assert.equal(firstSharing(parsed).reason.length, 300)
})

/** A disclosure with the answer the other participant gave to it. */
const disclosureWithReply = {
  ...validEvent,
  coreMessageIds: [3],
  relatedMessageIds: [],
  distress: 'yes',
  responses: { observation: 'visible_response', messageIds: [4], labels: ['asks_details', 'acknowledges_feeling'] },
}

const goodNewsWithReply = {
  kind: 'good_news',
  discloser: 'A',
  coreMessageIds: [3],
  relatedMessageIds: [],
  positiveForSharer: 'explicit_or_context_supported',
  confidence: 'clear',
  continuesContextEvent: false,
  observation: 'sufficient',
  reason: 'Alice reports her own offer.',
  responses: { observation: 'visible_response', messageIds: [4], labels: ['explicitly_diminishes'] },
}

test('a coded reply is read back from the window with its labels in a stable order', () => {
  const parsed = parseIntimacyResponse(response(disclosureWithReply), window, members)

  assert.equal(parsed[0]?.kind, 'sharing')
  assert.deepEqual(parsed[0]?.responses, {
    observation: 'visible_response',
    messageIds: [4],
    labels: ['acknowledges_feeling', 'asks_details'],
  })
})

test('good news is coded as its own kind and an unstated reading stays the cautious one', () => {
  const parsed = parseIntimacyResponse(
    response({ ...goodNewsWithReply, positiveForSharer: undefined }),
    window,
    members
  )

  assert.equal(parsed[0]?.kind, 'good_news')
  assert.equal(parsed[0]?.kind === 'good_news' ? parsed[0].positiveForSharer : null, 'uncertain')
  assert.deepEqual(parsed[0]?.responses?.labels, ['explicitly_diminishes'])
})

test('a reply to an event of the previous window is accepted without new messages of its own', () => {
  const parsed = parseIntimacyResponse(
    response({ ...disclosureWithReply, coreMessageIds: [], categories: [], continuesContextEvent: true }),
    window,
    members
  )

  assert.deepEqual(firstSharing(parsed).coreMessageIds, [])
  assert.deepEqual(firstSharing(parsed).responses?.messageIds, [4])
})

/** Bob asks about something Alice said earlier in this window. */
const followUpQuestion = {
  kind: 'follow_up',
  asker: 'B',
  coreMessageIds: [7],
  priorMessageIds: [3],
  matter: 'Alice の check-up',
  matterKeywords: ['check-up', '复查'],
  confidence: 'clear',
  observation: 'sufficient',
  reason: 'Bob asks how the check-up went.',
}

test('a follow-up question keeps the pair the window shows and bounds the matter it names', () => {
  const parsed = parseIntimacyResponse(
    response({
      ...followUpQuestion,
      priorMessageIds: [3, 1, 3],
      matter: `  ${'m'.repeat(200)}  `,
      matterKeywords: ['check-up', 'check-up', '复查', 'a', 'b', 'c', 'd', 'e'],
    }),
    window,
    members
  )

  const event = firstFollowUp(parsed)
  assert.deepEqual(event.coreMessageIds, [7])
  assert.deepEqual(event.priorMessageIds, [3, 1], 'an earlier message from the context can be the prior')
  assert.equal(event.matter.length, 60)
  assert.deepEqual(event.matterKeywords, ['check-up', '复查', 'a', 'b', 'c'])
  assert.equal(event.confidence, 'clear')
})

test('a follow-up question whose earlier message is not in this window is left for the matching step', () => {
  const parsed = parseIntimacyResponse(response({ ...followUpQuestion, priorMessageIds: undefined }), window, members)

  assert.deepEqual(firstFollowUp(parsed).priorMessageIds, [])
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
  { name: 'an unknown event kind', payload: response({ ...validEvent, kind: 'rant' }) },
  { name: 'a missing event kind', payload: response({ ...validEvent, kind: undefined }) },
  {
    name: 'a reply the discloser sent themselves',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'visible_response', messageIds: [6], labels: ['unclear'] },
    }),
  },
  {
    name: 'a reply that came before the message it answers',
    payload: response({
      ...disclosureWithReply,
      coreMessageIds: [6],
      responses: { observation: 'visible_response', messageIds: [4], labels: ['unclear'] },
    }),
  },
  {
    name: 'a reply from outside this window',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'visible_response', messageIds: [99], labels: ['unclear'] },
    }),
  },
  {
    name: 'a visible reply with no labels',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'visible_response', messageIds: [4], labels: [] },
    }),
  },
  {
    name: 'a visible reply with no cited message',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'visible_response', messageIds: [], labels: ['unclear'] },
    }),
  },
  {
    name: 'a reply reported as absent that still cites a message',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'no_visible_response', messageIds: [4], labels: [] },
    }),
  },
  {
    name: 'a reply reported as unreadable that still carries a label',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'insufficient_context', messageIds: [], labels: ['unclear'] },
    }),
  },
  {
    name: 'an unknown response label',
    payload: response({
      ...disclosureWithReply,
      responses: { observation: 'visible_response', messageIds: [4], labels: ['hug'] },
    }),
  },
  {
    name: 'a support label on a good news reply',
    payload: response({
      ...goodNewsWithReply,
      responses: { observation: 'visible_response', messageIds: [4], labels: ['acknowledges_feeling'] },
    }),
  },
  {
    name: 'a reply with no observation at all',
    payload: response({ ...disclosureWithReply, responses: { messageIds: [4], labels: ['unclear'] } }),
  },
  { name: 'an unknown good news reading', payload: response({ ...goodNewsWithReply, positiveForSharer: 'maybe' }) },
  {
    name: 'a distress disclosure whose reply was never checked',
    payload: response({ ...disclosureWithReply, responses: undefined }),
  },
  {
    name: 'good news whose reply was never checked',
    payload: response({ ...goodNewsWithReply, responses: undefined }),
  },
  {
    name: 'a continued event with neither new messages nor a reply',
    payload: response({ ...validEvent, coreMessageIds: [], categories: [], continuesContextEvent: true }),
  },
  {
    name: 'a follow-up question the participant who is asked sent themselves',
    payload: response({ ...followUpQuestion, coreMessageIds: [6] }),
  },
  {
    name: 'a follow-up question that only appears as context of this window',
    payload: response({ ...followUpQuestion, coreMessageIds: [2] }),
  },
  {
    name: 'a follow-up question with no readable text',
    payload: response({ ...followUpQuestion, asker: 'A', coreMessageIds: [5], priorMessageIds: [] }),
  },
  {
    name: 'an earlier message the asker sent themselves',
    payload: response({ ...followUpQuestion, priorMessageIds: [2] }),
  },
  {
    name: 'an earlier message that comes after the question',
    payload: response({ ...followUpQuestion, coreMessageIds: [4], priorMessageIds: [6] }),
  },
  {
    name: 'an earlier message from outside this window',
    payload: response({ ...followUpQuestion, priorMessageIds: [99] }),
  },
  {
    name: 'an earlier message with no readable text',
    payload: response({ ...followUpQuestion, priorMessageIds: [5] }),
  },
  { name: 'a follow-up question with no matter', payload: response({ ...followUpQuestion, matter: '  ' }) },
  {
    name: 'a follow-up question with no words to search the matter by',
    payload: response({ ...followUpQuestion, matterKeywords: [] }),
  },
  {
    name: 'a follow-up question with no confidence',
    payload: response({ ...followUpQuestion, confidence: undefined }),
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
