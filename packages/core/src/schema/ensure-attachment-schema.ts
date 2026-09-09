import type { DatabaseAdapter } from '../interfaces'
import { hasColumn, hasTable } from '../query/filters'
import { MESSAGE_ATTACHMENT_INDEX, MESSAGE_ATTACHMENT_TABLE } from './tables'

/** Transcript columns added after the attachment table shipped; older rows keep NULL. */
const MESSAGE_ATTACHMENT_ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['transcript', 'TEXT'],
  ['transcript_model', 'TEXT'],
  ['transcribed_at', 'INTEGER'],
]

/**
 * Bring an existing chat database up to the attachment schema.
 *
 * Used by the Node migration (schema version 12) and by the browser runtime,
 * which has no migration runner and only replays the current DDL on open.
 */
export function ensureAttachmentSchema(db: DatabaseAdapter): void {
  if (!hasTable(db, 'message_attachment')) {
    db.exec(MESSAGE_ATTACHMENT_TABLE)
  }
  db.exec(MESSAGE_ATTACHMENT_INDEX)

  for (const [column, type] of MESSAGE_ATTACHMENT_ADDED_COLUMNS) {
    if (!hasColumn(db, 'message_attachment', column)) {
      db.exec(`ALTER TABLE message_attachment ADD COLUMN ${column} ${type}`)
    }
  }

  if (hasTable(db, 'meta') && !hasColumn(db, 'meta', 'source_dir')) {
    db.exec('ALTER TABLE meta ADD COLUMN source_dir TEXT')
  }
}
