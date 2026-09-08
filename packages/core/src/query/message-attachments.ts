/**
 * Attachment queries.
 *
 * Attachments are fetched per page of messages with a single IN query, so the
 * message list stays one round trip per page instead of one per message.
 */

import type { DatabaseAdapter } from '../interfaces'
import { hasTable } from './filters'
import type { AsyncSqlExecutor } from './message-query-functions'

export interface MessageAttachment {
  id: number
  messageId: number
  kind: string
  path: string
  name: string | null
  mimeType: string | null
  size: number | null
  durationMs: number | null
  width: number | null
  height: number | null
}

interface AttachmentRow {
  id: number
  message_id: number
  kind: string
  relative_path: string
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  duration_ms: number | null
  width: number | null
  height: number | null
}

const ATTACHMENT_SELECT = `SELECT id, message_id, kind, relative_path, file_name, mime_type, size_bytes, duration_ms, width, height
   FROM message_attachment`

/**
 * Group attachments by message id. Messages without attachments are absent.
 */
export function getMessageAttachments(
  db: DatabaseAdapter,
  messageIds: readonly number[]
): Record<number, MessageAttachment[]> {
  const ids = normalizeMessageIds(messageIds)
  if (ids.length === 0) return {}
  // Databases opened read-only never run migrations, so the table can be missing.
  if (!hasTable(db, 'message_attachment')) return {}

  const rows = db
    .prepare(`${ATTACHMENT_SELECT} WHERE message_id IN (${ids.map(() => '?').join(', ')}) ORDER BY message_id, id`)
    .all(...ids) as unknown as AttachmentRow[]
  return groupAttachments(rows)
}

export async function fetchMessageAttachments(
  executor: AsyncSqlExecutor,
  messageIds: readonly number[]
): Promise<Record<number, MessageAttachment[]>> {
  const ids = normalizeMessageIds(messageIds)
  if (ids.length === 0) return {}

  const rows = await executor.all<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE message_id IN (${ids.map(() => '?').join(', ')}) ORDER BY message_id, id`,
    ids
  )
  return groupAttachments(rows)
}

function normalizeMessageIds(messageIds: readonly number[]): number[] {
  return [...new Set(messageIds.filter((id) => Number.isInteger(id)))]
}

function groupAttachments(rows: readonly AttachmentRow[]): Record<number, MessageAttachment[]> {
  const grouped: Record<number, MessageAttachment[]> = {}
  for (const row of rows) {
    const attachments = grouped[row.message_id] ?? (grouped[row.message_id] = [])
    attachments.push({
      id: row.id,
      messageId: row.message_id,
      kind: row.kind,
      path: row.relative_path,
      name: row.file_name,
      mimeType: row.mime_type,
      size: row.size_bytes,
      durationMs: row.duration_ms,
      width: row.width,
      height: row.height,
    })
  }
  return grouped
}
