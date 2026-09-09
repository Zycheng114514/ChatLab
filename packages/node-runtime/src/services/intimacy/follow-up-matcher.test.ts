import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type DatabaseAdapter } from '@openchatlab/core'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'
import type { SemanticIndexRuntime } from '../../semantic-index'
import {
  INTIMACY_FOLLOW_UP_MAX_CANDIDATES,
  collectFollowUpCandidates,
  parseFollowUpMatch,
  resolveFollowUpInitiation,
  type FollowUpCandidate,
} from './follow-up-matcher'
import type { IntimacyEventRecord } from './store'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = 1_786_200_000
const DAY = 24 * 60 * 60
/** Ids of the written messages; Alice (member 1) is the participant Bob asks about. */
const ALICE_CHECKUP = 2
const ALICE_MOVE = 4
const ALICE_TOO_OLD = 1
const ALICE_RECENT_CHAT = 20
const BOB_OWN_CHECKUP = 5
const ALICE_NON_TEXT = 6
const BOB_FOLLOW_UP = 40

/**
 * A synthetic chat where Alice mentions two matters, Bob mentions one of them himself, and Bob asks about the
 * check-up much later. Times are spread over weeks so the 30-day lookback actually cuts something off.
 */
function createChat(): DatabaseAdapter {
  const root = fs.mkdtempSync(
    path.join(
      process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir()),
      'chatlab-intimacy-matcher-'
    )
  )
  const dbPath = path.join(root, 'private.db')
  const db = new Database(dbPath, { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare(
    `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES ('Chat', 'wechat', 'private', ?, 'alice', 10)`
  ).run(baseTs)
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
  const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
  insert.run(ALICE_TOO_OLD, 1, baseTs - 60 * DAY, 0, '上次体检报告还没拿到')
  insert.run(ALICE_CHECKUP, 1, baseTs - 10 * DAY, 0, '医生让我下周去做体检复查，有点担心')
  insert.run(3, 2, baseTs - 10 * DAY + 60, 0, '要我陪你去吗')
  insert.run(ALICE_MOVE, 1, baseTs - 5 * DAY, 0, '这周末要搬家，东西太多了')
  insert.run(BOB_OWN_CHECKUP, 2, baseTs - 4 * DAY, 0, '我自己的体检也拖了很久')
  insert.run(ALICE_NON_TEXT, 1, baseTs - 3 * DAY, 2, null)
  insert.run(ALICE_RECENT_CHAT, 1, baseTs - 2 * DAY, 0, '今天中午吃了螺蛳粉')
  // Enough small talk from Alice that a wide recall has to be cut down to the most recent candidates.
  for (let id = 21; id <= 39; id += 1) insert.run(id, 1, baseTs - 3 * DAY + id * 60, 0, `随便聊两句 ${id}`)
  insert.run(BOB_FOLLOW_UP, 2, baseTs, 0, '你的体检结果出来了吗')
  db.close()
  return openBetterSqliteDatabase(dbPath, { nativeBinding, readonly: true })
}

function sharingEvent(anchorMessageId: number, anchorTs: number, subjectMemberId = 1): IntimacyEventRecord {
  return {
    id: `sharing:${anchorMessageId}`,
    kind: 'sharing',
    subjectMemberId,
    otherMemberId: subjectMemberId === 1 ? 2 : 1,
    anchorMessageId,
    anchorTs,
    evidence: [{ messageId: anchorMessageId, timestamp: anchorTs, senderId: subjectMemberId, role: 'core' }],
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: null,
    details: { kind: 'sharing', categories: ['worry_or_need'], topic: 'health', isDistressDisclosure: 'yes' },
    createdAt: baseTs * 1000,
  }
}

const followUp = {
  messageId: BOB_FOLLOW_UP,
  timestamp: baseTs,
  matter: '体检复查的结果',
  matterKeywords: ['体检', '复查'],
}

function semanticStub(startMessageId: number, endMessageId: number): SemanticIndexRuntime {
  return {
    canSearch: () => true,
    search: () =>
      Promise.resolve({
        available: true,
        blocks: [{ parentId: 'p1', startMessageId, endMessageId, messages: [], tokens: 0, chunkIds: [], score: 0.7 }],
        coverage: 1,
        partial: false,
        hitCount: 1,
      }),
  } as unknown as SemanticIndexRuntime
}

test('the candidate list only offers earlier messages the participant who is asked really sent', async (t) => {
  const db = createChat()
  t.after(() => db.close())

  const { candidates, lookbackStartTs } = await collectFollowUpCandidates({
    db,
    sessionId: 'private',
    askedMemberId: 1,
    followUp,
    codedEvents: [sharingEvent(ALICE_MOVE, baseTs - 5 * DAY), sharingEvent(BOB_OWN_CHECKUP, baseTs - 4 * DAY, 2)],
    chatStartTs: baseTs - 60 * DAY,
    semanticIndex: semanticStub(ALICE_RECENT_CHAT, ALICE_RECENT_CHAT),
    semanticAvailable: true,
  })

  assert.equal(lookbackStartTs, baseTs - 30 * DAY)
  assert.deepEqual(
    candidates.map((candidate) => [candidate.id, candidate.eventId]),
    [
      [ALICE_RECENT_CHAT, null],
      [ALICE_MOVE, `sharing:${ALICE_MOVE}`],
      [ALICE_CHECKUP, null],
    ],
    'the coded sharing, the keyword hit and the semantic hit are merged, most recent first'
  )
  assert.ok(
    !candidates.some((candidate) => candidate.id === ALICE_TOO_OLD),
    'a mention older than the lookback is out of reach'
  )
  assert.ok(
    !candidates.some((candidate) => candidate.id === BOB_OWN_CHECKUP),
    'the asker mentioning the same matter himself is not something to ask him about'
  )
  assert.ok(!candidates.some((candidate) => candidate.id === ALICE_NON_TEXT), 'a message with no text says nothing')
})

test('the lookback never reaches past the start of the chat and the list stays short', async (t) => {
  const db = createChat()
  t.after(() => db.close())

  const { candidates, lookbackStartTs } = await collectFollowUpCandidates({
    db,
    sessionId: 'private',
    askedMemberId: 1,
    followUp,
    codedEvents: [sharingEvent(ALICE_CHECKUP, baseTs - 10 * DAY)],
    chatStartTs: baseTs - 5 * DAY,
    semanticIndex: semanticStub(1, 39),
    semanticAvailable: true,
  })

  assert.equal(lookbackStartTs, baseTs - 5 * DAY, 'a young chat is not searched before it began')
  assert.equal(candidates.length, INTIMACY_FOLLOW_UP_MAX_CANDIDATES, 'a wide recall is cut to the shortlist')
  assert.equal(candidates[0]?.id, ALICE_RECENT_CHAT, 'the most recent messages are the ones offered')
  assert.ok(
    !candidates.some((item) => item.id === ALICE_CHECKUP),
    'the check-up mention now predates the chat window and drops out'
  )
})

function candidate(id: number, senderId = 1): FollowUpCandidate {
  return { id, senderId, timestamp: baseTs - DAY, type: 0, content: 'text', isText: true, eventId: null }
}

test('a match may only cite the earlier messages the server offered', () => {
  const scope = { candidates: [candidate(ALICE_CHECKUP), candidate(ALICE_MOVE)], askedMemberId: 1, anchorMessageId: 40 }

  assert.deepEqual(parseFollowUpMatch('{"priorMessageIds":[4,2],"match":"supported"}', scope), {
    priorMessageIds: [ALICE_CHECKUP, ALICE_MOVE],
    match: 'supported',
  })
  assert.deepEqual(
    parseFollowUpMatch('{"priorMessageIds":[],"match":"supported"}', scope),
    { priorMessageIds: [], match: 'uncertain' },
    'choosing nothing is never a pair, whatever the model called it'
  )

  assert.throws(
    () => parseFollowUpMatch('{"priorMessageIds":[99],"match":"supported"}', scope),
    /not one of the candidates/,
    'an id the server never offered is refused'
  )
  assert.throws(
    () =>
      parseFollowUpMatch('{"priorMessageIds":[7],"match":"supported"}', {
        ...scope,
        candidates: [...scope.candidates, candidate(7, 2)],
      }),
    /was not sent by the participant who is asked/
  )
  assert.throws(
    () =>
      parseFollowUpMatch('{"priorMessageIds":[41],"match":"supported"}', {
        ...scope,
        candidates: [...scope.candidates, candidate(41)],
      }),
    /does not come before the follow-up question/
  )
  assert.throws(() => parseFollowUpMatch('{"priorMessageIds":[2]}', scope), /Invalid association match/)
})

test('who raised the matter in between is read from the chat, and stays unknown when it cannot be', (t) => {
  const db = createChat()
  t.after(() => db.close())

  const question = { messageId: BOB_FOLLOW_UP, timestamp: baseTs }
  const before = resolveFollowUpInitiation({
    db,
    askedMemberId: 1,
    prior: { messageId: ALICE_CHECKUP, timestamp: baseTs - 10 * DAY },
    followUp: question,
    matterKeywords: ['报告'],
    priorEventEvidence: [],
  })
  assert.equal(before, 'before_subject_reintroduced', 'nothing about this matter came from her in between')

  const after = resolveFollowUpInitiation({
    db,
    askedMemberId: 1,
    prior: { messageId: ALICE_TOO_OLD, timestamp: baseTs - 60 * DAY },
    followUp: question,
    matterKeywords: ['体检'],
    priorEventEvidence: [],
  })
  assert.equal(after, 'after_subject_reintroduced', 'she brought the matter up again before he asked')

  const continued = resolveFollowUpInitiation({
    db,
    askedMemberId: 1,
    prior: { messageId: ALICE_TOO_OLD, timestamp: baseTs - 60 * DAY },
    followUp: question,
    matterKeywords: [],
    priorEventEvidence: [
      { messageId: ALICE_TOO_OLD, timestamp: baseTs - 60 * DAY, senderId: 1, role: 'core' },
      { messageId: ALICE_CHECKUP, timestamp: baseTs - 10 * DAY, senderId: 1, role: 'core' },
    ],
  })
  assert.equal(continued, 'after_subject_reintroduced', 'the coded event itself shows her returning to it')

  // The second sentence of the same disclosure, a minute later, is still the first mention, not a return to it.
  const sameMention = resolveFollowUpInitiation({
    db,
    askedMemberId: 1,
    prior: { messageId: ALICE_CHECKUP, timestamp: baseTs - 10 * DAY },
    followUp: question,
    matterKeywords: ['报告'],
    priorEventEvidence: [
      { messageId: ALICE_CHECKUP, timestamp: baseTs - 10 * DAY, senderId: 1, role: 'core' },
      { messageId: ALICE_CHECKUP + 1, timestamp: baseTs - 10 * DAY + 60, senderId: 1, role: 'core' },
    ],
  })
  assert.equal(sameMention, 'before_subject_reintroduced', 'her next sentence about it is the same mention')

  assert.equal(
    resolveFollowUpInitiation({
      db,
      askedMemberId: 1,
      prior: null,
      followUp: question,
      matterKeywords: ['体检'],
      priorEventEvidence: [],
    }),
    'uncertain',
    'without an earlier message there is no span to look at'
  )
  assert.equal(
    resolveFollowUpInitiation({
      db,
      askedMemberId: 1,
      prior: { messageId: ALICE_CHECKUP, timestamp: baseTs - 10 * DAY },
      followUp: question,
      matterKeywords: [],
      priorEventEvidence: [],
    }),
    'uncertain',
    'without anything to recognise the matter by, nothing is claimed'
  )
})
