/**
 * Telegram adapter for the unified native-first wrapper.
 *
 * One Rust kernel serves both export shapes: the full export picks a chat with
 * `formatOptions.chatIndex`, the single-chat export is selected with
 * `single: true`. Payload shapes are identical to the pure-TS parsers in
 * formats/telegram-native.ts and formats/telegram-native-single.ts (verified
 * by parity tests).
 */

import { KNOWN_PLATFORMS, ChatType, type MessageType } from '@openchatlab/shared-types'
import type { NativeMember, NativeMessage } from '@openchatlab/parser-native'
import type { ParsedMember, ParsedMessage, ParsedMeta } from '../types'
import {
  createNativeFirstParser,
  toParsedAttachment,
  type NativeFormatAdapter,
  type ParseGenerator,
} from './create-native-parser'

/** Shape of metaJson() from the Rust telegram kernel. */
interface TelegramMetaJson {
  name: string
  chatType: string
  groupId: string | null
  /** Index inside chats.list; null for a single-chat export. */
  chatIndex: number | null
}

const telegramAdapter: NativeFormatAdapter = {
  kernelId: 'telegram',
  label: 'Telegram export',

  mapMeta(metaJson: unknown): ParsedMeta {
    const meta = metaJson as TelegramMetaJson
    return {
      name: meta.name,
      platform: KNOWN_PLATFORMS.TELEGRAM,
      type: meta.chatType === 'private' ? ChatType.PRIVATE : ChatType.GROUP,
      groupId: meta.groupId ?? undefined,
    }
  },

  mapMembers(members: NativeMember[]): ParsedMember[] {
    // Telegram members are derived from messages and carry only these two keys.
    return members.map((member) => ({
      platformId: member.platformId,
      accountName: member.accountName,
    }))
  },

  mapMessage(message: NativeMessage): ParsedMessage {
    return {
      // The kernel always emits String(msg.id) and a parsed timestamp
      // (messages with an unparsable date_unixtime are dropped, as in TS).
      platformMessageId: message.platformMessageId,
      senderPlatformId: message.senderPlatformId,
      senderAccountName: message.senderAccountName,
      timestamp: message.timestamp as number,
      type: message.messageType as MessageType,
      content: message.content ?? null,
      replyToMessageId: message.replyToMessageId,
      attachments: message.attachments?.map(toParsedAttachment),
    }
  },
}

const telegramSingleAdapter: NativeFormatAdapter = {
  ...telegramAdapter,
  label: 'Telegram single-chat export',
}

/** Wrap the TS full-export parse generator with native acceleration. */
export function withNativeTelegram(fallback: ParseGenerator): ParseGenerator {
  return createNativeFirstParser(telegramAdapter, fallback)
}

/** Wrap the TS single-chat parse generator; the kernel needs `single: true`. */
export function withNativeTelegramSingle(fallback: ParseGenerator): ParseGenerator {
  const parse = createNativeFirstParser(telegramSingleAdapter, fallback)
  return (options) => parse({ ...options, formatOptions: { ...options.formatOptions, single: true } })
}
