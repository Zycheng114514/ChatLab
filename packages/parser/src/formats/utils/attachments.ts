/**
 * Attachment helpers shared by the ChatLab JSON and JSONL parsers.
 */

import { ATTACHMENT_KINDS, MessageType, type AttachmentKind, type ParsedAttachment } from '@openchatlab/shared-types'

export interface NormalizedAttachments {
  attachments?: ParsedAttachment[]
  /** Entries dropped because `kind` or `path` was missing or malformed. */
  skipped: number
}

/**
 * Validate the `attachments` field of a ChatLab format message.
 * Unknown extra fields are dropped; invalid entries are skipped and counted.
 */
export function normalizeAttachments(value: unknown): NormalizedAttachments {
  if (value === undefined || value === null) return { skipped: 0 }
  if (!Array.isArray(value)) return { skipped: 1 }

  const attachments: ParsedAttachment[] = []
  let skipped = 0
  for (const entry of value) {
    const attachment = normalizeAttachment(entry)
    if (attachment) attachments.push(attachment)
    else skipped++
  }
  return { attachments: attachments.length > 0 ? attachments : undefined, skipped }
}

function normalizeAttachment(entry: unknown): ParsedAttachment | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const kind = record.kind
  const filePath = record.path
  if (typeof kind !== 'string' || !ATTACHMENT_KINDS.includes(kind as AttachmentKind)) return null
  if (typeof filePath !== 'string' || filePath.length === 0) return null

  return createAttachment(kind as AttachmentKind, filePath, record)
}

/**
 * Every attachment carries the same key set, so the native kernel's output and
 * this parser's output stay deep-equal (verified by the native parity tests).
 */
function createAttachment(kind: AttachmentKind, path: string, source?: Record<string, unknown>): ParsedAttachment {
  return {
    kind,
    path,
    name: optionalString(source?.name),
    mimeType: optionalString(source?.mimeType),
    size: optionalNumber(source?.size),
    durationMs: optionalNumber(source?.durationMs),
    width: optionalNumber(source?.width),
    height: optionalNumber(source?.height),
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const KIND_BY_MESSAGE_TYPE: Partial<Record<MessageType, AttachmentKind>> = {
  [MessageType.IMAGE]: 'image',
  [MessageType.VOICE]: 'audio',
  [MessageType.VIDEO]: 'video',
  [MessageType.FILE]: 'file',
}

// A single path: no whitespace, and a short trailing extension.
const FILE_PATH_LIKE = /^[^\s]+\.[A-Za-z0-9]{1,8}$/

/**
 * Recover the file of a media message whose converter put the path in `content`
 * and wrote no `attachments` (issue #170: WeFlow-converted WeChat exports).
 *
 * URLs are deliberately not inferred: a chat export must not make the app fetch
 * a remote address that the sender chose.
 */
export function inferAttachmentFromContent(type: number, content: string | null): ParsedAttachment | undefined {
  const kind = KIND_BY_MESSAGE_TYPE[type as MessageType]
  if (!kind || !content) return undefined
  if (content.includes('://')) return undefined
  if (!FILE_PATH_LIKE.test(content)) return undefined
  return createAttachment(kind, content)
}
