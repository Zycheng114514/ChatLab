import {
  insertMessageAttachments,
  type DatabaseAdapter,
  type MessageAttachmentInsert,
  type PreparedStatement,
} from '@openchatlab/core'
import type { ParsedAttachment } from '@openchatlab/shared-types'

const MESSAGE_COLUMN_COUNT = 8
const SQLITE_LEGACY_VARIABLE_LIMIT = 999

/**
 * Keep each statement below SQLite's historical 999-variable limit.
 * Modern bundled SQLite builds allow more, but this conservative bound keeps
 * the shared DatabaseAdapter path compatible with older/runtime-specific builds.
 */
export const MESSAGE_INSERT_MAX_ROWS = Math.floor(SQLITE_LEGACY_VARIABLE_LIMIT / MESSAGE_COLUMN_COUNT)

export interface MessageInsertRow {
  senderId: number
  senderAccountName: string | null
  senderGroupNickname: string | null
  timestamp: number
  type: number
  content: string | null
  replyToMessageId: string | null
  platformMessageId: string | null
  attachments?: ParsedAttachment[]
}

export class MessageBatchInserter {
  private readonly statementCache = new Map<string, PreparedStatement>()

  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * @returns the number of message INSERT statements executed
   */
  insert(rows: readonly MessageInsertRow[]): number {
    let statementCount = 0
    for (let offset = 0; offset < rows.length; offset += MESSAGE_INSERT_MAX_ROWS) {
      const batch = rows.slice(offset, offset + MESSAGE_INSERT_MAX_ROWS)
      // RETURNING materializes one row per message, so only ask for ids when
      // this batch actually needs them to attach files.
      const hasAttachments = batch.some((row) => row.attachments?.length)
      const statement = this.getStatement(batch.length, hasAttachments)
      const params = batch.flatMap(toParams)
      statementCount++

      if (!hasAttachments) {
        statement.run(...params)
        continue
      }
      this.insertAttachments(batch, statement.all(...params) as unknown as Array<{ id: number }>)
    }
    return statementCount
  }

  private insertAttachments(batch: readonly MessageInsertRow[], insertedIds: ReadonlyArray<{ id: number }>): void {
    // RETURNING does not promise a row order, but AUTOINCREMENT hands out ids in
    // the order the VALUES rows are inserted, so ascending id is that order.
    const ids = insertedIds.map((row) => row.id).sort((first, second) => first - second)
    const attachmentRows: MessageAttachmentInsert[] = []
    for (let index = 0; index < batch.length; index++) {
      const attachments = batch[index].attachments
      const messageId = ids[index]
      if (!attachments?.length || messageId === undefined) continue
      for (const attachment of attachments) {
        attachmentRows.push({ messageId, attachment })
      }
    }
    insertMessageAttachments(this.db, attachmentRows)
  }

  private getStatement(rowCount: number, returningIds: boolean): PreparedStatement {
    const cacheKey = `${rowCount}:${returningIds}`
    const cached = this.statementCache.get(cacheKey)
    if (cached) return cached

    const values = Array.from({ length: rowCount }, () => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const statement = this.db.prepare(
      `INSERT INTO message (
         sender_id,
         sender_account_name,
         sender_group_nickname,
         ts,
         type,
         content,
         reply_to_message_id,
         platform_message_id
       ) VALUES ${values}${returningIds ? '\n       RETURNING id' : ''}`
    )
    this.statementCache.set(cacheKey, statement)
    return statement
  }
}

function toParams(row: MessageInsertRow): unknown[] {
  return [
    row.senderId,
    row.senderAccountName,
    row.senderGroupNickname,
    row.timestamp,
    row.type,
    row.content,
    row.replyToMessageId,
    row.platformMessageId,
  ]
}
