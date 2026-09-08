import type { DatabaseAdapter } from '../interfaces'
import { hasColumn, hasTable } from '../query/filters'
import { MESSAGE_ATTACHMENT_INDEX, MESSAGE_ATTACHMENT_TABLE } from './tables'

/**
 * Bring an existing chat database up to the attachment schema.
 *
 * Used by the Node migration (schema version 11) and by the browser runtime,
 * which has no migration runner and only replays the current DDL on open.
 */
export function ensureAttachmentSchema(db: DatabaseAdapter): void {
  if (!hasTable(db, 'message_attachment')) {
    db.exec(MESSAGE_ATTACHMENT_TABLE)
  }
  db.exec(MESSAGE_ATTACHMENT_INDEX)

  if (hasTable(db, 'meta') && !hasColumn(db, 'meta', 'source_dir')) {
    db.exec('ALTER TABLE meta ADD COLUMN source_dir TEXT')
  }
}
