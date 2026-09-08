/**
 * Parity tests: the Rust Discord kernel must produce identical ParseResult
 * output to the pure-TS stream-json parser for a DiscordChatExporter export.
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

async function collect(filePath: string): Promise<CollectedResult> {
  const result: CollectedResult = { meta: null, members: [], messages: [] }
  for await (const event of parseFile({ filePath })) {
    if (event.type === 'meta') result.meta = event.data
    else if (event.type === 'members') result.members.push(...event.data)
    else if (event.type === 'messages') result.messages.push(...event.data)
    else if (event.type === 'error') throw event.data
  }
  return result
}

async function parseBothWays(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'chatlab-discord-parity-'))
  try {
    const filePath = join(dir, 'discord.json')
    writeFileSync(filePath, content, 'utf-8')
    assert.equal(detectFormat(filePath)?.id, 'discord-tyrrrz')
    try {
      delete process.env[ENV_KEY]
      const nativeResult = await collect(filePath)
      process.env[ENV_KEY] = '1'
      const tsResult = await collect(filePath)
      return { nativeResult, tsResult }
    } finally {
      delete process.env[ENV_KEY]
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertParity(nativeResult: CollectedResult, tsResult: CollectedResult) {
  assert.deepEqual(nativeResult.meta, tsResult.meta)
  assert.deepEqual(nativeResult.members, tsResult.members)
  assert.equal(nativeResult.messages.length, tsResult.messages.length)
  for (let i = 0; i < tsResult.messages.length; i++) {
    assert.deepEqual(nativeResult.messages[i], tsResult.messages[i], `message #${i} differs`)
  }
}

function author(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `user_${id}`,
    discriminator: '0000',
    nickname: `昵称 ${id}`,
    color: '#1abc9c',
    isBot: false,
    roles: [{ id: 'r1', name: '成员 Member', color: '#3498db', position: 0 }],
    avatarUrl: `https://cdn.discordapp.com/avatars/${id}/a.png`,
    ...overrides,
  }
}

function message(overrides: Record<string, unknown>) {
  return {
    id: 'm0',
    type: 'Default',
    timestamp: '2024-01-02T03:04:05.000+00:00',
    timestampEdited: null,
    callEndedTimestamp: null,
    isPinned: false,
    content: '',
    author: author('a1'),
    attachments: [],
    embeds: [],
    stickers: [],
    ...overrides,
  }
}

/**
 * Every branch the TS parser takes: type mapping (text / reply / system /
 * unknown / call), attachment-driven type rewriting for all four extension
 * classes, marker order for attachments + embeds + stickers, embed titles
 * falling back to url / sliced description / 'link', pure-sticker messages,
 * a member seen again with more roles, an author without nickname/avatar and
 * a message without a reply reference.
 */
function discordExport() {
  return {
    guild: { id: 'g1', name: '公会 Guild', iconUrl: 'https://cdn.discordapp.com/icons/g1/icon.png' },
    channel: { id: 'c1', type: 'GuildTextChat', categoryId: 'cat1', category: '文字频道', name: 'general' },
    dateRange: { after: null, before: null },
    messages: [
      message({ id: 'm1', content: 'hello discord 你好' }),
      message({
        id: 'm2',
        type: 'Reply',
        content: '回复一下',
        reference: { messageId: 'm1', channelId: 'c1', guildId: 'g1' },
      }),
      message({ id: 'm3', type: 'ChannelPinnedMessage' }),
      message({ id: 'm4', type: 'Call', content: '通话' }),
      message({ id: 'm5', type: 'SomeFutureDiscordType', content: '未知类型' }),
      // Attachment-only messages: the type comes from the file extension.
      message({
        id: 'm6',
        attachments: [{ id: 'at1', url: 'general_Files/photo.PNG', fileName: 'photo.PNG', fileSizeBytes: 4096 }],
      }),
      message({
        id: 'm7',
        attachments: [{ id: 'at2', url: 'general_Files/clip.mp4', fileName: 'clip.mp4', fileSizeBytes: 1048576 }],
      }),
      message({
        id: 'm8',
        attachments: [{ id: 'at3', url: 'general_Files/voice.ogg', fileName: 'voice.ogg' }],
      }),
      message({
        id: 'm9',
        attachments: [{ id: 'at4', url: 'https://cdn.discordapp.com/x/报告.pdf', fileName: '报告.pdf' }],
      }),
      // Content plus several markers: order is attachments, embeds, stickers.
      message({
        id: 'm10',
        content: '看这些',
        attachments: [
          { id: 'at5', url: 'general_Files/a.gif', fileName: 'a.gif', fileSizeBytes: 12 },
          { id: 'at6', url: 'general_Files/b.zip', fileName: 'b.zip', fileSizeBytes: 34 },
        ],
        embeds: [{ title: '嵌入标题', url: 'https://example.com', description: '描述' }],
        stickers: [{ id: 's1', name: '贴纸', format: 'PNG', sourceUrl: 'https://s' }],
      }),
      // Embed-only message: LINK, with the three title fallbacks.
      message({
        id: 'm11',
        embeds: [
          { url: 'https://only-url.example.com' },
          { description: '这段描述超过三十个字符，用来验证 slice(0, 30) 的截断结果是否一致。' },
          { thumbnail: { url: 'https://example.com/t.png' } },
        ],
      }),
      // Sticker-only message: EMOJI.
      message({ id: 'm12', stickers: [{ id: 's2', name: '只有贴纸', format: 'APNG' }] }),
      // Same author, more roles than before: the member entry keeps the longer list.
      message({
        id: 'm13',
        content: '角色变多了',
        author: author('a1', {
          roles: [
            { id: 'r1', name: '成员 Member', color: '#3498db', position: 0 },
            { id: 'r2', name: '管理员 Moderator', color: '#e74c3c', position: 1 },
          ],
        }),
      }),
      // Author without nickname or avatar, and a bot.
      message({
        id: 'm14',
        content: 'bot speaking',
        author: { id: 'a2', name: 'helper-bot', discriminator: '0000', isBot: true, roles: [] },
      }),
    ],
  }
}

describe('discord native parser parity', { skip: !nativeAvailable() && 'native module not built' }, () => {
  it('produces identical output to the TS parser for a DiscordChatExporter export', async () => {
    const { nativeResult, tsResult } = await parseBothWays(JSON.stringify(discordExport(), null, 2))
    assertParity(nativeResult, tsResult)

    // Sanity-check the highest-risk semantics directly, so both parsers being
    // wrong in the same way still fails.
    assert.equal(nativeResult.meta?.name, '公会 Guild - general')
    assert.equal(nativeResult.meta?.groupId, 'c1')
    assert.equal(nativeResult.meta?.groupAvatar, 'https://cdn.discordapp.com/icons/g1/icon.png')
    assert.equal(nativeResult.messages.length, 14)
    assert.deepEqual(
      nativeResult.messages.map((item) => item.type),
      [0, 25, 80, 23, 99, 1, 3, 2, 4, 0, 7, 5, 0, 0]
    )
    assert.equal(nativeResult.messages[0].timestamp, 1704164645)
    assert.equal(nativeResult.messages[1].replyToMessageId, 'm1')
    assert.equal(nativeResult.messages[2].content, null)
    assert.equal(nativeResult.messages[5].content, '[Image: photo.PNG]')
    assert.equal(
      nativeResult.messages[9].content,
      '看这些\n[Image: a.gif]\n[File: b.zip]\n[Link: 嵌入标题]\n[Sticker: 贴纸]'
    )
    assert.equal(
      nativeResult.messages[10].content,
      '[Link: https://only-url.example.com]\n[Link: 这段描述超过三十个字符，用来验证 slice(0, 30) ]\n[Link: link]'
    )
    assert.equal(nativeResult.messages[11].content, '[Sticker: 只有贴纸]')
    assert.deepEqual(nativeResult.messages[8].attachments, [
      { kind: 'file', path: 'https://cdn.discordapp.com/x/报告.pdf', name: '报告.pdf', size: undefined },
    ])
    assert.deepEqual(
      nativeResult.members.map((member) => member.platformId),
      ['a1', 'a2']
    )
    assert.deepEqual(nativeResult.members[0].roles, [
      { id: 'r1', name: '成员 Member' },
      { id: 'r2', name: '管理员 Moderator' },
    ])
    assert.equal(nativeResult.members[1].groupNickname, undefined)
    assert.equal(nativeResult.members[1].avatar, undefined)
  })

  it('falls back to the TS parser for values the kernel refuses to guess at', async () => {
    // The TS parser stringifies a numeric author id into the member map; the
    // kernel refuses it, so the wrapper must restart on TS and still deliver
    // that exact output.
    const source = discordExport()
    source.messages = [message({ id: 'm1', content: 'numeric author id', author: author('a1', { id: 42 }) })]

    const { nativeResult, tsResult } = await parseBothWays(JSON.stringify(source, null, 2))
    assertParity(nativeResult, tsResult)
    assert.equal(nativeResult.messages.length, 1)
    assert.equal(nativeResult.messages[0].senderPlatformId, 42 as unknown as string)
  })
})
