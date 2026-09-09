import type {
  BrowserChatParseProgress,
  BrowserParsedMember,
  BrowserParsedMessage,
  BrowserParseSource,
} from './chatlab-parser'
import type { BrowserImportParseResult } from './browser-parser'
import type { TelegramChatInfo } from '@openchatlab/parser/browser'
import type { AttachmentKind, ParsedAttachment } from '@openchatlab/shared-types'

export type BrowserWasmFormatId = 'chatlab' | 'weflow' | 'telegram-native' | 'telegram-native-single'

/** Rust kernel id per browser format; both Telegram exports share one kernel. */
const WASM_KERNEL_IDS: Record<BrowserWasmFormatId, string> = {
  chatlab: 'chatlab',
  weflow: 'weflow',
  'telegram-native': 'telegram',
  'telegram-native-single': 'telegram',
}

function isTelegram(formatId: BrowserWasmFormatId): boolean {
  return formatId === 'telegram-native' || formatId === 'telegram-native-single'
}

interface WasmNativeRole {
  id: string
  name?: string | null
}

interface WasmNativeMember {
  platformId: string
  accountName: string
  groupNickname?: string | null
  aliases?: string[] | null
  avatar?: string | null
  roles?: WasmNativeRole[] | null
}

interface WasmNativeAttachment {
  kind: string
  path: string
  name?: string | null
  mimeType?: string | null
  size?: number | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
}

interface WasmNativeMessage {
  platformMessageId?: string | null
  senderPlatformId: string
  senderAccountName: string
  senderGroupNickname?: string | null
  timestamp?: number | null
  messageType: number
  content?: string | null
  replyToMessageId?: string | null
  attachments?: WasmNativeAttachment[] | null
}

interface BrowserWasmParser {
  free(): void
  meta_json(): string
  take_members_json(): string
  take_batch_json(size: number): string | undefined
  summary_json(): string
}

export interface BrowserWasmParserModule {
  default(moduleOrPath?: unknown): Promise<unknown>
  WasmParser: new (
    formatId: string,
    bytes: Uint8Array,
    fileName: string,
    optionsJson?: string | null
  ) => BrowserWasmParser
}

export type BrowserWasmParserLoader = () => Promise<BrowserWasmParserModule | null>

export interface BrowserImportLogEvent {
  level: 'debug' | 'info' | 'error'
  message: string
  data?: Record<string, unknown>
}

export interface ParseWithWasmOptions {
  checkCancelled?: () => void
  onProgress?: (progress: BrowserChatParseProgress) => void
  onLog?: (event: BrowserImportLogEvent) => void
  loader?: BrowserWasmParserLoader
  batchSize?: number
  /** Format options for the kernel (Telegram: `chatIndex` or `single`). */
  optionsJson?: string
}

let modulePromise: Promise<BrowserWasmParserModule> | undefined

/** Shape of meta_json() from the Rust telegram kernel in scan mode. */
interface WasmTelegramScanMeta {
  scan: true
  chats: TelegramChatInfo[]
}

/**
 * List the chats of a Telegram full export with the Rust kernel, which walks
 * the bytes instead of JSON.parse-ing the whole file. Returns null when the
 * kernel is unavailable or rejects the file, so the caller falls back to
 * scanTelegramChatsJson.
 */
export async function scanTelegramChatsWithWasm(
  source: BrowserParseSource,
  options: Pick<ParseWithWasmOptions, 'checkCancelled' | 'onLog' | 'loader'> = {}
): Promise<TelegramChatInfo[] | null> {
  const startedAt = performance.now()
  let parser: BrowserWasmParser | undefined
  try {
    options.checkCancelled?.()
    const module = await (options.loader ?? loadDefaultModule)()
    if (!module) return null
    await module.default()
    const bytes = new Uint8Array(await source.arrayBuffer())
    options.checkCancelled?.()
    parser = new module.WasmParser('telegram', bytes, source.name, JSON.stringify({ scan: true }))
    const { chats } = JSON.parse(parser.meta_json()) as WasmTelegramScanMeta
    options.onLog?.({
      level: 'info',
      message: 'Rust WASM Telegram scan completed',
      data: { size: source.size, durationMs: Math.round(performance.now() - startedAt), chatCount: chats.length },
    })
    return chats
  } catch (error) {
    options.checkCancelled?.()
    options.onLog?.({
      level: 'info',
      message: 'Rust WASM Telegram scan failed; falling back to TS',
      data: { error: error instanceof Error ? error.message : String(error) },
    })
    return null
  } finally {
    parser?.free()
  }
}

export async function parseWithWasm(
  source: BrowserParseSource,
  formatId: BrowserWasmFormatId,
  options: ParseWithWasmOptions = {}
): Promise<BrowserImportParseResult | null> {
  const startedAt = performance.now()
  let parser: BrowserWasmParser | undefined
  try {
    options.checkCancelled?.()
    const module = await (options.loader ?? loadDefaultModule)()
    if (!module) return null
    await module.default()
    const bytes = new Uint8Array(await source.arrayBuffer())
    options.checkCancelled?.()
    options.onProgress?.({ stage: 'parsing', progress: 0, messagesProcessed: 0 })
    parser = new module.WasmParser(WASM_KERNEL_IDS[formatId], bytes, source.name, options.optionsJson)

    await yieldToWorkerQueue()
    options.checkCancelled?.()

    const meta = JSON.parse(parser.meta_json()) as Record<string, unknown>
    const members = mapMembers(JSON.parse(parser.take_members_json()) as WasmNativeMember[], formatId, meta)
    const summary = JSON.parse(parser.summary_json()) as { messageCount: number }
    const messages: BrowserParsedMessage[] = []
    const batchSize = Math.max(1, options.batchSize ?? 5000)

    while (true) {
      const batchJson = parser.take_batch_json(batchSize)
      if (batchJson === undefined) break
      const batch = JSON.parse(batchJson) as WasmNativeMessage[]
      for (const message of batch) messages.push(mapMessage(message, formatId))
      options.onProgress?.({
        stage: 'parsing',
        progress: summary.messageCount === 0 ? 1 : messages.length / summary.messageCount,
        messagesProcessed: messages.length,
      })
      await yieldToWorkerQueue()
      options.checkCancelled?.()
    }

    const result = mapResult(formatId, meta, members, messages)
    options.onLog?.({
      level: 'info',
      message: 'Rust WASM parse completed',
      data: {
        formatId,
        size: source.size,
        durationMs: Math.round(performance.now() - startedAt),
        messageCount: messages.length,
        memberCount: members.length,
      },
    })
    return result
  } catch (error) {
    options.checkCancelled?.()
    options.onLog?.({
      level: 'info',
      message: 'Rust WASM parse failed; falling back to TS',
      data: {
        formatId,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  } finally {
    parser?.free()
  }
}

function loadDefaultModule(): Promise<BrowserWasmParserModule> {
  modulePromise ??= import('../wasm/generated/parser_native.js').catch((error: unknown) => {
    modulePromise = undefined
    throw error
  })
  return modulePromise
}

function mapResult(
  formatId: BrowserWasmFormatId,
  meta: Record<string, unknown>,
  members: BrowserParsedMember[],
  messages: BrowserParsedMessage[]
): BrowserImportParseResult {
  if (isTelegram(formatId)) {
    return {
      formatId,
      meta: {
        name: meta.name as string,
        platform: 'telegram',
        type: meta.chatType as string,
        groupId: optionalString(meta.groupId),
      },
      members,
      messages,
    }
  }

  if (formatId === 'weflow') {
    return {
      formatId,
      meta: {
        name: meta.name as string,
        platform: 'weixin',
        type: meta.chatType === 'private' ? 'private' : 'group',
        groupId: optionalString(meta.groupId),
        groupAvatar: optionalString(meta.groupAvatar),
        ownerId: optionalString(meta.ownerId),
      },
      members,
      messages,
    }
  }

  return {
    formatId,
    meta: compact({
      name: meta.name as string,
      platform: meta.platform as string,
      type: meta.chatType as string,
      groupId: optionalString(meta.groupId),
      groupAvatar: optionalString(meta.groupAvatar),
      ownerId: optionalString(meta.ownerId),
      sourceSessionId: optionalString(meta.sourceSessionId),
    }),
    members,
    messages,
  }
}

function mapMembers(
  members: WasmNativeMember[],
  formatId: BrowserWasmFormatId,
  meta: Record<string, unknown>
): BrowserParsedMember[] {
  if (isTelegram(formatId)) {
    // Telegram members are derived from messages and carry only these two keys.
    return members.map((member) => ({
      platformId: member.platformId,
      accountName: member.accountName,
    }))
  }

  if (formatId === 'weflow') {
    return members.map((member) => ({
      platformId: member.platformId,
      accountName: member.accountName,
      avatar: optionalString(member.avatar),
    }))
  }

  const fromHead = meta.membersFromHead === true
  return members.map((member) => {
    if (!fromHead) {
      return {
        platformId: member.platformId,
        accountName: member.accountName,
        groupNickname: optionalString(member.groupNickname),
      }
    }
    return compact({
      platformId: member.platformId,
      accountName: member.accountName,
      groupNickname: optionalString(member.groupNickname),
      aliases: member.aliases ?? undefined,
      avatar: optionalString(member.avatar),
      roles: member.roles?.map((role) => ({ id: role.id, name: optionalString(role.name) })) ?? undefined,
    })
  })
}

function mapMessage(message: WasmNativeMessage, formatId: BrowserWasmFormatId): BrowserParsedMessage {
  const platformMessageId = optionalString(message.platformMessageId)
  const senderGroupNickname = optionalString(message.senderGroupNickname)
  const replyToMessageId = optionalString(message.replyToMessageId)
  if (isTelegram(formatId)) {
    const mapped: BrowserParsedMessage = {
      platformMessageId,
      senderPlatformId: message.senderPlatformId,
      senderAccountName: message.senderAccountName,
      timestamp: message.timestamp as number,
      type: message.messageType,
      content: message.content ?? null,
      replyToMessageId,
    }
    // The TS browser parser drops media info; the kernel keeps attachments.
    if (message.attachments?.length) mapped.attachments = message.attachments.map(mapAttachment)
    return mapped
  }

  if (formatId === 'weflow') {
    return {
      platformMessageId,
      senderPlatformId: message.senderPlatformId,
      senderAccountName: message.senderAccountName,
      senderGroupNickname,
      timestamp: message.timestamp as number,
      type: message.messageType,
      content: message.content ?? null,
    }
  }

  const mapped: BrowserParsedMessage = {
    senderPlatformId: message.senderPlatformId,
    senderAccountName: message.senderAccountName,
    timestamp: message.timestamp as number,
    type: message.messageType,
    content: message.content ?? null,
  }
  if (platformMessageId !== undefined) mapped.platformMessageId = platformMessageId
  if (senderGroupNickname !== undefined) mapped.senderGroupNickname = senderGroupNickname
  if (replyToMessageId !== undefined) mapped.replyToMessageId = replyToMessageId
  if (message.attachments?.length) mapped.attachments = message.attachments.map(mapAttachment)
  return mapped
}

function mapAttachment(attachment: WasmNativeAttachment): ParsedAttachment {
  return {
    kind: attachment.kind as AttachmentKind,
    path: attachment.path,
    name: optionalString(attachment.name),
    mimeType: optionalString(attachment.mimeType),
    size: optionalNumber(attachment.size),
    durationMs: optionalNumber(attachment.durationMs),
    width: optionalNumber(attachment.width),
    height: optionalNumber(attachment.height),
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function yieldToWorkerQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
