import { createHash } from 'node:crypto'
import { getMembers, getSessionMeta, getSessionOverview, type DatabaseAdapter } from '@openchatlab/core'
import type { IntimacyAnalysisRequest, IntimacyMember } from '@openchatlab/shared-types'

export const INTIMACY_WINDOW_MAX_MESSAGES = 120
export const INTIMACY_WINDOW_MAX_CHARS = 6_000
export const INTIMACY_WINDOW_CONTEXT_MESSAGES = 12

/** How far back a window looks for a natural cut once it reaches the budget. */
const INTIMACY_WINDOW_SPLIT_LOOKBACK = 20
/** A pause this long ends a conversational turn, so it is a preferred cut point. */
const INTIMACY_WINDOW_SPLIT_GAP_SECONDS = 30 * 60
const INTIMACY_SOURCE_FIXED_CHARS = 40
const INTIMACY_SOURCE_TRUNCATION_MARKER = '…[truncated]'

export interface IntimacySourceMessage {
  id: number
  senderId: number
  timestamp: number
  type: number
  content: string
  isText: boolean
}

export interface IntimacyWindow {
  index: number
  messages: IntimacySourceMessage[]
  /** Leading messages carried over from the previous window; they can never anchor an event. */
  contextCount: number
}

export interface IntimacySource {
  members: [IntimacyMember, IntimacyMember]
  targetStartTs: number
  targetEndTs: number
  messages: IntimacySourceMessage[]
  windows: IntimacyWindow[]
  sourceSignature: string
  sourceMessageCount: number
  sourceMaxMessageId: number
}

export interface IntimacySourceEstimate {
  messageCount: number
  textMessageCount: number
  estimatedChars: number
  estimatedWindows: number
}

export interface IntimacyTimeRange {
  startTs: number
  endTs: number
}

interface SourceRow {
  id: number
  senderId: number
  timestamp: number
  type: number
  content: string | null
}

interface SourceStatsRow {
  messageCount: number
  textMessageCount: number
  estimatedChars: number | null
}

const SOURCE_FILTER = `FROM message msg
   JOIN member m ON m.id = msg.sender_id
   WHERE msg.ts >= ? AND msg.ts <= ? AND COALESCE(m.account_name, '') != '系统消息'`

/** Intimacy analysis only describes a two-person conversation, so anything else is rejected up front. */
export function resolveIntimacyMembers(db: DatabaseAdapter): [IntimacyMember, IntimacyMember] {
  const meta = getSessionMeta(db)
  if (!meta) throw Object.assign(new Error('Session metadata is missing'), { statusCode: 404 })
  if (meta.type !== 'private') {
    throw Object.assign(new Error('Intimacy insights require a private chat with two members'), { statusCode: 400 })
  }
  const members = getMembers(db)
  if (members.length !== 2) {
    throw Object.assign(new Error('Intimacy insights require a private chat with two members'), { statusCode: 400 })
  }
  const ownerId = meta.ownerId?.trim() || null
  const resolved = members
    .map((member) => ({ memberId: member.id, name: member.name, isOwner: member.platformId === ownerId }))
    .sort((left, right) => left.memberId - right.memberId)
  return [resolved[0]!, resolved[1]!]
}

export function resolveIntimacyRange(db: DatabaseAdapter, request: IntimacyAnalysisRequest): IntimacyTimeRange {
  const overview = getSessionOverview(db)
  return {
    startTs: request.startTs ?? overview.firstMessageTs ?? 0,
    endTs: request.endTs ?? overview.lastMessageTs ?? 0,
  }
}

export function loadIntimacySource(db: DatabaseAdapter, request: IntimacyAnalysisRequest): IntimacySource {
  const members = resolveIntimacyMembers(db)
  const range = resolveIntimacyRange(db, request)
  const rows = db
    .prepare(
      `SELECT msg.id, msg.sender_id AS senderId, msg.ts AS timestamp, msg.type, msg.content ${SOURCE_FILTER}
       ORDER BY msg.ts ASC, msg.id ASC`
    )
    .all(range.startTs, range.endTs) as unknown as SourceRow[]
  const messages = rows.map(normalizeSourceRow)
  return {
    members,
    targetStartTs: range.startTs,
    targetEndTs: range.endTs,
    messages,
    windows: chunkIntimacyMessages(messages),
    sourceSignature: createIntimacySourceSignature(messages),
    sourceMessageCount: messages.length,
    sourceMaxMessageId: messages.reduce((max, message) => Math.max(max, message.id), 0),
  }
}

/** Cheap staleness probe: the same two numbers the run recorded when it started. */
export function readIntimacySourceFingerprint(
  db: DatabaseAdapter,
  range: IntimacyTimeRange
): { messageCount: number; maxMessageId: number } {
  const row = db
    .prepare(`SELECT COUNT(*) AS messageCount, COALESCE(MAX(msg.id), 0) AS maxMessageId ${SOURCE_FILTER}`)
    .get(range.startTs, range.endTs) as { messageCount: number; maxMessageId: number } | undefined
  return { messageCount: Number(row?.messageCount ?? 0), maxMessageId: Number(row?.maxMessageId ?? 0) }
}

export function estimateIntimacyWindows(db: DatabaseAdapter, range: IntimacyTimeRange): IntimacySourceEstimate {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS messageCount,
        SUM(CASE WHEN msg.type = 0 AND COALESCE(msg.content, '') != '' THEN 1 ELSE 0 END) AS textMessageCount,
        SUM(LENGTH(COALESCE(msg.content, '')) + ${INTIMACY_SOURCE_FIXED_CHARS}) AS estimatedChars
       ${SOURCE_FILTER}`
    )
    .get(range.startTs, range.endTs) as SourceStatsRow | undefined
  const messageCount = Number(row?.messageCount ?? 0)
  const estimatedChars = Number(row?.estimatedChars ?? 0)
  return {
    messageCount,
    textMessageCount: Number(row?.textMessageCount ?? 0),
    estimatedChars,
    estimatedWindows:
      messageCount === 0
        ? 0
        : Math.max(
            Math.ceil(messageCount / INTIMACY_WINDOW_MAX_MESSAGES),
            Math.ceil(estimatedChars / INTIMACY_WINDOW_MAX_CHARS)
          ),
  }
}

export function createIntimacySourceSignature(messages: IntimacySourceMessage[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    hash.update(
      `${message.id}\u0000${message.timestamp}\u0000${message.type}\u0000${message.senderId}\u0000${message.content}\u0000`
    )
  }
  return hash.digest('hex')
}

/**
 * Split the range into windows the model can read in one call. A window is cut at the last speaker change or
 * long pause near the budget so a reply is not separated from what it answers, and every window after the first
 * repeats the tail of the previous one as read-only context.
 */
export function chunkIntimacyMessages(messages: IntimacySourceMessage[]): IntimacyWindow[] {
  const windows: IntimacyWindow[] = []
  let current: IntimacySourceMessage[] = []
  let currentChars = 0
  let previousOwn: IntimacySourceMessage[] = []

  const flush = (own: IntimacySourceMessage[]) => {
    if (own.length === 0) return
    const context = previousOwn.slice(-INTIMACY_WINDOW_CONTEXT_MESSAGES)
    windows.push({ index: windows.length, messages: [...context, ...own], contextCount: context.length })
    previousOwn = own
  }

  for (const originalMessage of messages) {
    const message = boundMessageForIntimacyAnalysis(originalMessage)
    current.push(message)
    currentChars += estimateMessageChars(message)
    if (current.length < INTIMACY_WINDOW_MAX_MESSAGES && currentChars < INTIMACY_WINDOW_MAX_CHARS) continue
    const splitIndex = findIntimacySplitIndex(current)
    flush(current.slice(0, splitIndex))
    current = current.slice(splitIndex)
    currentChars = current.reduce((sum, item) => sum + estimateMessageChars(item), 0)
  }
  flush(current)
  return windows
}

function findIntimacySplitIndex(messages: IntimacySourceMessage[]): number {
  const earliest = Math.max(1, messages.length - INTIMACY_WINDOW_SPLIT_LOOKBACK)
  for (let index = messages.length - 1; index >= earliest; index -= 1) {
    const message = messages[index]!
    const previous = messages[index - 1]!
    if (
      message.senderId !== previous.senderId ||
      message.timestamp - previous.timestamp >= INTIMACY_WINDOW_SPLIT_GAP_SECONDS
    ) {
      return index
    }
  }
  return messages.length
}

function normalizeSourceRow(row: SourceRow): IntimacySourceMessage {
  const type = Number(row.type)
  const content = row.content == null ? '' : String(row.content)
  const isText = type === 0 && content !== ''
  return {
    id: Number(row.id),
    senderId: Number(row.senderId),
    timestamp: Number(row.timestamp),
    type,
    content: isText ? content : '',
    isText,
  }
}

function estimateMessageChars(message: IntimacySourceMessage): number {
  return message.content.length + INTIMACY_SOURCE_FIXED_CHARS
}

function boundMessageForIntimacyAnalysis(message: IntimacySourceMessage): IntimacySourceMessage {
  const budget = INTIMACY_WINDOW_MAX_CHARS - INTIMACY_SOURCE_FIXED_CHARS
  if (message.content.length <= budget) return message
  return {
    ...message,
    content: `${message.content.slice(0, budget - INTIMACY_SOURCE_TRUNCATION_MARKER.length)}${INTIMACY_SOURCE_TRUNCATION_MARKER}`,
  }
}
