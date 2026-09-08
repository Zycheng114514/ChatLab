/**
 * `chatlab-media://` — reads one message attachment from the directory its
 * export was imported from, so the renderer can show images and play audio
 * inline without the attachment file being copied into the data directory.
 *
 * URL shape: chatlab-media://session/<sessionId>/attachment/<attachmentId>
 *
 * node-runtime is imported by subpath so URL parsing stays testable without
 * loading the whole runtime barrel.
 */

import { net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { DatabaseManager } from '@openchatlab/node-runtime/src/database-manager'
import { isValidImportSessionId } from '@openchatlab/node-runtime/src/import/session-id'
import { resolveAttachmentFile } from '@openchatlab/node-runtime/src/services/attachment-service'

export const CHATLAB_MEDIA_SCHEME = 'chatlab-media'

export interface MediaProtocolTarget {
  sessionId: string
  attachmentId: number
}

/**
 * @returns the addressed attachment, or null for any URL that does not match
 *   the exact shape (including session ids that could escape the database directory)
 */
export function parseMediaProtocolUrl(rawUrl: string): MediaProtocolTarget | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${CHATLAB_MEDIA_SCHEME}:` || url.host !== 'session') return null

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 3 || segments[1] !== 'attachment') return null

  const sessionId = decodeURIComponent(segments[0])
  if (!isValidImportSessionId(sessionId)) return null

  const attachmentId = Number(segments[2])
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) return null

  return { sessionId, attachmentId }
}

/** The URL the renderer uses for an attachment. */
export function buildMediaProtocolUrl(sessionId: string, attachmentId: number): string {
  return `${CHATLAB_MEDIA_SCHEME}://session/${encodeURIComponent(sessionId)}/attachment/${attachmentId}`
}

/**
 * Resolve an attachment to an existing file inside the directory its session
 * was imported from. Returns null for unknown, remote or out-of-tree paths.
 */
export function resolveMediaFile(
  dbManager: DatabaseManager | null,
  target: MediaProtocolTarget
): { absolutePath: string } | null {
  if (!dbManager) return null

  const db = dbManager.open(target.sessionId)
  if (!db) return null
  const file = resolveAttachmentFile(db, target.attachmentId)
  if (!file || !existsSync(file.absolutePath)) return null
  return { absolutePath: file.absolutePath }
}

/** Register the privileged scheme. Must run before `app.whenReady()`. */
export function registerMediaProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CHATLAB_MEDIA_SCHEME, privileges: { secure: true, standard: true, supportFetchAPI: true } },
  ])
}

/**
 * Install the handler. Must run after `app.whenReady()`.
 *
 * @param getDbManager - resolved per request because the internal server opens
 *   its DatabaseManager after the app is ready and reopens it on data-dir switch
 */
export function registerMediaProtocolHandler(getDbManager: () => DatabaseManager | null): void {
  protocol.handle(CHATLAB_MEDIA_SCHEME, async (request) => {
    const target = parseMediaProtocolUrl(request.url)
    if (!target) return new Response('Not Found', { status: 404 })

    let file: { absolutePath: string } | null = null
    try {
      file = resolveMediaFile(getDbManager(), target)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!file) return new Response('Not Found', { status: 404 })

    return net.fetch(pathToFileURL(file.absolutePath).toString())
  })
}
