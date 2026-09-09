/**
 * Voice transcript persistence for audio attachments.
 *
 * Kept next to the other attachment SQL (and not in the Node transcription
 * service) because the write rules are platform-agnostic: whichever runtime
 * produced the text, the transcript lands on the attachment row and the
 * message text is only rewritten when it carries no words of its own.
 */

import type { DatabaseAdapter } from '../interfaces'
import { isMediaPlaceholderContent } from '../nlp/text-utils'
import { hasTable } from './filters'

/** An audio attachment that still needs a transcript. */
export interface PendingAudioAttachment {
  id: number
  messageId: number
  /** Stored path, relative to the session's import directory or an absolute/remote path. */
  path: string
  fileName: string | null
  mimeType: string | null
  durationMs: number | null
}

export interface ApplyTranscriptInput {
  attachmentId: number
  text: string
  /** Model that produced the text, stored for later re-runs with a better model. */
  model: string
  /** Transcription time in epoch milliseconds. */
  now: number
}

export interface ApplyTranscriptResult {
  /** Whether `message.content` was replaced by the labelled transcript. */
  contentUpdated: boolean
}

interface PendingRow {
  id: number
  message_id: number
  relative_path: string
  file_name: string | null
  mime_type: string | null
  duration_ms: number | null
}

interface TranscriptTargetRow {
  message_id: number
  duration_ms: number | null
  content: string | null
}

/**
 * Audio attachments without a transcript, oldest first.
 *
 * @param attachmentIds Restrict to these attachment ids; omit for the whole session.
 */
export function listPendingAudioAttachments(
  db: DatabaseAdapter,
  attachmentIds?: readonly number[]
): PendingAudioAttachment[] {
  if (!hasTable(db, 'message_attachment')) return []

  const ids = attachmentIds ? [...new Set(attachmentIds.filter((id) => Number.isInteger(id)))] : null
  if (ids && ids.length === 0) return []

  const idFilter = ids ? ` AND id IN (${ids.map(() => '?').join(', ')})` : ''
  const rows = db
    .prepare(
      `SELECT id, message_id, relative_path, file_name, mime_type, duration_ms
         FROM message_attachment
        WHERE kind = 'audio' AND transcript IS NULL${idFilter}
        ORDER BY id`
    )
    .all(...(ids ?? [])) as unknown as PendingRow[]

  return rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    path: row.relative_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    durationMs: row.duration_ms,
  }))
}

/**
 * Store a transcript and, when the message has no text of its own, surface it
 * as `[语音 3秒] …` so search and text analysis see the words.
 *
 * The message text is left untouched when the user (or the export) already put
 * real text there — the transcript is still recorded on the attachment row.
 */
export function applyTranscript(db: DatabaseAdapter, input: ApplyTranscriptInput): ApplyTranscriptResult {
  return db.transaction(() => {
    const target = db
      .prepare(
        `SELECT a.message_id, a.duration_ms, m.content
           FROM message_attachment a
           JOIN message m ON m.id = a.message_id
          WHERE a.id = ?`
      )
      .get(input.attachmentId) as unknown as TranscriptTargetRow | undefined
    if (!target) throw new Error(`attachment ${input.attachmentId} not found`)

    db.prepare(
      'UPDATE message_attachment SET transcript = ?, transcript_model = ?, transcribed_at = ? WHERE id = ?'
    ).run(input.text, input.model, input.now, input.attachmentId)

    const text = input.text.trim()
    if (text.length === 0 || !isReplaceableContent(target.content)) return { contentUpdated: false }

    db.prepare('UPDATE message SET content = ? WHERE id = ?').run(
      formatVoiceTranscription(text, target.duration_ms),
      target.message_id
    )
    return { contentUpdated: true }
  })
}

/**
 * Build the `[语音 3秒] text` form that `stripVoiceTranscriptionPrefix` understands.
 * The duration label is dropped when the importer recorded no duration.
 */
export function formatVoiceTranscription(text: string, durationMs: number | null): string {
  if (durationMs === null || durationMs <= 0) return `[语音] ${text}`
  return `[语音 ${Math.round(durationMs / 1000)}秒] ${text}`
}

/** Empty text or a bare media placeholder such as `[语音]` / `[语音 3秒]`. */
function isReplaceableContent(content: string | null): boolean {
  const trimmed = content?.trim() ?? ''
  return trimmed.length === 0 || isMediaPlaceholderContent(trimmed)
}
