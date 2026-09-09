import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type DatabaseAdapter } from '@openchatlab/core'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'
import {
  INTIMACY_SHARED_PLAN_MAX_CANDIDATES,
  collectSharedPlanCandidates,
  parseSharedPlanMatch,
  type SharedPlanCandidate,
} from './shared-plan-matcher'
import type { IntimacyEventRecord } from './store'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = 1_786_200_000
const DAY = 24 * 60 * 60
/** Ids of the written messages; the exhibition and the hotpot were arranged, the decoration is only talked about. */
const EXHIBITION_PROPOSAL = 4
const EXHIBITION_QUESTION = 5
const EXHIBITION_TIME = 6
const HOTPOT_PROPOSAL = 8
const HOTPOT_AGREES = 9
const DECORATION_SHARING = 12
const OLD_HIKE_PROPOSAL = 2
const LOOK_BACK = 20
const LATER_HOTPOT_PROPOSAL = 22

/**
 * A synthetic chat where two outings were arranged weeks apart, one more two months ago, and one after the look
 * back that is trying to find the arrangement it belongs to.
 */
function createChat(): DatabaseAdapter {
  const root = fs.mkdtempSync(
    path.join(
      process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir()),
      'chatlab-intimacy-plans-'
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
  const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, 0, ?)')
  insert.run(OLD_HIKE_PROPOSAL, 1, baseTs - 70 * DAY, '下个月找一天去爬山吧')
  insert.run(EXHIBITION_PROPOSAL, 1, baseTs - 10 * DAY, '周六去看那个摄影展吧')
  insert.run(EXHIBITION_QUESTION, 2, baseTs - 10 * DAY + 60, '几点的票？下午还是晚上')
  insert.run(EXHIBITION_TIME, 1, baseTs - 10 * DAY + 120, '下午三点场，我买两张')
  insert.run(HOTPOT_PROPOSAL, 2, baseTs - 2 * DAY, '下周三一起去吃那家火锅')
  insert.run(HOTPOT_AGREES, 1, baseTs - 2 * DAY + 60, '好啊，就下周三')
  insert.run(DECORATION_SHARING, 1, baseTs - DAY, '客厅装修的事我还没想好')
  // Enough arrangements in one week that a long list has to be cut down to the most recent ones.
  for (let id = 30; id <= 49; id += 1) {
    insert.run(id, id % 2 === 1 ? 1 : 2, baseTs - 3 * DAY + id * 60, `这周的第 ${id} 个安排`)
  }
  insert.run(LOOK_BACK, 2, baseTs, '上次那个摄影展的票根我还留着')
  insert.run(LATER_HOTPOT_PROPOSAL, 1, baseTs + 60, '下个月再去那家火锅店吧')
  db.close()
  return openBetterSqliteDatabase(dbPath, { nativeBinding, readonly: true })
}

function planEvent(
  anchorMessageId: number,
  anchorTs: number,
  activitySummary: string,
  evidenceIds: number[] = [anchorMessageId]
): IntimacyEventRecord {
  return {
    id: `shared_plan:${anchorMessageId}`,
    kind: 'shared_plan',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId,
    anchorTs,
    evidence: evidenceIds.map((messageId) => ({ messageId, timestamp: anchorTs, senderId: 1, role: 'stage' })),
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: null,
    details: {
      kind: 'shared_plan',
      proposerMemberId: 1,
      activitySummary,
      stages: [{ stage: 'proposed', actorMemberId: 1, messageIds: [anchorMessageId], at: anchorTs }],
      lastObservedStage: 'proposed',
      priorCoverage: 'covered',
    },
    createdAt: baseTs * 1000,
  }
}

function sharingEvent(anchorMessageId: number, anchorTs: number): IntimacyEventRecord {
  return {
    ...planEvent(anchorMessageId, anchorTs, '客厅装修'),
    id: `sharing:${anchorMessageId}`,
    kind: 'sharing',
    details: { kind: 'sharing', categories: ['worry_or_need'], topic: 'other', isDistressDisclosure: 'no' },
  }
}

const codedPlans = [
  planEvent(OLD_HIKE_PROPOSAL, baseTs - 70 * DAY, '下个月去爬山'),
  planEvent(EXHIBITION_PROPOSAL, baseTs - 10 * DAY, '周六下午看摄影展', [
    EXHIBITION_PROPOSAL,
    EXHIBITION_QUESTION,
    EXHIBITION_TIME,
  ]),
  planEvent(HOTPOT_PROPOSAL, baseTs - 2 * DAY, '下周三吃火锅', [HOTPOT_PROPOSAL, HOTPOT_AGREES]),
  sharingEvent(DECORATION_SHARING, baseTs - DAY),
  planEvent(LATER_HOTPOT_PROPOSAL, baseTs + 60, '下个月再吃火锅'),
]

test('a later stage is only offered the arrangements this run coded before it and within the lookback', (t) => {
  const db = createChat()
  t.after(() => db.close())

  const { candidates, lookbackStartTs } = collectSharedPlanCandidates({
    db,
    plans: codedPlans,
    stage: { messageId: LOOK_BACK, timestamp: baseTs },
    chatStartTs: baseTs - 90 * DAY,
  })

  assert.equal(lookbackStartTs, baseTs - 60 * DAY)
  assert.deepEqual(
    candidates.map((candidate) => [candidate.eventId, candidate.activitySummary]),
    [
      [`shared_plan:${HOTPOT_PROPOSAL}`, '下周三吃火锅'],
      [`shared_plan:${EXHIBITION_PROPOSAL}`, '周六下午看摄影展'],
    ],
    'the arrangements are offered most recent first'
  )
  assert.ok(
    !candidates.some((candidate) => candidate.eventId === `shared_plan:${OLD_HIKE_PROPOSAL}`),
    'the same kind of outing two months ago is out of reach, so it cannot be read as this one moved'
  )
  assert.ok(
    !candidates.some((candidate) => candidate.eventId === `shared_plan:${LATER_HOTPOT_PROPOSAL}`),
    'an arrangement made after this stage is not the one it looks back on'
  )
  assert.ok(
    !candidates.some((candidate) => candidate.eventId === `sharing:${DECORATION_SHARING}`),
    'only an arrangement can take the stages of an arrangement'
  )
  assert.deepEqual(
    candidates.map((candidate) => candidate.messages.map((message) => message.id)),
    [
      [HOTPOT_PROPOSAL, HOTPOT_AGREES],
      [EXHIBITION_PROPOSAL, EXHIBITION_QUESTION],
    ],
    'each arrangement comes with its first two messages, so two similar ones can be told apart'
  )
})

test('the lookback never reaches past the start of the chat and the list stays short', (t) => {
  const db = createChat()
  t.after(() => db.close())

  const crowded = [
    ...codedPlans,
    ...Array.from({ length: 10 }, (_, index) =>
      planEvent(30 + index * 2, baseTs - 3 * DAY + (30 + index * 2) * 60, `这周的安排 ${index}`, [
        30 + index * 2,
        31 + index * 2,
      ])
    ),
  ]

  const { candidates, lookbackStartTs } = collectSharedPlanCandidates({
    db,
    plans: crowded,
    stage: { messageId: 50, timestamp: baseTs },
    chatStartTs: baseTs - 5 * DAY,
  })

  assert.equal(lookbackStartTs, baseTs - 5 * DAY, 'a young chat is not searched before it began')
  assert.equal(candidates.length, INTIMACY_SHARED_PLAN_MAX_CANDIDATES, 'a long list is cut to the shortlist')
  assert.deepEqual(
    candidates.map((item) => item.eventId),
    [
      'shared_plan:8',
      'shared_plan:48',
      'shared_plan:46',
      'shared_plan:44',
      'shared_plan:42',
      'shared_plan:40',
      'shared_plan:38',
      'shared_plan:36',
    ],
    'the most recent arrangements are the ones offered'
  )
  assert.ok(
    !candidates.some((item) => item.eventId === `shared_plan:${EXHIBITION_PROPOSAL}`),
    'the exhibition now predates the chat window and drops out'
  )
})

function candidate(eventId: string): SharedPlanCandidate {
  return { eventId, activitySummary: '周六下午看摄影展', proposedAt: baseTs - DAY, messages: [] }
}

test('a stage may only join an arrangement the server offered, and only when the model says it is the same one', () => {
  const candidates = [candidate('shared_plan:4'), candidate('shared_plan:8')]

  assert.deepEqual(parseSharedPlanMatch('{"planEventId":"shared_plan:4","match":"supported"}', candidates), {
    planEventId: 'shared_plan:4',
    match: 'supported',
  })
  assert.deepEqual(
    parseSharedPlanMatch('{"planEventId":"shared_plan:4","match":"uncertain"}', candidates),
    { planEventId: null, match: 'uncertain' },
    'an arrangement that only might be the same one is never joined'
  )
  assert.deepEqual(
    parseSharedPlanMatch('{"planEventId":null,"match":"supported"}', candidates),
    { planEventId: null, match: 'uncertain' },
    'choosing nothing is never a match, whatever the model called it'
  )

  assert.throws(
    () => parseSharedPlanMatch('{"planEventId":"shared_plan:99","match":"supported"}', candidates),
    /is not one of the candidates/,
    'an arrangement the server never offered is refused'
  )
  assert.throws(
    () => parseSharedPlanMatch('{"planEventId":"shared_plan:4"}', candidates),
    /Invalid association match/,
    'naming an arrangement without saying it is the same one is not an answer'
  )
})
