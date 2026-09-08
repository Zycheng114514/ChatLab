/**
 * Attachment file resolution shared by the CLI Web route and the desktop
 * `chatlab-media://` protocol.
 *
 * Both entry points must reject the same paths, so the lookup, the traversal
 * check and the content type live here rather than in either entry layer.
 */

import {
  getMessageAttachmentById,
  getSessionMeta,
  isRemoteAttachmentPath,
  resolveAttachmentPath,
  type DatabaseAdapter,
} from '@openchatlab/core'

export interface SessionAttachmentFile {
  absolutePath: string
  fileName: string
  contentType: string
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
}

/**
 * Resolve an attachment row to a local file inside the session's import directory.
 *
 * @returns null when the attachment is unknown, points at a remote URL, or
 *   resolves outside the directory the export was imported from
 */
export function resolveAttachmentFile(db: DatabaseAdapter, attachmentId: number): SessionAttachmentFile | null {
  const attachment = getMessageAttachmentById(db, attachmentId)
  if (!attachment) return null
  // Remote attachments are loaded by the renderer directly; the app never proxies them.
  if (isRemoteAttachmentPath(attachment.path)) return null

  const absolutePath = resolveAttachmentPath(getSessionMeta(db)?.sourceDir ?? null, attachment.path)
  if (!absolutePath) return null

  const fileName = attachment.name || absolutePath.split(/[\\/]/).pop() || 'attachment'
  return {
    absolutePath,
    fileName,
    contentType: attachment.mimeType || contentTypeFromPath(absolutePath),
  }
}

function contentTypeFromPath(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}
