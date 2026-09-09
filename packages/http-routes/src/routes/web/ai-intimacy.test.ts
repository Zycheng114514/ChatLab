import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { CHAT_DB_SCHEMA, type PathProvider } from '@openchatlab/core'
import { createDatabaseManagerAdapter, DatabaseManager } from '@openchatlab/node-runtime'
import { registerAiIntimacyRoutes } from './ai-intimacy'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = Date.parse('2026-05-01T08:00:00.000Z') / 1000

function createPathProvider(root: string): PathProvider {
  return {
    getSystemDir: () => root,
    getUserDataDir: () => path.join(root, 'data'),
    getDatabaseDir: () => path.join(root, 'data', 'databases'),
    getVectorDir: () => path.join(root, 'data', 'vector'),
    getAiDataDir: () => path.join(root, 'ai'),
    getSettingsDir: () => path.join(root, 'settings'),
    getCacheDir: () => path.join(root, 'cache'),
    getTempDir: () => path.join(root, 'temp'),
    getLogsDir: () => path.join(root, 'logs'),
    getDownloadsDir: () => path.join(root, 'downloads'),
  }
}

/** Two private chats so a request cannot reach across sessions, plus one group chat. */
function createSessions(root: string): void {
  const dbDir = path.join(root, 'data', 'databases')
  fs.mkdirSync(dbDir, { recursive: true })
  for (const [sessionId, type] of [
    ['private', 'private'],
    ['other', 'private'],
    ['group', 'group'],
  ] as const) {
    const db = new Database(path.join(dbDir, `${sessionId}.db`), { nativeBinding })
    db.exec(CHAT_DB_SCHEMA)
    db.prepare(
      `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES (?, 'wechat', ?, ?, 'alice', 10)`
    ).run(sessionId, type, baseTs)
    db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
    db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
    const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, 0, ?)')
    insert.run(1, 1, baseTs + 60, `${sessionId} 今天面试结束了，我有点紧张`)
    insert.run(2, 2, baseTs + 120, `${sessionId} that sounds hard`)
    db.close()
  }
}

function createApp(root: string) {
  const paths = createPathProvider(root)
  const manager = new DatabaseManager(paths, { nativeBinding, runtime: { version: '0.38.0', kind: 'cli' } })
  const app = Fastify()
  registerAiIntimacyRoutes(app, {
    sessionAdapter: createDatabaseManagerAdapter(manager),
    pathProvider: paths,
    runtimeIdentity: { version: '0.38.0', kind: 'cli' },
    nativeBinding,
  })
  return { app, manager }
}

test('intimacy routes expose run state and reject requests the analysis cannot honour', async (t) => {
  const root = fs.mkdtempSync(
    path.join(
      process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir()),
      'intimacy-routes-'
    )
  )
  createSessions(root)
  const { app, manager } = createApp(root)
  t.after(async () => {
    await app.close()
    manager.closeAll()
  })
  await app.ready()

  const latest = await app.inject({ method: 'GET', url: '/_web/sessions/private/intimacy/runs/latest' })
  assert.equal(latest.statusCode, 200)
  assert.equal(latest.body, 'null')

  const missingRun = await app.inject({ method: 'GET', url: '/_web/sessions/private/intimacy/runs/run-404' })
  assert.equal(missingRun.statusCode, 404)

  const start = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/runs',
    payload: { kinds: ['sharing'], locale: 'zh-CN' },
  })
  assert.equal(start.statusCode, 400)
  assert.match(start.json().message, /LLM service is not configured/)

  const unsupportedKind = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/preflight',
    payload: { kinds: ['repair_attempt'] },
  })
  assert.equal(unsupportedKind.statusCode, 400)

  const groupChat = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/intimacy/preflight',
    payload: { kinds: ['sharing'] },
  })
  assert.equal(groupChat.statusCode, 400)

  const preflight = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/preflight',
    payload: { kinds: ['sharing'] },
  })
  assert.equal(preflight.statusCode, 200)
  assert.equal(preflight.json().modelId, null)
  assert.equal(preflight.json().messageCount, 2)
})

test('confirmed events and reviews stay inside one session and refuse a stale revision', async (t) => {
  const root = fs.mkdtempSync(
    path.join(
      process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir()),
      'intimacy-routes-'
    )
  )
  createSessions(root)
  const { app, manager } = createApp(root)
  t.after(async () => {
    await app.close()
    manager.closeAll()
  })
  await app.ready()

  const foreignMessage = await app.inject({
    method: 'POST',
    url: '/_web/sessions/other/intimacy/events',
    payload: {
      kind: 'sharing',
      subjectMemberId: 1,
      coreMessageIds: [99],
      details: { categories: ['feeling'], topic: 'other', isDistressDisclosure: 'no' },
    },
  })
  assert.equal(foreignMessage.statusCode, 400)

  const created = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'sharing',
      subjectMemberId: 1,
      coreMessageIds: [1],
      details: { categories: ['feeling'], topic: 'work_study', isDistressDisclosure: 'uncertain' },
    },
  })
  assert.equal(created.statusCode, 200)
  const eventId = created.json().events[0].id
  assert.equal(created.json().events[0].status, 'confirmed')
  assert.equal(created.json().summaries[0].members[0].counted, 1)

  const outsideRange = await app.inject({
    method: 'GET',
    url: `/_web/sessions/private/intimacy/results?startTs=${baseTs + 600}`,
  })
  assert.equal(outsideRange.statusCode, 200)
  assert.deepEqual(outsideRange.json().events, [])
  assert.equal(
    outsideRange.json().orphanReviews,
    0,
    'a decision on an event outside the requested range is not a review to re-check'
  )

  const otherSession = await app.inject({ method: 'GET', url: '/_web/sessions/other/intimacy/results' })
  assert.equal(otherSession.statusCode, 200)
  assert.deepEqual(otherSession.json().events, [])

  const review = await app.inject({
    method: 'PUT',
    url: `/_web/sessions/private/intimacy/events/${eventId}/review`,
    payload: { decision: 'excluded', expectedRevision: 1 },
  })
  assert.equal(review.statusCode, 200)
  assert.equal(review.json().events[0].status, 'excluded')

  const conflict = await app.inject({
    method: 'PUT',
    url: `/_web/sessions/private/intimacy/events/${eventId}/review`,
    payload: { decision: 'included', expectedRevision: 1 },
  })
  assert.equal(conflict.statusCode, 409)

  const unknownEvent = await app.inject({
    method: 'PUT',
    url: '/_web/sessions/private/intimacy/events/sharing:999/review',
    payload: { decision: 'included', expectedRevision: 0 },
  })
  assert.equal(unknownEvent.statusCode, 404)

  const supportEvent = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'support_response',
      subjectMemberId: 1,
      coreMessageIds: [1],
      responseMessageIds: [2],
      details: { responseLabels: ['acknowledges_feeling'] },
    },
  })
  assert.equal(supportEvent.statusCode, 200)
  assert.deepEqual(
    supportEvent.json().summaries.map((summary: { kind: string }) => summary.kind),
    ['sharing', 'support_response', 'follow_up', 'good_news_response', 'shared_plan'],
    'one request answers for every implemented kind'
  )

  const followUp = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'follow_up',
      subjectMemberId: 2,
      coreMessageIds: [2],
      priorMessageIds: [1],
      details: { matter: 'the interview' },
    },
  })
  assert.equal(followUp.statusCode, 200)
  const pair = followUp.json().events.find((item: { id: string }) => item.id === 'follow_up:2')
  assert.deepEqual(
    pair.evidence.map((item: { messageId: number; role: string }) => [item.messageId, item.role]),
    [
      [1, 'prior'],
      [2, 'core'],
    ],
    'the question and the earlier message it asks about are both served'
  )
  assert.equal(pair.subjectMemberId, 1, 'the participant who was asked is the subject')

  // A confirmed arrangement carries its stages inside the details, so the route has to hand them over untouched.
  const sharedPlan = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'shared_plan',
      subjectMemberId: 1,
      coreMessageIds: [1],
      details: {
        activitySummary: '周末一起吃饭',
        stages: [
          { stage: 'proposed', actorMemberId: 1, messageIds: [1] },
          { stage: 'mutually_confirmed', actorMemberId: 2, messageIds: [1, 2] },
        ],
      },
    },
  })
  assert.equal(sharedPlan.statusCode, 200)
  const plan = sharedPlan.json().events.find((item: { id: string }) => item.id === 'shared_plan:1')
  assert.equal(plan.details.lastObservedStage, 'mutually_confirmed')
  assert.deepEqual(
    plan.evidence.map((item: { messageId: number; role: string }) => [item.messageId, item.role]),
    [
      [1, 'core'],
      [2, 'stage'],
    ]
  )

  const movedPlan = await app.inject({
    method: 'PUT',
    url: '/_web/sessions/private/intimacy/events/shared_plan:1/review',
    payload: { decision: 'included', expectedRevision: 1, details: { lastObservedStage: 'cancelled' } },
  })
  assert.equal(movedPlan.statusCode, 200)
  assert.equal(
    movedPlan.json().events.find((item: { id: string }) => item.id === 'shared_plan:1').details.lastObservedStage,
    'cancelled'
  )

  const unknownStage = await app.inject({
    method: 'PUT',
    url: '/_web/sessions/private/intimacy/events/shared_plan:1/review',
    payload: { decision: 'included', expectedRevision: 2, details: { lastObservedStage: 'agreed' } },
  })
  assert.equal(unknownStage.statusCode, 400, 'where an arrangement stands is one of the six stages')

  const ownEarlierMessage = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'follow_up',
      subjectMemberId: 2,
      coreMessageIds: [2],
      priorMessageIds: [2],
      details: { matter: 'the interview' },
    },
  })
  assert.equal(ownEarlierMessage.statusCode, 400, "a question cannot be paired with the asker's own words")

  const wrongSender = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'support_response',
      subjectMemberId: 1,
      coreMessageIds: [1],
      responseMessageIds: [1],
      details: { responseLabels: ['acknowledges_feeling'] },
    },
  })
  assert.equal(wrongSender.statusCode, 400, 'a reply the discloser sent themselves is refused')

  const unimplementedKind = await app.inject({
    method: 'POST',
    url: '/_web/sessions/private/intimacy/events',
    payload: {
      kind: 'repair_attempt',
      subjectMemberId: 1,
      coreMessageIds: [1],
      details: { categories: ['feeling'], topic: 'other', isDistressDisclosure: 'no' },
    },
  })
  assert.equal(unimplementedKind.statusCode, 400)

  const mixed = await app.inject({ method: 'GET', url: '/_web/sessions/private/intimacy/results' })
  assert.equal(mixed.statusCode, 200)
  assert.deepEqual(
    mixed
      .json()
      .events.map((item: { id: string }) => item.id)
      .sort(),
    ['follow_up:2', 'shared_plan:1', 'sharing:1', 'support_response:1'],
    'the results contain every kind without asking for one'
  )

  const cleared = await app.inject({
    method: 'DELETE',
    url: '/_web/sessions/private/intimacy/results?reviews=1',
  })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json().success, true)
  const afterClear = await app.inject({ method: 'GET', url: '/_web/sessions/private/intimacy/results' })
  assert.deepEqual(afterClear.json().events, [])
  assert.equal(afterClear.json().orphanReviews, 0)
})
