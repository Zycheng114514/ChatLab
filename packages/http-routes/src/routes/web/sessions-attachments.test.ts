import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type DatabaseAdapter } from '@openchatlab/core'
import { BetterSqliteAdapter } from '@openchatlab/node-runtime/src/better-sqlite3-adapter'
import { registerSessionRoutes } from './sessions'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')

type SessionRouteContext = Parameters<typeof registerSessionRoutes>[1]

function makeTempDir(t: TestContext): string {
  const baseDir = process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir())
  const dir = fs.mkdtempSync(path.join(baseDir, 'chatlab-attachment-routes-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Session DB with one in-tree image and one attachment pointing outside the export directory. */
function createSession(t: TestContext): { db: DatabaseAdapter; sourceDir: string; secretPath: string } {
  const root = makeTempDir(t)
  const sourceDir = path.join(root, 'export')
  fs.mkdirSync(path.join(sourceDir, 'images'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'images', 'a.png'), 'png-bytes')
  const secretPath = path.join(root, 'secret.txt')
  fs.writeFileSync(secretPath, 'secret')

  const raw = new Database(':memory:', { nativeBinding })
  t.after(() => raw.close())
  raw.exec(CHAT_DB_SCHEMA)
  raw
    .prepare(`INSERT INTO meta (name, platform, type, imported_at, source_dir) VALUES ('S','wechat','group',1,?)`)
    .run(sourceDir)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1','Alice')`).run()
  raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 1, '[图片]')`).run()
  const insert = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name) VALUES (1, 'image', ?, ?)`
  )
  insert.run('images/a.png', 'a.png')
  insert.run('../secret.txt', 'secret.txt')
  insert.run('images/missing.png', 'missing.png')

  return { db: new BetterSqliteAdapter(raw), sourceDir, secretPath }
}

function createApp(db: DatabaseAdapter) {
  const app = Fastify()
  registerSessionRoutes(app, {
    sessionAdapter: { ensureReadonly: () => db },
    pathProvider: { getCacheDir: () => '/tmp' },
  } as unknown as SessionRouteContext)
  return app
}

describe('GET /_web/sessions/:id/attachments/:attachmentId', () => {
  it('serves an attachment inside the import directory', async (t) => {
    const { db } = createSession(t)
    const app = createApp(db)
    t.after(() => app.close())
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/_web/sessions/s1/attachments/1' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'image/png')
    assert.equal(response.body, 'png-bytes')
  })

  it('refuses an attachment path that escapes the import directory', async (t) => {
    const { db, secretPath } = createSession(t)
    assert.ok(fs.existsSync(secretPath))
    const app = createApp(db)
    t.after(() => app.close())
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/_web/sessions/s1/attachments/2' })
    assert.equal(response.statusCode, 404)
  })

  it('returns 404 for a missing file and for an unknown attachment id', async (t) => {
    const { db } = createSession(t)
    const app = createApp(db)
    t.after(() => app.close())
    await app.ready()

    assert.equal((await app.inject({ method: 'GET', url: '/_web/sessions/s1/attachments/3' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/_web/sessions/s1/attachments/999' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/_web/sessions/s1/attachments/abc' })).statusCode, 404)
  })
})
