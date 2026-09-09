/**
 * Session transcription queue.
 *
 * Guards what a user sees when they transcribe a chat: every audio message the
 * Node side can read gets its text, files it cannot read are reported instead
 * of silently dropped, one bad file does not strand the rest of the queue, and
 * a second run does not re-transcribe (and re-charge for) finished attachments.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { BetterSqliteAdapter } from '../better-sqlite3-adapter'
import { createChatLabTempDir } from '../temp-workspace'
import { planSessionTranscription, transcribeSessionAttachments, type Transcriber } from './service'

/** 16 kHz mono 16-bit WAV with `frames` samples of silence. */
function writeWav(filePath: string, frames: number): void {
  const dataSize = frames * 2
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + dataSize, 4)
  bytes.write('WAVEfmt ', 8, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20) // PCM
  bytes.writeUInt16LE(1, 22) // mono
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataSize, 40)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, bytes)
}

interface AttachmentSeed {
  relativePath: string
  fileName: string
  content?: string
  transcript?: string | null
  /** Frames to write; omit to leave the file missing on disk. */
  frames?: number
}

function createSession(seeds: AttachmentSeed[]) {
  const sourceDir = createChatLabTempDir('tests', 'transcription-')
  const raw = openTestSqliteDatabase()
  raw.exec(CHAT_DB_SCHEMA)
  raw
    .prepare(`INSERT INTO meta (name, platform, type, imported_at, source_dir) VALUES ('S', 'wechat', 'group', 1, ?)`)
    .run(sourceDir)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  const insertMessage = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 2, ?)`)
  const insertAttachment = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name, duration_ms, transcript)
     VALUES (?, 'audio', ?, ?, 2000, ?)`
  )
  for (const seed of seeds) {
    const { lastInsertRowid } = insertMessage.run(seed.content ?? '[语音 2秒]')
    insertAttachment.run(lastInsertRowid, seed.relativePath, seed.fileName, seed.transcript ?? null)
    if (seed.frames !== undefined) writeWav(path.join(sourceDir, seed.relativePath), seed.frames)
  }
  return { raw, db: new BetterSqliteAdapter(raw), sourceDir }
}

/** Answers with the sample count so the test can prove the decoded audio arrived. */
function fakeTranscriber(
  failOn: (pcm: Float32Array) => boolean = () => false
): Pick<Transcriber, 'modelId' | 'transcribePcm'> {
  return {
    modelId: 'fake/whisper',
    async transcribePcm(pcm) {
      if (failOn(pcm)) throw new Error('model exploded')
      return { text: `frames:${pcm.length}`, durationMs: 1 }
    },
  }
}

test('the queue transcribes what it can and reports the rest', async () => {
  const { raw, db } = createSession([
    { relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 },
    { relativePath: 'voice/2.silk', fileName: '2.silk', frames: 100 },
    { relativePath: 'voice/3.wav', fileName: '3.wav', frames: 200, transcript: 'already done' },
    { relativePath: 'https://cdn.example.com/4.wav', fileName: '4.wav' },
    { relativePath: 'voice/5.wav', fileName: '5.wav' },
    { relativePath: 'voice/6.wav', fileName: '6.wav', frames: 300 },
  ])
  const progress: Array<{ attachmentId: number; status: string; completed: number; total: number }> = []

  const result = await transcribeSessionAttachments({
    db,
    transcriber: fakeTranscriber(),
    sessionId: 'session-1',
    language: 'zh',
    onProgress: (event) => progress.push(event),
  })

  assert.equal(result.transcribed, 2)
  assert.deepEqual(result.skipped, [
    { attachmentId: 2, fileName: '2.silk', reason: 'unsupported-format' },
    { attachmentId: 4, fileName: '4.wav', reason: 'unreadable-path' },
  ])
  // The missing file fails on its own without stopping attachment 6.
  assert.deepEqual(
    result.failed.map((failure) => failure.attachmentId),
    [5]
  )
  assert.match(result.failed[0].error, /ENOENT|no such file/i)
  assert.deepEqual(
    progress.map((event) => [event.attachmentId, event.status, event.completed, event.total]),
    [
      [1, 'transcribed', 1, 3],
      [5, 'failed', 2, 3],
      [6, 'transcribed', 3, 3],
    ]
  )

  // Text reaches both the attachment row and the message, and the already-transcribed row is untouched.
  assert.deepEqual(raw.prepare('SELECT id, transcript FROM message_attachment ORDER BY id').all(), [
    { id: 1, transcript: 'frames:100' },
    { id: 2, transcript: null },
    { id: 3, transcript: 'already done' },
    { id: 4, transcript: null },
    { id: 5, transcript: null },
    { id: 6, transcript: 'frames:300' },
  ])
  assert.deepEqual(raw.prepare('SELECT id, content FROM message ORDER BY id').all(), [
    { id: 1, content: '[语音 2秒] frames:100' },
    { id: 2, content: '[语音 2秒]' },
    { id: 3, content: '[语音 2秒]' },
    { id: 4, content: '[语音 2秒]' },
    { id: 5, content: '[语音 2秒]' },
    { id: 6, content: '[语音 2秒] frames:300' },
  ])
  raw.close()
})

test('a second run only picks up what the first one left behind', async () => {
  const { raw, db } = createSession([
    { relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 },
    { relativePath: 'voice/2.wav', fileName: '2.wav', frames: 200 },
  ])

  // Attachment 2 fails on the first pass, so it must still be pending afterwards.
  const flaky = fakeTranscriber((pcm) => pcm.length === 200)
  const first = await transcribeSessionAttachments({ db, transcriber: flaky, sessionId: 'session-1' })
  assert.deepEqual([first.transcribed, first.failed.length], [1, 1])

  const second = await transcribeSessionAttachments({ db, transcriber: fakeTranscriber(), sessionId: 'session-1' })
  assert.equal(second.transcribed, 1)
  assert.deepEqual(raw.prepare('SELECT id, transcript FROM message_attachment ORDER BY id').all(), [
    { id: 1, transcript: 'frames:100' },
    { id: 2, transcript: 'frames:200' },
  ])
  raw.close()
})

test('a dry run reports the plan without touching the database', () => {
  const { raw, db } = createSession([
    { relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 },
    { relativePath: 'voice/2.amr', fileName: '2.amr', frames: 100 },
  ])

  const plan = planSessionTranscription(db)

  assert.deepEqual(
    plan.pending.map((candidate) => [candidate.attachmentId, candidate.decoder.id]),
    [[1, 'wav']]
  )
  assert.deepEqual(plan.skipped, [{ attachmentId: 2, fileName: '2.amr', reason: 'unsupported-format' }])
  assert.deepEqual(
    plan.pending.map((candidate) => candidate.durationMs),
    [2000]
  )
  assert.deepEqual(raw.prepare('SELECT COUNT(*) AS n FROM message_attachment WHERE transcript IS NOT NULL').get(), {
    n: 0,
  })
  raw.close()
})

test('an explicit attachment list restricts the run', async () => {
  const { raw, db } = createSession([
    { relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 },
    { relativePath: 'voice/2.wav', fileName: '2.wav', frames: 200 },
  ])

  const result = await transcribeSessionAttachments({
    db,
    transcriber: fakeTranscriber(),
    sessionId: 'session-1',
    attachmentIds: [2],
  })

  assert.equal(result.transcribed, 1)
  assert.deepEqual(raw.prepare('SELECT id, transcript FROM message_attachment ORDER BY id').all(), [
    { id: 1, transcript: null },
    { id: 2, transcript: 'frames:200' },
  ])
  raw.close()
})

test('a Chinese queue run stores transcripts in the script the session uses', async () => {
  const { raw, db } = createSession([
    { relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 },
    { relativePath: 'voice/2.wav', fileName: '2.wav', frames: 200 },
  ])
  // Whisper's Chinese output is traditional whatever the chat is written in.
  const transcriber = { modelId: 'fake/whisper', transcribePcm: async () => ({ text: '謝謝,明天見', durationMs: 1 }) }

  const result = await transcribeSessionAttachments({
    db,
    transcriber,
    sessionId: 'session-1',
    language: 'zh',
    chineseScript: 'simplified',
  })

  assert.equal(result.transcribed, 2)
  assert.deepEqual(raw.prepare('SELECT id, transcript FROM message_attachment ORDER BY id').all(), [
    { id: 1, transcript: '谢谢,明天见' },
    { id: 2, transcript: '谢谢,明天见' },
  ])
  raw.close()
})

test('an English queue run keeps the transcript exactly as the model wrote it', async () => {
  const { raw, db } = createSession([{ relativePath: 'voice/1.wav', fileName: '1.wav', frames: 100 }])
  const transcriber = { modelId: 'fake/whisper', transcribePcm: async () => ({ text: '謝謝,明天見', durationMs: 1 }) }

  await transcribeSessionAttachments({
    db,
    transcriber,
    sessionId: 'session-1',
    language: 'en',
    chineseScript: 'simplified',
  })

  assert.deepEqual(raw.prepare('SELECT id, transcript FROM message_attachment ORDER BY id').all(), [
    { id: 1, transcript: '謝謝,明天見' },
  ])
  raw.close()
})
