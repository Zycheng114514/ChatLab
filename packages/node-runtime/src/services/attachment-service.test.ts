import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { BetterSqliteAdapter } from '../better-sqlite3-adapter'
import { resolveAttachmentFile } from './attachment-service'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const SOURCE_DIR = '/home/user/export'

function createSessionDb(attachments: Array<{ path: string; name?: string | null; mimeType?: string | null }>) {
  const raw = new Database(':memory:', { nativeBinding })
  raw.exec(CHAT_DB_SCHEMA)
  raw
    .prepare(`INSERT INTO meta (name, platform, type, imported_at, source_dir) VALUES ('S', 'wechat', 'group', 1, ?)`)
    .run(SOURCE_DIR)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, 1, 1, '[图片]')`).run()
  const insert = raw.prepare(
    `INSERT INTO message_attachment (message_id, kind, relative_path, file_name, mime_type) VALUES (1, 'image', ?, ?, ?)`
  )
  for (const attachment of attachments) {
    insert.run(attachment.path, attachment.name ?? null, attachment.mimeType ?? null)
  }
  return { raw, db: new BetterSqliteAdapter(raw) }
}

test('attachment files resolve inside the import directory and nowhere else', () => {
  const { raw, db } = createSessionDb([
    { path: 'images/a.jpg' },
    { path: '../../etc/passwd' },
    { path: 'https://cdn.example.com/a.jpg' },
    { path: 'images/b.bin', name: 'report.bin', mimeType: 'application/x-custom' },
  ])

  assert.deepEqual(resolveAttachmentFile(db, 1), {
    absolutePath: '/home/user/export/images/a.jpg',
    fileName: 'a.jpg',
    contentType: 'image/jpeg',
  })
  // Traversal and remote URLs are refused before any file access.
  assert.equal(resolveAttachmentFile(db, 2), null)
  assert.equal(resolveAttachmentFile(db, 3), null)
  // A stored mime type and display name win over the extension guess.
  assert.deepEqual(resolveAttachmentFile(db, 4), {
    absolutePath: '/home/user/export/images/b.bin',
    fileName: 'report.bin',
    contentType: 'application/x-custom',
  })
  assert.equal(resolveAttachmentFile(db, 999), null)

  raw.close()
})

test('attachments of a session imported without a source directory cannot be opened', () => {
  const { raw, db } = createSessionDb([{ path: 'images/a.jpg' }, { path: '/mnt/media/a.jpg' }])
  raw.prepare('UPDATE meta SET source_dir = NULL').run()

  assert.equal(resolveAttachmentFile(db, 1), null)
  // An absolute path stands on its own; a push import can still point at real files.
  assert.deepEqual(resolveAttachmentFile(db, 2), {
    absolutePath: '/mnt/media/a.jpg',
    fileName: 'a.jpg',
    contentType: 'image/jpeg',
  })

  raw.close()
})
