/**
 * Discord (Tyrrrz/DiscordChatExporter) adapter for the unified native-first
 * wrapper. Payload shapes are identical to the pure-TS parser in
 * formats/tyrrrz-discord-exporter.ts (verified by parity tests) — including
 * its attachments, which carry only kind/path/name/size.
 */

import {
  KNOWN_PLATFORMS,
  ChatType,
  type AttachmentKind,
  type MessageType,
  type ParsedAttachment,
} from '@openchatlab/shared-types'
import type { NativeAttachment, NativeMember, NativeMessage } from '@openchatlab/parser-native'
import type { ParsedMember, ParsedMessage, ParsedMeta } from '../types'
import { createNativeFirstParser, type NativeFormatAdapter, type ParseGenerator } from './create-native-parser'

/** Shape of metaJson() from the Rust discord kernel; null means undefined. */
interface DiscordMetaJson {
  name: string
  groupId: string | null
  groupAvatar: string | null
}

/** Same four keys as buildAttachments() in the TS parser. */
function toDiscordAttachment(attachment: NativeAttachment): ParsedAttachment {
  return {
    kind: attachment.kind as AttachmentKind,
    path: attachment.path,
    name: attachment.name,
    size: attachment.size,
  }
}

const discordAdapter: NativeFormatAdapter = {
  kernelId: 'discord',
  label: 'Discord export',

  mapMeta(metaJson: unknown): ParsedMeta {
    const meta = metaJson as DiscordMetaJson
    return {
      name: meta.name,
      platform: KNOWN_PLATFORMS.DISCORD,
      // Discord channels are always group chats.
      type: ChatType.GROUP,
      groupId: meta.groupId ?? undefined,
      groupAvatar: meta.groupAvatar ?? undefined,
    }
  },

  mapMembers(members: NativeMember[]): ParsedMember[] {
    return members.map((member) => ({
      platformId: member.platformId,
      accountName: member.accountName,
      groupNickname: member.groupNickname,
      avatar: member.avatar,
      // The kernel always emits a roles array, matching convertRoles().
      roles: (member.roles ?? []).map((role) => ({ id: role.id, name: role.name })),
    }))
  },

  mapMessage(message: NativeMessage): ParsedMessage {
    return {
      platformMessageId: message.platformMessageId,
      senderPlatformId: message.senderPlatformId,
      senderAccountName: message.senderAccountName,
      senderGroupNickname: message.senderGroupNickname,
      // The kernel refuses timestamps JS would turn into NaN.
      timestamp: message.timestamp as number,
      type: message.messageType as MessageType,
      content: message.content ?? null,
      replyToMessageId: message.replyToMessageId,
      attachments: message.attachments?.map(toDiscordAttachment),
    }
  },
}

/** Wrap the TS DiscordChatExporter parse generator with native acceleration. */
export function withNativeDiscord(fallback: ParseGenerator): ParseGenerator {
  return createNativeFirstParser(discordAdapter, fallback)
}
