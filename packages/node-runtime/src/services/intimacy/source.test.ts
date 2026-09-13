import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'
import {
  INTIMACY_WINDOW_CONTEXT_MESSAGES,
  INTIMACY_WINDOW_MAX_CHARS,
  INTIMACY_WINDOW_MAX_MESSAGES,
  chunkIntimacyMessages,
  createIntimacySourceSignature,
  estimateIntimacyWindows,
  loadIntimacySource,
  readIntimacySourceFingerprint,
  resolveIntimacyMembers,
  type IntimacySourceMessage,
} from './source'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = 1_786_200_000

function makeTempDir(): string {
  const baseDir = process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir())
  return fs.mkdtempSync(path.join(baseDir, 'chatlab-intimacy-source-'))
}

function message(id: number, overrides: Partial<IntimacySourceMessage> = {}): IntimacySourceMessage {
  return { id, senderId: 1, timestamp: baseTs + id, type: 0, content: 'hello', isText: true, ...overrides }
}

/** Alternating five-message turns, so a speaker change is always available inside the split lookback. */
function alternatingMessages(count: number): IntimacySourceMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(index + 1, { senderId: Math.floor(index / 5) % 2 === 0 ? 1 : 2 })
  )
}

function createPrivateSession(root: string) {
  const dbPath = path.join(root, 'private.db')
  const db = new Database(dbPath, { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare(
    `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES ('Chat', 'wechat', 'private', ?, 'alice', 10)`
  ).run(baseTs)
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (3, 'system', '系统消息')").run()
  const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
  insert.run(1, 1, baseTs + 10, 0, '今天面试终于结束了')
  insert.run(2, 2, baseTs + 20, 0, 'How did it go?')
  insert.run(3, 1, baseTs + 30, 2, null)
  insert.run(4, 3, baseTs + 40, 80, '对方撤回了一条消息')
  insert.run(5, 2, baseTs + 50, 0, '')
  insert.run(6, 1, baseTs + 9_000, 0, 'later message outside the range')
  db.close()
  return openBetterSqliteDatabase(dbPath, { nativeBinding, readonly: true })
}

test('windows are cut at a speaker change and carry the previous tail as context', () => {
  const windows = chunkIntimacyMessages(alternatingMessages(130))

  assert.equal(windows.length, 2)
  assert.equal(windows[0]?.contextCount, 0)
  const firstOwn = windows[0]!.messages
  assert.ok(firstOwn.length <= INTIMACY_WINDOW_MAX_MESSAGES)
  const lastOfFirst = firstOwn.at(-1)!
  const firstOfSecond = windows[1]!.messages[INTIMACY_WINDOW_CONTEXT_MESSAGES]!
  assert.equal(firstOfSecond.id, lastOfFirst.id + 1)
  assert.notEqual(firstOfSecond.senderId, lastOfFirst.senderId)

  assert.equal(windows[1]?.contextCount, INTIMACY_WINDOW_CONTEXT_MESSAGES)
  assert.deepEqual(
    windows[1]!.messages.slice(0, INTIMACY_WINDOW_CONTEXT_MESSAGES).map((item) => item.id),
    firstOwn.slice(-INTIMACY_WINDOW_CONTEXT_MESSAGES).map((item) => item.id)
  )
  assert.deepEqual(chunkIntimacyMessages(alternatingMessages(130)), windows)
})

test('windows stay inside the message and character budget and bound one oversized message', () => {
  const dense = Array.from({ length: 60 }, (_, index) => message(index + 1, { content: 'x'.repeat(200) }))
  const denseWindows = chunkIntimacyMessages(dense)
  assert.ok(denseWindows.length > 1)
  for (const window of denseWindows) {
    const own = window.messages.slice(window.contextCount)
    assert.ok(own.length <= INTIMACY_WINDOW_MAX_MESSAGES)
    assert.ok(own.reduce((sum, item) => sum + item.content.length + 40, 0) <= INTIMACY_WINDOW_MAX_CHARS + 240)
  }

  const oversized = message(1, { content: 'y'.repeat(20_000) })
  const bounded = chunkIntimacyMessages([oversized, message(2)])
  assert.ok((bounded[0]?.messages[0]?.content.length ?? 0) < INTIMACY_WINDOW_MAX_CHARS)
  assert.match(bounded[0]?.messages[0]?.content ?? '', /truncated/)
  assert.equal(oversized.content.length, 20_000)
})

test('source signatures follow the message evidence a run was started from', () => {
  const initial = [message(1), message(2)]
  assert.equal(createIntimacySourceSignature(initial), createIntimacySourceSignature(initial))
  assert.notEqual(
    createIntimacySourceSignature(initial),
    createIntimacySourceSignature([message(1), message(2, { content: 'changed' })])
  )
  assert.notEqual(createIntimacySourceSignature(initial), createIntimacySourceSignature([...initial, message(3)]))
  assert.notEqual(
    createIntimacySourceSignature(initial),
    createIntimacySourceSignature([message(1), message(2, { senderId: 2 })])
  )
})

test('loading a private chat drops system messages, empties non-text content and honours the range', (t) => {
  const db = createPrivateSession(makeTempDir())
  t.after(() => db.close())

  const source = loadIntimacySource(db, { kinds: ['sharing'], startTs: baseTs, endTs: baseTs + 100 })

  assert.deepEqual(
    source.messages.map((item) => [item.id, item.isText, item.content]),
    [
      [1, true, '今天面试终于结束了'],
      [2, true, 'How did it go?'],
      [3, false, ''],
      [5, false, ''],
    ]
  )
  assert.equal(source.sourceMessageCount, 4)
  assert.equal(source.sourceMaxMessageId, 5)
  assert.equal(source.targetEndTs, baseTs + 100)
  assert.deepEqual(source.members, [
    { memberId: 1, name: 'Alice', isOwner: true },
    { memberId: 2, name: 'Bob', isOwner: false },
  ])

  const estimate = estimateIntimacyWindows(db, { startTs: baseTs, endTs: baseTs + 100 })
  assert.equal(estimate.messageCount, 4)
  assert.equal(estimate.textMessageCount, 2)
  assert.equal(estimate.estimatedWindows, 1)

  const full = loadIntimacySource(db, { kinds: ['sharing'] })
  assert.equal(full.sourceMessageCount, 5)
})

/**
 * A private chat whose member table holds more than two rows, the way a WeChat export lists the participants of
 * forwarded chat records. `ownerId` is null when the export does not name the owner.
 */
function createPrivateSessionWithExtraMembers(root: string, ownerId: string | null) {
  const dbPath = path.join(root, 'extra-members.db')
  const raw = new Database(dbPath, { nativeBinding })
  raw.exec(CHAT_DB_SCHEMA)
  raw
    .prepare(
      `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES ('Chat', 'wechat', 'private', ?, ?, 10)`
    )
    .run(baseTs, ownerId)
  const member = raw.prepare('INSERT INTO member (id, platform_id, account_name) VALUES (?, ?, ?)')
  member.run(1, 'alice', 'Alice')
  member.run(2, 'bob', 'Bob')
  member.run(3, 'system', '系统消息')
  member.run(4, 'carol', 'Carol')
  member.run(5, 'dave', 'Dave')
  const insert = raw.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
  insert.run(1, 2, baseTs + 10, 0, 'Bob writes first')
  insert.run(2, 1, baseTs + 20, 0, 'Alice answers')
  insert.run(3, 2, baseTs + 30, 0, 'Bob again')
  insert.run(4, 4, baseTs + 40, 0, 'a stray message attributed to a forwarded participant')
  insert.run(5, 3, baseTs + 50, 80, '对方撤回了一条消息')
  raw.close()
  return openBetterSqliteDatabase(dbPath, { nativeBinding, readonly: true })
}

test('a private chat keeps the two people who wrote in it and leaves the other member rows out', (t) => {
  const db = createPrivateSessionWithExtraMembers(makeTempDir(), 'alice')
  t.after(() => db.close())

  assert.deepEqual(resolveIntimacyMembers(db), [
    { memberId: 1, name: 'Alice', isOwner: true },
    { memberId: 2, name: 'Bob', isOwner: false },
  ])
  const source = loadIntimacySource(db, { kinds: ['sharing'] })
  assert.deepEqual(
    source.messages.map((item) => item.id),
    [1, 2, 3]
  )
  assert.equal(source.sourceMessageCount, 3)
  assert.equal(source.sourceMaxMessageId, 3)
  const range = { startTs: baseTs, endTs: baseTs + 100 }
  assert.equal(estimateIntimacyWindows(db, range).messageCount, 3)
  assert.deepEqual(readIntimacySourceFingerprint(db, range), { messageCount: 3, maxMessageId: 3 })
})

test('without a named owner the two participants are the two who wrote most, ties going to the older row', (t) => {
  const db = createPrivateSessionWithExtraMembers(makeTempDir(), null)
  t.after(() => db.close())

  // Bob wrote twice; Alice and Carol once each, and Alice is the older member row.
  assert.deepEqual(resolveIntimacyMembers(db), [
    { memberId: 1, name: 'Alice', isOwner: false },
    { memberId: 2, name: 'Bob', isOwner: false },
  ])
})

test('a chat that is not a conversation between two people who wrote is rejected', (t) => {
  const root = makeTempDir()
  const groupPath = path.join(root, 'group.db')
  const group = new Database(groupPath, { nativeBinding })
  group.exec(CHAT_DB_SCHEMA)
  group
    .prepare(
      `INSERT INTO meta (name, platform, type, imported_at, schema_version) VALUES ('Group', 'wechat', 'group', ?, 10)`
    )
    .run(baseTs)
  group.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  group.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
  group.close()
  const groupDb = openBetterSqliteDatabase(groupPath, { nativeBinding, readonly: true })
  t.after(() => groupDb.close())

  // A private chat where only one person ever wrote.
  const soloPath = path.join(root, 'solo.db')
  const solo = new Database(soloPath, { nativeBinding })
  solo.exec(CHAT_DB_SCHEMA)
  solo
    .prepare(
      `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES ('Chat', 'wechat', 'private', ?, 'alice', 10)`
    )
    .run(baseTs)
  solo.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  solo.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
  solo.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (1, 1, ?, 0, ?)').run(baseTs + 10, 'hi')
  solo.close()
  const soloDb = openBetterSqliteDatabase(soloPath, { nativeBinding, readonly: true })
  t.after(() => soloDb.close())

  for (const db of [groupDb, soloDb]) {
    assert.throws(
      () => resolveIntimacyMembers(db),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )
  }
})
