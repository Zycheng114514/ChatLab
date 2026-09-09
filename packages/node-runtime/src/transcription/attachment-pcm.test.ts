/**
 * Single-attachment PCM transcription (the desktop / CLI Web entry point).
 *
 * Guards what reaches the user's database when the samples arrive from a
 * browser instead of a file: only real audio attachments are transcribed, an
 * over-long buffer is refused instead of silently truncated, and the transcript
 * lands on the attachment row without ever overwriting real message text.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_DB_SCHEMA, type DatabaseAdapter } from '@openchatlab/core'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { BetterSqliteAdapter } from '../better-sqlite3-adapter'
import {
  MAX_TRANSCRIPTION_PCM_SAMPLES,
  transcribeAttachmentPcm,
  TranscribeAttachmentPcmError,
  type Transcriber,
} from './service'

interface AttachmentSeed {
  kind: string
  /** Message text the attachment hangs off; a placeholder is replaceable, real text is not. */
  content: string
}

function createSession(seeds: AttachmentSeed[], sessionText = '这是一段中文聊天记录') {
  const raw = openTestSqliteDatabase()
  raw.exec(CHAT_DB_SCHEMA)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  // One Chinese text message so `auto` resolves to zh; its script is what the
  // transcript's script is matched against.
  raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 0, ?)`).run(sessionText)
  const insertMessage = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 2, 2, ?)`)
  const insertAttachment = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name, duration_ms)
     VALUES (?, ?, 'voice/a.wav', 'a.wav', 2000)`
  )
  const attachmentIds: number[] = []
  for (const seed of seeds) {
    const { lastInsertRowid } = insertMessage.run(seed.content)
    attachmentIds.push(Number(insertAttachment.run(lastInsertRowid, seed.kind).lastInsertRowid))
  }
  return { raw, db: new BetterSqliteAdapter(raw), attachmentIds }
}

/** Records the language it was told and echoes the sample count back as text. */
function fakeTranscriber(text?: string): Pick<Transcriber, 'modelId' | 'transcribePcm'> & { languages: string[] } {
  const languages: string[] = []
  return {
    modelId: 'fake/whisper',
    languages,
    async transcribePcm(pcm, { language }) {
      languages.push(language)
      return { text: text ?? `frames:${pcm.length}`, durationMs: 1 }
    },
  }
}

function readAttachment(db: DatabaseAdapter, attachmentId: number) {
  return db
    .prepare('SELECT transcript, transcript_model, transcribed_at FROM message_attachment WHERE id = ?')
    .get(attachmentId) as unknown as { transcript: string | null; transcript_model: string | null }
}

function readContent(db: DatabaseAdapter, attachmentId: number): string {
  const row = db
    .prepare('SELECT m.content FROM message_attachment a JOIN message m ON m.id = a.message_id WHERE a.id = ?')
    .get(attachmentId) as unknown as { content: string }
  return row.content
}

test('a voice attachment gets its transcript on the row and in the message text', async (t) => {
  const { raw, db, attachmentIds } = createSession([{ kind: 'audio', content: '[语音 2秒]' }])
  t.after(() => raw.close())
  const transcriber = fakeTranscriber('晚点再聊')

  const result = await transcribeAttachmentPcm({
    db,
    transcriber,
    attachmentId: attachmentIds[0],
    pcm16k: new Float32Array(16000),
  })

  assert.deepEqual(result, { text: '晚点再聊', contentUpdated: true })
  assert.deepEqual(readAttachment(db, attachmentIds[0]).transcript, '晚点再聊')
  assert.equal(readAttachment(db, attachmentIds[0]).transcript_model, 'fake/whisper')
  assert.equal(readContent(db, attachmentIds[0]), '[语音 2秒] 晚点再聊')
  // `auto` was resolved against the session's Chinese messages, not handed to Whisper.
  assert.deepEqual(transcriber.languages, ['zh'])
})

test('an explicit language overrides what the session text suggests', async (t) => {
  const { raw, db, attachmentIds } = createSession([{ kind: 'audio', content: '[语音 2秒]' }])
  t.after(() => raw.close())
  const transcriber = fakeTranscriber()

  await transcribeAttachmentPcm({
    db,
    transcriber,
    attachmentId: attachmentIds[0],
    pcm16k: new Float32Array(16),
    language: 'en',
  })

  assert.deepEqual(transcriber.languages, ['en'])
})

test('silence is recorded on the row but never replaces the message text', async (t) => {
  const { raw, db, attachmentIds } = createSession([{ kind: 'audio', content: '[语音 2秒]' }])
  t.after(() => raw.close())

  const result = await transcribeAttachmentPcm({
    db,
    transcriber: fakeTranscriber(''),
    attachmentId: attachmentIds[0],
    pcm16k: new Float32Array(16),
  })

  assert.equal(result.contentUpdated, false)
  assert.equal(readAttachment(db, attachmentIds[0]).transcript, '')
  assert.equal(readContent(db, attachmentIds[0]), '[语音 2秒]')
})

const rejections: Array<{ name: string; seed: AttachmentSeed | null; samples: number; code: string }> = [
  { name: 'an unknown attachment id', seed: null, samples: 16, code: 'attachment-not-found' },
  { name: 'an image attachment', seed: { kind: 'image', content: '[图片]' }, samples: 16, code: 'not-audio' },
  {
    name: 'more than 30 minutes of audio',
    seed: { kind: 'audio', content: '[语音 2秒]' },
    samples: MAX_TRANSCRIPTION_PCM_SAMPLES + 1,
    code: 'pcm-too-long',
  },
]

for (const { name, seed, samples, code } of rejections) {
  test(`${name} is rejected with ${code} and nothing is written`, async (t) => {
    const { raw, db, attachmentIds } = createSession(seed ? [seed] : [{ kind: 'audio', content: '[语音 2秒]' }])
    t.after(() => raw.close())
    const transcriber = fakeTranscriber()
    const attachmentId = seed ? attachmentIds[0] : 9999

    await assert.rejects(
      () => transcribeAttachmentPcm({ db, transcriber, attachmentId, pcm16k: new Float32Array(samples) }),
      (error: unknown) => {
        assert.ok(error instanceof TranscribeAttachmentPcmError)
        assert.equal(error.code, code)
        return true
      }
    )
    // Nothing reached the model, so nothing could have reached the database.
    assert.deepEqual(transcriber.languages, [])
    if (seed) assert.equal(readAttachment(db, attachmentId).transcript, null)
  })
}

// ---------- Chinese script ----------

/** Whisper writes Chinese in traditional characters whatever the chat uses. */
const WHISPER_OUTPUT = '今天天氣不錯,我們出去走走吧'
const SIMPLIFIED = '今天天气不错,我们出去走走吧'

const scriptCases: Array<{
  name: string
  sessionText: string
  language?: 'auto' | 'zh' | 'en'
  chineseScript?: 'auto' | 'simplified' | 'traditional'
  expected: string
}> = [
  {
    name: 'auto converts to the simplified script the session is written in',
    sessionText: '这是一段中文聊天记录',
    expected: SIMPLIFIED,
  },
  {
    name: 'auto leaves a traditional session traditional',
    sessionText: '這是一段中文聊天記錄',
    expected: WHISPER_OUTPUT,
  },
  {
    name: 'traditional keeps traditional output even in a simplified session',
    sessionText: '这是一段中文聊天记录',
    chineseScript: 'traditional',
    expected: WHISPER_OUTPUT,
  },
  {
    name: 'simplified converts even in a traditional session',
    sessionText: '這是一段中文聊天記錄',
    chineseScript: 'simplified',
    expected: SIMPLIFIED,
  },
  {
    name: 'English transcripts are never touched',
    sessionText: 'this chat is in English',
    language: 'en',
    expected: WHISPER_OUTPUT,
  },
]

for (const { name, sessionText, language, chineseScript, expected } of scriptCases) {
  test(`Chinese script: ${name}`, async (t) => {
    const { raw, db, attachmentIds } = createSession([{ kind: 'audio', content: '[语音 2秒]' }], sessionText)
    t.after(() => raw.close())

    const result = await transcribeAttachmentPcm({
      db,
      transcriber: fakeTranscriber(WHISPER_OUTPUT),
      attachmentId: attachmentIds[0],
      pcm16k: new Float32Array(16),
      language,
      chineseScript,
    })

    assert.equal(result.text, expected)
    assert.equal(readAttachment(db, attachmentIds[0]).transcript, expected)
    assert.equal(readContent(db, attachmentIds[0]), `[语音 2秒] ${expected}`)
  })
}
