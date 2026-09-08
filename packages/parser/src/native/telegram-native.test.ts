/**
 * Parity tests: the Rust Telegram kernel must produce identical ParseResult
 * output to the pure-TS stream-json parsers, for both the full export
 * (chats.list[chatIndex]) and the single-chat export.
 *
 * Skipped automatically when the native module has not been built locally
 * (pnpm build:native).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'

import { detectFormat, parseFile } from '../index'
import { scanChats } from '../formats/telegram-native'
import type { ParsedMember, ParsedMessage, ParsedMeta } from '../types'
import { loadNativeParser } from './loader'

const ENV_KEY = 'CHATLAB_DISABLE_NATIVE_PERF'

interface CollectedResult {
  meta: ParsedMeta | null
  members: ParsedMember[]
  messages: ParsedMessage[]
}

function nativeAvailable(): boolean {
  const saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  try {
    return loadNativeParser() !== null
  } finally {
    if (saved !== undefined) process.env[ENV_KEY] = saved
  }
}

/** parseFileSync equivalent that can pass formatOptions (chatIndex). */
async function collect(filePath: string, formatOptions?: Record<string, unknown>): Promise<CollectedResult> {
  const result: CollectedResult = { meta: null, members: [], messages: [] }
  for await (const event of parseFile({ filePath, formatOptions })) {
    if (event.type === 'meta') result.meta = event.data
    else if (event.type === 'members') result.members.push(...event.data)
    else if (event.type === 'messages') result.messages.push(...event.data)
    else if (event.type === 'error') throw event.data
  }
  return result
}

async function withFixture<T>(filename: string, content: string, run: (filePath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'chatlab-telegram-parity-'))
  try {
    const filePath = join(dir, filename)
    writeFileSync(filePath, content, 'utf-8')
    return await run(filePath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function parseBothWays(
  filename: string,
  content: string,
  expectedFormatId: string,
  formatOptions?: Record<string, unknown>
) {
  return withFixture(filename, content, async (filePath) => {
    assert.equal(detectFormat(filePath)?.id, expectedFormatId)
    try {
      delete process.env[ENV_KEY]
      const nativeResult = await collect(filePath, formatOptions)
      process.env[ENV_KEY] = '1'
      const tsResult = await collect(filePath, formatOptions)
      return { nativeResult, tsResult }
    } finally {
      delete process.env[ENV_KEY]
    }
  })
}

function assertParity(nativeResult: CollectedResult, tsResult: CollectedResult) {
  assert.deepEqual(nativeResult.meta, tsResult.meta)
  assert.deepEqual(nativeResult.members, tsResult.members)
  assert.equal(nativeResult.messages.length, tsResult.messages.length)
  for (let i = 0; i < tsResult.messages.length; i++) {
    assert.deepEqual(nativeResult.messages[i], tsResult.messages[i], `message #${i} differs`)
  }
}

/**
 * Every message shape the shared telegram-utils branches on: plain text,
 * rich-text array, service messages with and without members/actor, sticker,
 * photo, document, voice, reply, forward, missing `from`, and a message whose
 * date_unixtime cannot be parsed (dropped, but its sender is still a member).
 */
function chatMessages() {
  return [
    {
      id: 1,
      type: 'message',
      date: '2024-01-02T03:04:05',
      date_unixtime: '1704164645',
      from: 'Alice 爱丽丝',
      from_id: 'user10001',
      text: 'hello telegram 你好',
    },
    {
      id: 2,
      type: 'message',
      date: '2024-01-02T03:05:00',
      date_unixtime: '1704164700',
      from: 'Bob',
      from_id: 'user10002',
      text: ['前缀 ', { type: 'bold', text: '重点' }, { type: 'link', text: 'https://example.com' }, ' 尾巴'],
      text_entities: [{ type: 'bold', text: '重点' }],
      reply_to_message_id: 1,
    },
    {
      id: 3,
      type: 'service',
      date: '2024-01-02T03:06:00',
      date_unixtime: '1704164760',
      actor: 'Alice 爱丽丝',
      actor_id: 'user10001',
      action: 'invite_members',
      members: ['Bob', 'Carol'],
      text: '',
    },
    {
      id: 4,
      type: 'service',
      date: '2024-01-02T03:06:30',
      date_unixtime: '1704164790',
      actor: null,
      actor_id: 'user10003',
      action: 'pin_message',
      text: '',
    },
    {
      id: 5,
      type: 'message',
      date: '2024-01-02T03:07:00',
      date_unixtime: '1704164820',
      from: 'Bob',
      from_id: 'user10002',
      media_type: 'sticker',
      sticker_emoji: '🎉',
      file: 'stickers/sticker_1.webp',
      text: '庆祝一下',
    },
    {
      id: 6,
      type: 'message',
      date: '2024-01-02T03:08:00',
      date_unixtime: '1704164880',
      from: 'Alice 爱丽丝',
      from_id: 'user10001',
      photo: 'photos/photo_1@02-01-2024_03-08-00.jpg',
      width: 1280,
      height: 960,
      text: '看这张图',
    },
    {
      id: 7,
      type: 'message',
      date: '2024-01-02T03:09:00',
      date_unixtime: '1704164940',
      from: 'Alice 爱丽丝',
      from_id: 'user10001',
      file: 'files/report.pdf',
      file_name: '季度报告.pdf',
      mime_type: 'application/pdf',
      text: '',
    },
    {
      id: 8,
      type: 'message',
      date: '2024-01-02T03:10:00',
      date_unixtime: '1704165000',
      from: 'Bob',
      from_id: 'user10002',
      file: 'voice_messages/audio_1.ogg',
      media_type: 'voice_message',
      mime_type: 'audio/ogg',
      duration_seconds: 7,
      text: '',
    },
    {
      id: 9,
      type: 'message',
      date: '2024-01-02T03:11:00',
      date_unixtime: '1704165060',
      from: 'Carol',
      from_id: 'user10004',
      forwarded_from: '某个频道 Channel',
      text: 'forwarded content',
    },
    {
      id: 10,
      type: 'message',
      date: '2024-01-02T03:12:00',
      date_unixtime: '1704165120',
      from_id: 'channel99',
      text: 'no from field',
    },
    {
      id: 11,
      type: 'message',
      date: '2024-01-02T03:13:00',
      date_unixtime: 'not-a-number',
      from: 'Dave',
      from_id: 'user10005',
      text: 'dropped by both parsers',
    },
    {
      id: 12,
      type: 'message',
      date: '2024-01-02T03:14:00',
      date_unixtime: '1704165240',
      from: 'Bob',
      from_id: 'user10002',
      media_type: 'animation',
      file: 'animations/gif_1.mp4',
      mime_type: 'video/mp4',
      text: '',
    },
  ]
}

function multiChatExport() {
  return {
    about: 'Here is the data you requested. Telegram export.',
    personal_information: { user_id: 10001, first_name: 'Alice' },
    chats: {
      about: 'This page lists all chats from this export.',
      list: [
        {
          name: '干扰聊天 A',
          type: 'personal_chat',
          id: 901,
          messages: [
            {
              id: 1,
              type: 'message',
              date: '2024-01-01T00:00:00',
              date_unixtime: '1704067200',
              from: 'Noise',
              from_id: 'user1',
              text: 'must not appear',
            },
          ],
        },
        { name: '目标群 Target', type: 'private_supergroup', id: -1001234567890, messages: chatMessages() },
        { name: '', type: 'personal_chat', id: 903, messages: [] },
      ],
    },
  }
}

function singleChatExport() {
  return { name: 'Telegram Test Chat', type: 'private_supergroup', id: 200123, messages: chatMessages() }
}

describe('telegram native parser parity', { skip: !nativeAvailable() && 'native module not built' }, () => {
  it('produces identical output to the TS parser for a selected chat in a full export', async () => {
    const { nativeResult, tsResult } = await parseBothWays(
      'telegram.json',
      JSON.stringify(multiChatExport(), null, 2),
      'telegram-native',
      { chatIndex: 1 }
    )
    assertParity(nativeResult, tsResult)

    // Sanity-check the highest-risk semantics directly, so both parsers being
    // wrong in the same way still fails.
    assert.equal(nativeResult.meta?.name, '目标群 Target')
    assert.equal(nativeResult.meta?.type, 'group')
    assert.equal(nativeResult.meta?.groupId, '-1001234567890')
    assert.equal(nativeResult.messages.length, 11)
    assert.equal(nativeResult.messages[1].content, '前缀 重点https://example.com 尾巴')
    assert.equal(nativeResult.messages[1].replyToMessageId, '1')
    assert.equal(nativeResult.messages[2].content, '[invite_members] Bob, Carol')
    assert.equal(nativeResult.messages[3].content, '[pin_message]')
    assert.equal(nativeResult.messages[3].senderAccountName, '系统')
    assert.equal(nativeResult.messages[4].content, '[sticker 🎉] 庆祝一下')
    assert.deepEqual(nativeResult.messages[7].attachments, [
      {
        kind: 'audio',
        path: 'voice_messages/audio_1.ogg',
        name: undefined,
        mimeType: 'audio/ogg',
        size: undefined,
        durationMs: 7000,
        width: undefined,
        height: undefined,
      },
    ])
    assert.equal(nativeResult.messages[9].senderAccountName, '99')
    assert.deepEqual(
      nativeResult.members.map((member) => member.platformId),
      ['10001', '10002', '10003', '10004', '99', '10005']
    )
  })

  it('selects other chats by index, including an empty one', async () => {
    const content = JSON.stringify(multiChatExport(), null, 2)
    const first = await parseBothWays('telegram.json', content, 'telegram-native', { chatIndex: 0 })
    assertParity(first.nativeResult, first.tsResult)
    assert.equal(first.nativeResult.meta?.type, 'private')
    assert.equal(first.nativeResult.meta?.groupId, undefined)
    assert.equal(first.nativeResult.messages.length, 1)

    // No chatIndex at all must behave like index 0 in both paths.
    const implicit = await parseBothWays('telegram.json', content, 'telegram-native')
    assertParity(implicit.nativeResult, implicit.tsResult)
    assert.equal(implicit.nativeResult.meta?.name, '干扰聊天 A')

    const empty = await parseBothWays('telegram.json', content, 'telegram-native', { chatIndex: 2 })
    assertParity(empty.nativeResult, empty.tsResult)
    assert.equal(empty.nativeResult.meta?.name, 'Telegram Chat 903')
    assert.deepEqual(empty.nativeResult.messages, [])
  })

  it('reports an out-of-range chat index the same way as the TS parser', async () => {
    await withFixture('telegram.json', JSON.stringify(multiChatExport(), null, 2), async (filePath) => {
      try {
        delete process.env[ENV_KEY]
        await assert.rejects(collect(filePath, { chatIndex: 9 }), /未找到索引 9 对应的聊天/)
        process.env[ENV_KEY] = '1'
        await assert.rejects(collect(filePath, { chatIndex: 9 }), /未找到索引 9 对应的聊天/)
      } finally {
        delete process.env[ENV_KEY]
      }
    })
  })

  it('produces identical output to the TS parser for a single-chat export', async () => {
    const { nativeResult, tsResult } = await parseBothWays(
      'chat.json',
      JSON.stringify(singleChatExport(), null, 2),
      'telegram-native-single'
    )
    assertParity(nativeResult, tsResult)

    assert.equal(nativeResult.meta?.name, 'Telegram Test Chat')
    assert.equal(nativeResult.meta?.groupId, '200123')
    assert.equal(nativeResult.messages.length, 11)
    // The single-chat TS parser names actor-less service messages differently
    // from the full-export one; the kernel follows each parser it replaces.
    assert.equal(nativeResult.messages[3].senderAccountName, 'System')
    assert.deepEqual(nativeResult.messages[5].attachments, [
      {
        kind: 'image',
        path: 'photos/photo_1@02-01-2024_03-08-00.jpg',
        name: undefined,
        mimeType: undefined,
        size: undefined,
        durationMs: undefined,
        width: 1280,
        height: 960,
      },
    ])
  })

  it('lists the same chats as the stream-json scanner', async () => {
    // The chat picker runs before any import, so a wrong list is user-visible
    // even when the parse itself is fine.
    const withEdgeCases = multiChatExport()
    withEdgeCases.chats.list.push({ name: '', type: 'private_group', id: 904, messages: [] })
    await withFixture('telegram.json', JSON.stringify(withEdgeCases, null, 2), async (filePath) => {
      try {
        delete process.env[ENV_KEY]
        const nativeChats = await scanChats(filePath)
        process.env[ENV_KEY] = '1'
        const tsChats = await scanChats(filePath)
        assert.deepEqual(nativeChats, tsChats)
        assert.deepEqual(nativeChats, [
          { index: 0, name: '干扰聊天 A', type: 'personal_chat', id: 901, messageCount: 1 },
          { index: 1, name: '目标群 Target', type: 'private_supergroup', id: -1001234567890, messageCount: 12 },
          // An empty name falls back to `Chat ${id}` in both scanners.
          { index: 2, name: 'Chat 903', type: 'personal_chat', id: 903, messageCount: 0 },
          { index: 3, name: 'Chat 904', type: 'private_group', id: 904, messageCount: 0 },
        ])
      } finally {
        delete process.env[ENV_KEY]
      }
    })
  })

  it('falls back to the TS parser for values the kernel refuses to guess at', async () => {
    // The TS parser passes a null photo width straight into the attachment;
    // the kernel refuses non-numeric dimensions, so the wrapper must restart
    // on the TS parser and still deliver its exact output.
    const single = {
      name: 'Telegram Test Chat',
      type: 'personal_chat',
      id: 7,
      messages: [
        {
          id: 1,
          type: 'message',
          date: '2024-01-02T03:04:05',
          date_unixtime: '1704164645',
          from: 'Alice',
          from_id: 'user10001',
          photo: 'photos/photo_1.jpg',
          width: null,
          height: null,
          text: '',
        },
      ],
    }

    const { nativeResult, tsResult } = await parseBothWays(
      'chat.json',
      JSON.stringify(single, null, 2),
      'telegram-native-single'
    )
    assertParity(nativeResult, tsResult)
    assert.equal(nativeResult.messages.length, 1)
    assert.equal(nativeResult.messages[0].attachments?.[0].width, null)
  })
})
