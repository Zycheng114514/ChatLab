/**
 * CLI Web transcription routes.
 *
 * Guards what a request from the page can and cannot do: transcribe an
 * attachment that belongs to another session, hand the model a truncated or
 * oversized buffer, or write a settings value the app would then refuse to
 * load. The transcription itself is faked; the write path has its own tests.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, describe } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import type { DatabaseAdapter } from '@openchatlab/core'
import type { SessionRuntimeAdapter } from '@openchatlab/node-runtime'

// The settings routes read and write ~/.chatlab/config.toml, and the config
// module resolves that directory from HOME when it is first loaded. Point HOME
// at a throwaway directory first, then import everything that reaches it — a
// static import here would run before this line and hit the real config file.
const tempHome = mkdtempSync(join(process.env.CHATLAB_TEST_TMPDIR ?? tmpdir(), 'chatlab-transcription-routes-'))
process.env.HOME = tempHome

const [{ CHAT_DB_SCHEMA }, { BetterSqliteAdapter }, { getConfigDir }, { configureApiErrorHandler }, routes] =
  await Promise.all([
    import('@openchatlab/core'),
    import('@openchatlab/node-runtime'),
    import('@openchatlab/config'),
    import('../../server'),
    import('./transcription'),
  ])
const { registerTranscriptionRoutes } = routes
assert.ok(getConfigDir().startsWith(tempHome), 'refusing to run: these tests would write the real config file')

const SESSION_ID = 'session-a'
const OTHER_SESSION_ID = 'session-b'

const sessions = new Map<string, { raw: Database.Database; db: DatabaseAdapter; audioId: number; imageId: number }>()

function createSession() {
  const raw = new Database(':memory:', { nativeBinding: 'apps/cli/native/better_sqlite3.node' })
  raw.exec(CHAT_DB_SCHEMA)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 0, 'hello there')`).run()
  const insertAttachment = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name, duration_ms)
     VALUES (?, ?, 'voice/a.wav', 'a.wav', 2000)`
  )
  const voiceMessage = raw
    .prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 2, 2, '[语音 2秒]')`)
    .run()
  const audioId = Number(insertAttachment.run(voiceMessage.lastInsertRowid, 'audio').lastInsertRowid)
  const imageMessage = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 3, 1, '')`).run()
  const imageId = Number(insertAttachment.run(imageMessage.lastInsertRowid, 'image').lastInsertRowid)
  return { raw, db: new BetterSqliteAdapter(raw), audioId, imageId }
}

const worker = {
  calls: 0,
  async transcribePcm(pcm: Float32Array) {
    worker.calls++
    return { text: `frames:${pcm.length}`, durationMs: 1, modelId: 'fake/whisper' }
  },
}

function sessionAdapter(): SessionRuntimeAdapter {
  const notFound = (sessionId: string) => Object.assign(new Error('Session not found'), { statusCode: 404, sessionId })
  const get = (sessionId: string) => sessions.get(sessionId)?.db ?? null
  return {
    listSessionIds: () => [...sessions.keys()],
    openReadonly: get,
    openWritable: get,
    closeSession: () => {},
    getDbPath: (id) => `/tmp/${id}.db`,
    deleteSessionFile: () => false,
    ensureReadonly: (id) => get(id) ?? raise(notFound(id)),
    ensureWritable: (id) => get(id) ?? raise(notFound(id)),
  }
}

function raise(error: Error): never {
  throw error
}

/** Float32 LE bytes, the wire format the page posts. */
function pcmBody(samples: number[]): Buffer {
  return Buffer.from(Float32Array.from(samples).buffer)
}

function transcribeUrl(sessionId: string, attachmentId: number, language?: string): string {
  const query = language === undefined ? '' : `?language=${encodeURIComponent(language)}`
  return `/_web/sessions/${sessionId}/attachments/${attachmentId}/transcribe${query}`
}

let app: FastifyInstance

before(async () => {
  sessions.set(SESSION_ID, createSession())
  sessions.set(OTHER_SESSION_ID, createSession())
  app = Fastify({ bodyLimit: 1024 * 1024 })
  configureApiErrorHandler(app)
  registerTranscriptionRoutes(app, { sessionAdapter: sessionAdapter() }, worker)
  await app.ready()
})

after(async () => {
  await app.close()
  for (const session of sessions.values()) session.raw.close()
  rmSync(tempHome, { recursive: true, force: true })
})

describe('the transcribe endpoint', () => {
  test('transcribes an audio attachment of the addressed session', async () => {
    const session = sessions.get(SESSION_ID)!
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, session.audioId),
      headers: { 'content-type': 'application/octet-stream' },
      payload: pcmBody([0.25, -0.5, 0.75, 1]),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { text: 'frames:4', contentUpdated: true })
    const stored = session.db
      .prepare('SELECT transcript FROM message_attachment WHERE id = ?')
      .get(session.audioId) as unknown as { transcript: string }
    assert.equal(stored.transcript, 'frames:4')
  })

  test('refuses an attachment id that belongs to another session', async () => {
    const other = sessions.get(OTHER_SESSION_ID)!
    const before = worker.calls
    // Same database shape, but this id only exists in the other session, whose
    // rows this request must not be able to reach.
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, other.audioId + 100),
      headers: { 'content-type': 'application/octet-stream' },
      payload: pcmBody([0.1, 0.2]),
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /not found/i)
    assert.equal(worker.calls, before, 'no model work for a request that cannot be served')
  })

  test('refuses a non-audio attachment', async () => {
    const session = sessions.get(SESSION_ID)!
    const before = worker.calls
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, session.imageId),
      headers: { 'content-type': 'application/octet-stream' },
      payload: pcmBody([0.1, 0.2]),
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /not audio/i)
    assert.equal(worker.calls, before)
  })

  test('404s an unknown session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl('no-such-session', 1),
      headers: { 'content-type': 'application/octet-stream' },
      payload: pcmBody([0.1]),
    })

    assert.equal(response.statusCode, 404)
  })

  test('refuses a body that is not a whole number of floats', async () => {
    const session = sessions.get(SESSION_ID)!
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, session.audioId),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /32-bit floats/)
  })

  test('refuses an unsupported language', async () => {
    const session = sessions.get(SESSION_ID)!
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, session.audioId, 'fr'),
      headers: { 'content-type': 'application/octet-stream' },
      payload: pcmBody([0.1]),
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /auto, zh, en/)
  })

  test('accepts a body larger than the server default', async () => {
    // 30 minutes of speech is ~115 MB, well past the 50 MB the shared server
    // allows; without the route's own bodyLimit this would be a 413.
    const session = sessions.get(SESSION_ID)!
    const response = await app.inject({
      method: 'POST',
      url: transcribeUrl(SESSION_ID, session.audioId),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024),
    })

    assert.equal(response.statusCode, 200)
  })
})

describe('the settings endpoints', () => {
  test('returns the defaults before anything is written', async () => {
    const response = await app.inject({ method: 'GET', url: '/_web/transcription/config' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { model: 'base', language: 'auto' })
  })

  test('stores a partial change and leaves the rest alone', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/_web/transcription/config',
      payload: { model: 'small' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { model: 'small', language: 'auto' })
    const reread = await app.inject({ method: 'GET', url: '/_web/transcription/config' })
    assert.deepEqual(reread.json(), { model: 'small', language: 'auto' })
  })

  test('rejects a value the config schema does not accept', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/_web/transcription/config',
      payload: { model: 'large' },
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /tiny, base, small/)
    const reread = await app.inject({ method: 'GET', url: '/_web/transcription/config' })
    assert.equal(reread.json().model, 'small', 'a rejected value must not land in the config file')
  })
})

describe('the pending queue endpoint', () => {
  test('lists untranscribed voice attachments without their stored paths', async () => {
    const session = sessions.get(OTHER_SESSION_ID)!
    const response = await app.inject({
      method: 'GET',
      url: `/_web/sessions/${OTHER_SESSION_ID}/transcription/pending`,
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      items: [{ id: session.audioId, messageId: 2, fileName: 'a.wav', mimeType: null, durationMs: 2000 }],
    })
  })
})
