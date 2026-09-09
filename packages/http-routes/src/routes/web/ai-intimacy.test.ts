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
    url: `/_web/sessions/private/intimacy/results?kind=sharing&startTs=${baseTs + 600}`,
  })
  assert.equal(outsideRange.statusCode, 200)
  assert.deepEqual(outsideRange.json().events, [])
  assert.equal(
    outsideRange.json().orphanReviews,
    0,
    'a decision on an event outside the requested range is not a review to re-check'
  )

  const otherSession = await app.inject({ method: 'GET', url: '/_web/sessions/other/intimacy/results?kind=sharing' })
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

  const cleared = await app.inject({
    method: 'DELETE',
    url: '/_web/sessions/private/intimacy/results?reviews=1',
  })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json().success, true)
  const afterClear = await app.inject({ method: 'GET', url: '/_web/sessions/private/intimacy/results?kind=sharing' })
  assert.deepEqual(afterClear.json().events, [])
  assert.equal(afterClear.json().orphanReviews, 0)
})
