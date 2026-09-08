import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ParsedAttachment } from '@openchatlab/shared-types'
import { parseFile } from '@openchatlab/parser'
import initWasm, { initSync, WasmParser } from '../wasm/generated/parser_native.js'
import { WebRuntimeError } from '../runtime-error'
import { parseBrowserImportSource } from './browser-parser'
import type { BrowserImportParseResult } from './browser-parser'
import type { BrowserParseSource } from './chatlab-parser'
import type { BrowserWasmParserLoader } from './wasm-parser'

const wasmBytes = new Uint8Array(readFileSync(new URL('../wasm/generated/parser_native_bg.wasm', import.meta.url)))
initSync({ module: wasmBytes })

const wasmLoader: BrowserWasmParserLoader = async () => ({ default: initWasm, WasmParser })

function source(name: string, value: unknown): BrowserParseSource {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value)])
  return {
    name,
    size: blob.size,
    type: 'application/json',
    text: () => blob.text(),
    arrayBuffer: () => blob.arrayBuffer(),
    slice: (start, end) => blob.slice(start, end),
  }
}

/** Message shapes the Telegram kernel and the TS browser parser must agree on. */
const TELEGRAM_MESSAGES = [
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
    text: ['前缀 ', { type: 'bold', text: '重点' }, ' 尾巴'],
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
    members: ['Bob'],
    text: '',
  },
  {
    id: 4,
    type: 'message',
    date: '2024-01-02T03:07:00',
    date_unixtime: '1704164820',
    from: 'Alice 爱丽丝',
    from_id: 'user10001',
    photo: 'photos/photo_1.jpg',
    width: 1280,
    height: 960,
    text: '看这张图',
  },
  {
    id: 5,
    type: 'message',
    date: '2024-01-02T03:08:00',
    date_unixtime: '1704164880',
    from: 'Bob',
    from_id: 'user10002',
    file: 'voice_messages/audio_1.ogg',
    media_type: 'voice_message',
    mime_type: 'audio/ogg',
    duration_seconds: 7,
    text: '',
  },
  {
    id: 6,
    type: 'message',
    date: '2024-01-02T03:09:00',
    date_unixtime: '1704164940',
    from_id: 'channel99',
    text: 'no from',
  },
]

const TELEGRAM_SINGLE_EXPORT = {
  name: 'Telegram Test Chat',
  type: 'private_supergroup',
  id: 200123,
  messages: [
    ...TELEGRAM_MESSAGES,
    // Actor-less service message: both single-chat parsers name it 'System'.
    { id: 7, type: 'service', date_unixtime: '1704165000', actor_id: 'user10003', action: 'pin_message', text: '' },
  ],
}

// The full export deliberately carries no actor-less service message: the Node
// full-export parser names those '系统' while the browser parser names them
// 'System', and the kernel follows the Node parser it replaces.
const TELEGRAM_MULTI_EXPORT = {
  about: 'Here is the data you requested. Telegram export.',
  chats: {
    about: 'chats',
    list: [
      { name: '干扰聊天', type: 'personal_chat', id: 901, messages: [] },
      { name: '目标群 Target', type: 'private_supergroup', id: -1001234567890, messages: TELEGRAM_MESSAGES },
    ],
  },
}

/** Attachments as produced by the Node TS parsers, the reference for media info. */
async function nodeAttachments(
  content: string,
  formatOptions?: Record<string, unknown>
): Promise<Array<ParsedAttachment[] | undefined>> {
  const dir = mkdtempSync(join(tmpdir(), 'chatlab-wasm-telegram-'))
  const filePath = join(dir, 'telegram.json')
  const saved = process.env.CHATLAB_DISABLE_NATIVE_PERF
  process.env.CHATLAB_DISABLE_NATIVE_PERF = '1'
  try {
    writeFileSync(filePath, content, 'utf-8')
    const attachments: Array<ParsedAttachment[] | undefined> = []
    for await (const event of parseFile({ filePath, formatOptions })) {
      if (event.type === 'error') throw event.data
      if (event.type === 'messages') attachments.push(...event.data.map((message) => message.attachments))
    }
    return attachments
  } finally {
    if (saved === undefined) delete process.env.CHATLAB_DISABLE_NATIVE_PERF
    else process.env.CHATLAB_DISABLE_NATIVE_PERF = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The browser TS parser produces no attachments, so compare without them. */
function withoutAttachments(result: BrowserImportParseResult) {
  return {
    ...result,
    messages: result.messages.map(({ attachments: _attachments, ...message }) => message),
  }
}

describe('browser Rust WASM parser', () => {
  it('parses ChatLab JSON and WeFlow JSON through the generated WASM module', async () => {
    const chatlabSource = source('chatlab.json', {
      chatlab: { version: '1' },
      meta: { name: 'ChatLab', platform: 'wechat', type: 'group' },
      members: [{ platformId: 'alice', accountName: 'Alice' }],
      messages: [
        {
          sender: 'alice',
          accountName: 'Alice',
          groupNickname: 'A',
          timestamp: 1,
          type: 0,
          content: 'hello chatlab',
          platformMessageId: 'message-1',
          replyToMessageId: 'message-0',
        },
      ],
    })
    const chatlab = await parseBrowserImportSource(chatlabSource, { formatId: 'chatlab', wasmLoader })
    const chatlabTs = await parseBrowserImportSource(chatlabSource, {
      formatId: 'chatlab',
      wasmLoader: async () => null,
    })
    assert.equal(chatlab.meta.name, 'ChatLab')
    assert.deepEqual(
      chatlab.members.map((member) => member.platformId),
      ['alice']
    )
    assert.deepEqual(
      chatlab.messages.map((message) => message.content),
      ['hello chatlab']
    )
    assert.deepEqual(chatlab.messages[0], {
      senderPlatformId: 'alice',
      senderAccountName: 'Alice',
      senderGroupNickname: 'A',
      timestamp: 1,
      type: 0,
      content: 'hello chatlab',
      platformMessageId: 'message-1',
      replyToMessageId: 'message-0',
    })
    assert.deepEqual(chatlab, chatlabTs)

    const weflowSource = source('weflow.json', {
      weflow: { version: '1' },
      session: { wxid: 'room@chatroom', displayName: 'WeFlow', type: '群聊' },
      messages: [
        {
          localId: 1,
          createTime: 2,
          type: '文本消息',
          content: 'hello weflow',
          isSend: 1,
          senderUsername: 'bob',
          senderDisplayName: 'Bob',
        },
      ],
    })
    const weflow = await parseBrowserImportSource(weflowSource, { formatId: 'weflow', wasmLoader })
    const weflowTs = await parseBrowserImportSource(weflowSource, {
      formatId: 'weflow',
      wasmLoader: async () => null,
    })
    assert.deepEqual(weflow.meta, {
      name: 'WeFlow',
      platform: 'weixin',
      type: 'group',
      groupId: 'room@chatroom',
      groupAvatar: undefined,
      ownerId: 'bob',
    })
    assert.deepEqual(
      weflow.messages.map((message) => message.content),
      ['hello weflow']
    )
    assert.deepEqual(weflow, weflowTs)
  })

  it('parses a Telegram single-chat export through WASM and adds the attachments TS drops', async () => {
    const content = JSON.stringify(TELEGRAM_SINGLE_EXPORT, null, 2)
    const telegramSource = () => source('chat.json', content)
    const wasm = await parseBrowserImportSource(telegramSource(), {
      formatId: 'telegram-native-single',
      wasmLoader,
    })
    const ts = await parseBrowserImportSource(telegramSource(), {
      formatId: 'telegram-native-single',
      wasmLoader: async () => null,
    })

    assert.deepEqual(withoutAttachments(wasm), withoutAttachments(ts))
    assert.equal(wasm.meta.name, 'Telegram Test Chat')
    assert.equal(wasm.meta.groupId, '200123')
    assert.equal(wasm.messages.at(-1)?.senderAccountName, 'System')
    assert.deepEqual(
      wasm.messages.map((message) => message.attachments),
      await nodeAttachments(content)
    )
    assert.deepEqual(wasm.messages[3].attachments, [
      {
        kind: 'image',
        path: 'photos/photo_1.jpg',
        name: undefined,
        mimeType: undefined,
        size: undefined,
        durationMs: undefined,
        width: 1280,
        height: 960,
      },
    ])
  })

  it('parses the selected chat of a Telegram full export through WASM', async () => {
    const content = JSON.stringify(TELEGRAM_MULTI_EXPORT, null, 2)
    const telegramSource = () => source('result.json', content)
    const wasm = await parseBrowserImportSource(telegramSource(), {
      formatId: 'telegram-native',
      chatIndex: 1,
      wasmLoader,
    })
    const ts = await parseBrowserImportSource(telegramSource(), {
      formatId: 'telegram-native',
      chatIndex: 1,
      wasmLoader: async () => null,
    })

    assert.deepEqual(withoutAttachments(wasm), withoutAttachments(ts))
    assert.equal(wasm.meta.name, '目标群 Target')
    assert.equal(wasm.meta.groupId, '-1001234567890')
    assert.deepEqual(
      wasm.messages.map((message) => message.attachments),
      await nodeAttachments(content, { chatIndex: 1 })
    )
  })

  it('requires a chat selection before importing a Telegram full export', async () => {
    await assert.rejects(
      parseBrowserImportSource(source('result.json', JSON.stringify(TELEGRAM_MULTI_EXPORT, null, 2)), {
        formatId: 'telegram-native',
        wasmLoader,
      }),
      (error: unknown) => error instanceof WebRuntimeError && error.code === 'MULTI_CHAT_SELECTION_REQUIRED'
    )
  })

  it('falls back to TS when the strict Rust kernel rejects an off-spec ChatLab message', async () => {
    const logs: string[] = []
    const result = await parseBrowserImportSource(
      source('fallback.json', {
        chatlab: { version: '1' },
        meta: { name: 'Fallback', platform: 'wechat', type: 'group' },
        messages: [{ sender: 'alice', timestamp: 1, type: 0, content: 'TS handles the missing account name' }],
      }),
      {
        formatId: 'chatlab',
        wasmLoader,
        onLog: (event) => logs.push(`${event.level}:${event.message}`),
      }
    )

    assert.equal(result.messages[0]?.senderAccountName, 'alice')
    assert.ok(logs.some((message) => message.includes('info:Rust WASM parse failed; falling back to TS')))
  })

  it('falls back to TS when the WASM module cannot initialize', async () => {
    const result = await parseBrowserImportSource(
      source('init-fallback.json', {
        chatlab: { version: '1' },
        meta: { name: 'Init fallback', platform: 'wechat', type: 'group' },
        messages: [{ sender: 'alice', accountName: 'Alice', timestamp: 1, type: 0, content: 'fallback' }],
      }),
      {
        formatId: 'chatlab',
        wasmLoader: async () => {
          throw new Error('WASM initialization failed')
        },
      }
    )

    assert.equal(result.messages[0]?.content, 'fallback')
  })

  it('propagates cancellation after synchronous WASM parsing instead of falling back', async () => {
    let checks = 0
    await assert.rejects(
      parseBrowserImportSource(
        source('cancelled.json', {
          chatlab: { version: '1' },
          meta: { name: 'Cancelled', platform: 'wechat', type: 'group' },
          messages: [{ sender: 'alice', accountName: 'Alice', timestamp: 1, type: 0, content: 'stop' }],
        }),
        {
          formatId: 'chatlab',
          wasmLoader,
          checkCancelled: () => {
            checks += 1
            if (checks >= 3) throw new WebRuntimeError('REQUEST_CANCELLED', 'cancelled')
          },
        }
      ),
      (error: unknown) => error instanceof WebRuntimeError && error.code === 'REQUEST_CANCELLED'
    )
  })
})
