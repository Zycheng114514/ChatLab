import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { BetterSqliteAdapter } from '../better-sqlite3-adapter'
import { MESSAGE_INSERT_MAX_ROWS, MessageBatchInserter, type MessageInsertRow } from './message-batch-inserter'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const attachmentSchema = `
  CREATE TABLE message_attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_name TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER
  )
`
const messageSchema = `
  CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    sender_account_name TEXT,
    sender_group_nickname TEXT,
    ts INTEGER NOT NULL,
    type INTEGER NOT NULL CHECK(type >= 0),
    content TEXT,
    reply_to_message_id TEXT,
    platform_message_id TEXT
  )
`

function makeRows(count: number): MessageInsertRow[] {
  return Array.from({ length: count }, (_, index) => ({
    senderId: (index % 7) + 1,
    senderAccountName: index % 3 === 0 ? null : `account-${index % 7}`,
    senderGroupNickname: index % 4 === 0 ? '' : `nickname-${index % 5}`,
    timestamp: 1_700_000_000 + index,
    type: index % 10,
    content: index % 6 === 0 ? null : `content-${index}`,
    replyToMessageId: index % 8 === 0 ? `reply-${index - 1}` : null,
    platformMessageId: index % 9 === 0 ? null : `message-${index}`,
  }))
}

function readMessages(db: Database.Database): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT
         id,
         sender_id,
         sender_account_name,
         sender_group_nickname,
         ts,
         type,
         content,
         reply_to_message_id,
         platform_message_id
       FROM message
       ORDER BY id`
    )
    .all() as Record<string, unknown>[]
}

test('MessageBatchInserter preserves row order and nullable values across SQLite variable-limit chunks', () => {
  const batchRaw = new Database(':memory:', { nativeBinding })
  const referenceRaw = new Database(':memory:', { nativeBinding })
  batchRaw.exec(messageSchema)
  referenceRaw.exec(messageSchema)

  const rows = makeRows(MESSAGE_INSERT_MAX_ROWS * 2 + 7)
  const statementCount = new MessageBatchInserter(new BetterSqliteAdapter(batchRaw)).insert(rows)
  const referenceInsert = referenceRaw.prepare(
    `INSERT INTO message (
       sender_id,
       sender_account_name,
       sender_group_nickname,
       ts,
       type,
       content,
       reply_to_message_id,
       platform_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const row of rows) {
    referenceInsert.run(
      row.senderId,
      row.senderAccountName,
      row.senderGroupNickname,
      row.timestamp,
      row.type,
      row.content,
      row.replyToMessageId,
      row.platformMessageId
    )
  }

  assert.equal(statementCount, 3)
  assert.deepEqual(readMessages(batchRaw), readMessages(referenceRaw))
  batchRaw.close()
  referenceRaw.close()
})

test('MessageBatchInserter failure can roll back the complete active transaction', () => {
  const raw = new Database(':memory:', { nativeBinding })
  raw.exec(messageSchema)
  const db = new BetterSqliteAdapter(raw)
  const rows = makeRows(3)
  rows[1] = { ...rows[1], type: -1 }

  db.exec('BEGIN TRANSACTION')
  assert.throws(() => new MessageBatchInserter(db).insert(rows), /CHECK constraint failed/)
  db.exec('ROLLBACK')

  assert.equal((raw.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }).count, 0)
  raw.close()
})

test('MessageBatchInserter links attachments to their own message across variable-limit chunks', () => {
  const raw = new Database(':memory:', { nativeBinding })
  raw.exec(messageSchema)
  raw.exec(attachmentSchema)

  // Attachments on a subset of rows in every chunk: a one-row mapping slip renames the wrong message's file.
  const rows = makeRows(MESSAGE_INSERT_MAX_ROWS * 2 + 7).map((row, index) =>
    index % 5 === 0
      ? {
          ...row,
          attachments: [
            { kind: 'image' as const, path: `${row.timestamp}.jpg`, name: 'photo.jpg', size: 1024, width: 40 },
            ...(index % 10 === 0 ? [{ kind: 'file' as const, path: `${row.timestamp}.pdf` }] : []),
          ],
        }
      : row
  )

  new MessageBatchInserter(new BetterSqliteAdapter(raw)).insert(rows)

  const linked = raw
    .prepare(
      `SELECT m.ts AS ts, a.kind AS kind, a.relative_path AS relativePath, a.file_name AS fileName,
              a.size_bytes AS sizeBytes, a.width AS width, a.mime_type AS mimeType
       FROM message_attachment a
       JOIN message m ON m.id = a.message_id
       ORDER BY a.id`
    )
    .all() as Array<Record<string, unknown>>

  const expected = rows.flatMap((row) =>
    (row.attachments ?? []).map((attachment) => ({
      ts: row.timestamp,
      kind: attachment.kind,
      relativePath: attachment.path,
      fileName: attachment.name ?? null,
      sizeBytes: attachment.size ?? null,
      width: attachment.width ?? null,
      mimeType: null,
    }))
  )

  assert.equal(linked.length, expected.length)
  assert.deepEqual(linked, expected)
  raw.close()
})

test('MessageBatchInserter writes no attachment rows when no message has attachments', () => {
  const raw = new Database(':memory:', { nativeBinding })
  raw.exec(messageSchema)
  // No message_attachment table: the inserter must not touch it for attachment-free imports.
  new MessageBatchInserter(new BetterSqliteAdapter(raw)).insert(makeRows(20))
  assert.equal((raw.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }).count, 20)
  raw.close()
})
