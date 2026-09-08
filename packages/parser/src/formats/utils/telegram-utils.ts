/**
 * Telegram 格式解析共享工具
 * 供 telegram-native（全量导出）和 telegram-native-single（单聊天导出）共用
 */

import { ChatType, MessageType, type AttachmentKind, type ParsedAttachment } from '@openchatlab/shared-types'

// ==================== 共享类型 ====================

/** Telegram 消息结构 */
export interface TelegramMessage {
  id: number
  type: 'message' | 'service'
  date: string
  date_unixtime: string
  from?: string | null
  from_id?: string
  actor?: string | null
  actor_id?: string
  action?: string
  text: string | Array<string | { type: string; text: string }>
  text_entities?: Array<{ type: string; text: string }>
  reply_to_message_id?: number
  forwarded_from?: string | null
  forwarded_from_id?: string
  photo?: string
  file?: string
  file_name?: string
  media_type?: string
  sticker_emoji?: string
  mime_type?: string
  duration_seconds?: number
  width?: number
  height?: number
  members?: string[]
}

/** Telegram 聊天结构 */
export interface TelegramChat {
  name: string
  type: string
  id: number
  messages: TelegramMessage[]
}

// ==================== 共享辅助函数 ====================

/**
 * 将 Telegram 聊天类型映射到 ChatLab 聊天类型
 */
export function mapChatType(telegramType: string): ChatType {
  switch (telegramType) {
    case 'personal_chat':
    case 'bot_chat':
    case 'saved_messages':
      return ChatType.PRIVATE
    case 'private_group':
    case 'public_group':
    case 'private_supergroup':
    case 'public_supergroup':
    case 'private_channel':
    case 'public_channel':
      return ChatType.GROUP
    default:
      return ChatType.GROUP
  }
}

/**
 * 提取 Telegram text 字段为纯文本
 * text 可以是字符串或 mixed 数组
 */
export function extractText(text: string | Array<string | { type: string; text: string }>): string {
  if (typeof text === 'string') return text
  if (!Array.isArray(text)) return ''

  return text
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) return part.text
      return ''
    })
    .join('')
}

/**
 * 从 from_id 提取平台 ID
 * 格式：user123456 → 123456
 */
export function extractPlatformId(fromId: string | undefined): string {
  if (!fromId) return 'unknown'
  // 移除 "user" / "channel" 等前缀，保留数字部分
  return fromId.replace(/^(user|channel)/, '')
}

/**
 * 检测消息类型
 */
export function detectMessageType(msg: TelegramMessage): MessageType {
  // Service 消息 → 系统消息
  if (msg.type === 'service') return MessageType.SYSTEM

  // 贴纸
  if (msg.media_type === 'sticker') return MessageType.IMAGE
  // 图片
  if (msg.photo) return MessageType.IMAGE
  // 动画 (GIF)
  if (msg.media_type === 'animation') return MessageType.IMAGE
  // 视频
  if (msg.media_type === 'video_file') return MessageType.VIDEO
  // 语音
  if (msg.media_type === 'voice_message') return MessageType.VOICE
  // 视频留言
  if (msg.media_type === 'video_message') return MessageType.VIDEO
  // 文件
  if (msg.file && !msg.media_type) return MessageType.FILE

  // 默认文本
  return MessageType.TEXT
}

/**
 * 构建消息内容
 */
export function buildContent(msg: TelegramMessage): string | null {
  const text = extractText(msg.text)

  // Service 消息
  if (msg.type === 'service') {
    const action = msg.action || ''
    const members = msg.members?.join(', ') || ''
    if (members) return `[${action}] ${members}`
    // action 为空时回退到文本，避免常量表达式触发 lint 规则。
    if (action) return `[${action}]`
    return text || null
  }

  // 贴纸：使用 emoji 表示
  if (msg.media_type === 'sticker' && msg.sticker_emoji) {
    return text ? `[sticker ${msg.sticker_emoji}] ${text}` : `[sticker ${msg.sticker_emoji}]`
  }

  // 媒体消息带文字说明
  if (msg.photo || msg.file || msg.media_type) {
    const mediaLabel = msg.media_type || (msg.photo ? 'photo' : 'file')
    if (text) return `[${mediaLabel}] ${text}`
    return `[${mediaLabel}]`
  }

  return text || null
}

/** Telegram media_type → attachment kind; `photo` messages have no media_type. */
const ATTACHMENT_KIND_BY_MEDIA_TYPE: Record<string, AttachmentKind> = {
  video_file: 'video',
  video_message: 'video',
  voice_message: 'audio',
  audio_file: 'audio',
  sticker: 'sticker',
  animation: 'image',
}

/**
 * Build the attachment of a Telegram media message.
 * `photo` and `file` hold a path relative to the export directory.
 */
export function buildAttachments(msg: TelegramMessage): ParsedAttachment[] | undefined {
  // `file` is the media itself; `photo` is only used by photo messages.
  const filePath = msg.file || msg.photo
  if (!filePath) return undefined

  const kind = msg.file ? (ATTACHMENT_KIND_BY_MEDIA_TYPE[msg.media_type ?? ''] ?? 'file') : 'image'
  return [
    {
      kind,
      path: filePath,
      name: msg.file_name || undefined,
      mimeType: msg.mime_type || undefined,
      size: undefined,
      durationMs: msg.duration_seconds !== undefined ? msg.duration_seconds * 1000 : undefined,
      width: msg.width,
      height: msg.height,
    },
  ]
}
