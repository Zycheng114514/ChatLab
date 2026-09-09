/**
 * Voice transcript persistence.
 *
 * Guards the two user-visible promises of the transcription feature: a
 * transcript reaches the message text that search and analysis read, and it
 * never overwrites words the user (or the export) already had there.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA } from '../schema'
import { SqliteTestAdapter } from './__tests__/sqlite-test-adapter'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { applyTranscript, listPendingAudioAttachments } from './attachment-transcripts'

interface AttachmentSeed {
  content: string
  kind?: string
  durationMs?: number | null
  transcript?: string | null
}

function createSessionDb(seeds: AttachmentSeed[]) {
  const raw = openTestSqliteDatabase()
  raw.exec(CHAT_DB_SCHEMA)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  const insertMessage = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 2, ?)`)
  const insertAttachment = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name, duration_ms, transcript)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const [index, seed] of seeds.entries()) {
    const { lastInsertRowid } = insertMessage.run(seed.content)
    insertAttachment.run(
      lastInsertRowid,
      seed.kind ?? 'audio',
      `voice/${index}.wav`,
      `${index}.wav`,
      seed.durationMs === undefined ? 3200 : seed.durationMs,
      seed.transcript ?? null
    )
  }
  return { raw, db: new SqliteTestAdapter(raw) }
}

function contentOf(raw: Database.Database, attachmentId: number): string {
  const row = raw
    .prepare('SELECT m.content FROM message m JOIN message_attachment a ON a.message_id = m.id WHERE a.id = ?')
    .get(attachmentId) as { content: string }
  return row.content
}

test('a transcript replaces placeholder text but never the user own words', () => {
  const cases = [
    { name: 'empty content', content: '', expected: '[语音 3秒] 今天天气不错' },
    { name: 'whitespace only', content: '   ', expected: '[语音 3秒] 今天天气不错' },
    { name: 'voice placeholder', content: '[语音]', expected: '[语音 3秒] 今天天气不错' },
    { name: 'placeholder with duration', content: '[语音 3秒]', expected: '[语音 3秒] 今天天气不错' },
    { name: 'existing real text', content: '这是导出自带的转写结果', expected: '这是导出自带的转写结果' },
    { name: 'transcript already prefixed', content: '[语音 5秒] 旧的转写', expected: '[语音 5秒] 旧的转写' },
  ]
  const { raw, db } = createSessionDb(cases.map(({ content }) => ({ content })))

  for (const [index, { name, expected }] of cases.entries()) {
    const attachmentId = index + 1
    const result = applyTranscript(db, {
      attachmentId,
      text: '今天天气不错',
      model: 'onnx-community/whisper-base',
      now: 1_700_000_000_000,
    })
    assert.equal(contentOf(raw, attachmentId), expected, name)
    assert.equal(result.contentUpdated, expected.endsWith('今天天气不错'), name)

    // The attachment row records the transcript regardless of the message text.
    const row = raw
      .prepare('SELECT transcript, transcript_model, transcribed_at FROM message_attachment WHERE id = ?')
      .get(attachmentId) as { transcript: string; transcript_model: string; transcribed_at: number }
    assert.deepEqual(row, {
      transcript: '今天天气不错',
      transcript_model: 'onnx-community/whisper-base',
      transcribed_at: 1_700_000_000_000,
    })
  }
  raw.close()
})

test('the duration label is dropped when the importer recorded no duration', () => {
  const { raw, db } = createSessionDb([
    { content: '[语音]', durationMs: null },
    { content: '', durationMs: 0 },
  ])

  for (const attachmentId of [1, 2]) {
    applyTranscript(db, { attachmentId, text: 'hello chatlab', model: 'whisper-base', now: 1 })
    assert.equal(contentOf(raw, attachmentId), '[语音] hello chatlab')
  }
  raw.close()
})

test('an empty transcript is recorded without blanking the message', () => {
  const { raw, db } = createSessionDb([{ content: '[语音 3秒]' }])

  const result = applyTranscript(db, { attachmentId: 1, text: '   ', model: 'whisper-base', now: 1 })

  assert.equal(result.contentUpdated, false)
  assert.equal(contentOf(raw, 1), '[语音 3秒]')
  // Still marked as done so the queue does not retry it forever.
  assert.equal(listPendingAudioAttachments(db).length, 0)
  raw.close()
})

test('the queue only offers untranscribed audio attachments', () => {
  const { raw, db } = createSessionDb([
    { content: '[语音]' },
    { content: '[语音]', transcript: 'already done' },
    { content: '[图片]', kind: 'image' },
    { content: '[语音]' },
  ])

  assert.deepEqual(
    listPendingAudioAttachments(db).map((row) => row.id),
    [1, 4]
  )
  assert.deepEqual(
    listPendingAudioAttachments(db, [4, 2, 3]).map((row) => row.id),
    [4]
  )
  assert.deepEqual(listPendingAudioAttachments(db, []), [])

  const [first] = listPendingAudioAttachments(db)
  assert.deepEqual(first, {
    id: 1,
    messageId: 1,
    path: 'voice/0.wav',
    fileName: '0.wav',
    mimeType: null,
    durationMs: 3200,
  })
  raw.close()
})
