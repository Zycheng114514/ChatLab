export {
  CURRENT_SCHEMA_VERSION,
  CHAT_DB_TABLES,
  CHAT_DB_INDEXES,
  CHAT_DB_SCHEMA,
  MESSAGE_ATTACHMENT_TABLE,
  MESSAGE_ATTACHMENT_INDEX,
} from './tables'
export { ensureAttachmentSchema } from './ensure-attachment-schema'
export { getSchemaVersion, setSchemaVersion, needsMigration, runMigrations } from './migrations'
export type { Migration } from './migrations'
