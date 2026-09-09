/**
 * Attachment schema top-up.
 *
 * Guards the upgrade path for user databases: a chat database created by an
 * earlier build must gain the new attachment columns without losing rows, and
 * opening it again must not fail on the columns that are already there — the
 * browser runtime replays this on every open.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteTestAdapter } from '../query/__tests__/sqlite-test-adapter'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { ensureAttachmentSchema } from './ensure-attachment-schema'
import { CHAT_DB_TABLES } from './tables'

/** The attachment table exactly as schema version 12 first shipped it. */
const SCHEMA_V12_ATTACHMENT_TABLE = `
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
    height INTEGER,
    FOREIGN KEY(message_id) REFERENCES message(id)
  );
`

function columnNames(db: SqliteTestAdapter, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
}

test('an older attachment table gains the transcript columns and keeps its rows', () => {
  const db = new SqliteTestAdapter(openTestSqliteDatabase())
  db.exec(CHAT_DB_TABLES.replace(/CREATE TABLE IF NOT EXISTS message_attachment[\s\S]*?\);/, ''))
  db.exec(SCHEMA_V12_ATTACHMENT_TABLE)
  db.raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  db.raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 2, '[语音 3秒]')`).run()
  db.raw
    .prepare(`INSERT INTO message_attachment (message_id, kind, relative_path) VALUES (1, 'audio', 'voice/1.wav')`)
    .run()

  ensureAttachmentSchema(db)

  const columns = columnNames(db, 'message_attachment')
  for (const column of ['transcript', 'transcript_model', 'transcribed_at']) {
    assert.ok(columns.includes(column), `missing column ${column}`)
  }
  assert.deepEqual(db.raw.prepare('SELECT id, relative_path, transcript FROM message_attachment').all(), [
    { id: 1, relative_path: 'voice/1.wav', transcript: null },
  ])

  // Replaying it (browser open, repeated migration) must not fail or duplicate columns.
  ensureAttachmentSchema(db)
  assert.deepEqual(columnNames(db, 'message_attachment'), columns)
  db.close()
})

test('a database without the attachment table gets the current shape', () => {
  const db = new SqliteTestAdapter(openTestSqliteDatabase())
  db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY, name TEXT)')

  ensureAttachmentSchema(db)

  const columns = columnNames(db, 'message_attachment')
  assert.ok(columns.includes('transcript'))
  assert.ok(columns.includes('transcribed_at'))
  // The meta top-up from schema version 12 still runs.
  assert.ok(columnNames(db, 'meta').includes('source_dir'))
  db.close()
})
