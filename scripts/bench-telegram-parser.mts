/**
 * Benchmark: Rust native Telegram parser vs pure-TS stream-json parser.
 *
 * Generates a synthetic Telegram "export all chats" JSON (three chats: the
 * target chat at index 1 plus one smaller distractor chat on each side) and
 * parses the target chat with both paths.
 *
 * Events are drained without retaining messages, so the reported peak RSS is
 * the parser's own footprint rather than the cost of holding the whole result
 * (the real importer writes each batch to SQLite and drops it).
 *
 * Usage:
 *   pnpm exec tsx scripts/bench-telegram-parser.mts [messageCount]
 *   pnpm exec tsx scripts/bench-telegram-parser.mts --target-mb=100
 *
 * `--target-mb` picks the message count that lands the whole file (target
 * chat + distractors) near that size; a bare number sets the target chat's
 * message count directly. Runs the TS path only when the Rust Telegram kernel
 * is not built (pnpm build:native).
 */

import { createWriteStream, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { createChatLabTempDir } from './chatlab-temp.mjs'

import { PARSER_FORMAT_IDS } from '../packages/parser/src/format-ids'
import { parseFileWithFormat } from '../packages/parser/src/index'
import { isNativeFormatAvailable } from '../packages/parser/src/native/loader'

const ENV_KEY = 'CHATLAB_DISABLE_NATIVE_PERF'
const RSS_SAMPLE_INTERVAL_MS = 25

const MEMBER_COUNT = 200
/** The target chat sits at index 1; each distractor holds ~10% of its messages. */
const TARGET_CHAT_INDEX = 1
const DISTRACTOR_RATIO = 0.1

const SAMPLE_TEXTS = [
  '今天天气不错，我们出去玩吧！',
  'Sounds good — 我大概七点到，路上堵车的话再说。',
  '哈哈哈哈哈这也太离谱了吧',
  'Shipping the new parser today, 顺便把基准脚本也补上了。',
  '周末有人一起打球吗？地点老地方，时间下午三点，人齐就开打。',
  'Let me know 如果你需要我帮忙 review 那个 PR。',
]

interface CliOptions {
  messageCount: number
  targetMb?: number
}

function parseCliOptions(argv: string[]): CliOptions {
  let messageCount = 500_000
  let targetMb: number | undefined
  for (const arg of argv) {
    const targetMatch = /^--target-mb=(\d+(?:\.\d+)?)$/.exec(arg)
    if (targetMatch) {
      targetMb = Number(targetMatch[1])
      continue
    }
    if (/^\d+$/.test(arg)) messageCount = Number(arg)
  }
  return { messageCount, targetMb }
}

/** One synthetic message; the index drives which Telegram shape is produced. */
function buildMessage(id: number, memberIndex: number): Record<string, unknown> {
  const from = `成员${memberIndex}号 Member`
  const fromId = `user${100000 + memberIndex}`
  const base = {
    id,
    type: 'message',
    date: '2024-01-02T03:04:05',
    date_unixtime: String(1704164645 + id * 3),
    from,
    from_id: fromId,
  }
  const text = `${SAMPLE_TEXTS[id % SAMPLE_TEXTS.length]} #${id}`

  switch (id % 10) {
    case 1:
      // Rich text: mixed array of plain strings and entity objects.
      return {
        ...base,
        text: [text, { type: 'bold', text: '重点' }, ' ', { type: 'link', text: 'https://example.com/a' }],
        text_entities: [{ type: 'bold', text: '重点' }],
      }
    case 2:
      // Service message (no `from`/`from_id`, uses actor instead).
      return {
        id,
        type: 'service',
        date: '2024-01-02T03:04:05',
        date_unixtime: String(1704164645 + id * 3),
        actor: from,
        actor_id: fromId,
        action: 'invite_members',
        members: [`成员${(memberIndex + 1) % MEMBER_COUNT}号 Member`],
        text: '',
      }
    case 3:
      return { ...base, media_type: 'sticker', sticker_emoji: '🎉', file: `stickers/sticker_${id}.webp`, text: '' }
    case 4:
      return {
        ...base,
        photo: `photos/photo_${id}@02-01-2024_03-04-05.jpg`,
        width: 1280,
        height: 960,
        text,
      }
    case 5:
      return {
        ...base,
        file: `files/document_${id}.pdf`,
        file_name: `报告_${id}.pdf`,
        mime_type: 'application/pdf',
        text: '',
      }
    case 6:
      return {
        ...base,
        file: `voice_messages/audio_${id}.ogg`,
        media_type: 'voice_message',
        mime_type: 'audio/ogg',
        duration_seconds: 3 + (id % 17),
        text: '',
      }
    case 7:
      return { ...base, reply_to_message_id: Math.max(1, id - 2), text }
    case 8:
      return { ...base, forwarded_from: '某个频道 Channel', text }
    case 9:
      // No `from`: the sender name falls back to the extracted platform id.
      return { id, type: 'message', date: base.date, date_unixtime: base.date_unixtime, from_id: fromId, text }
    default:
      return { ...base, text }
  }
}

/** Average serialized bytes per message, used to hit a requested file size. */
function averageMessageBytes(): number {
  let total = 0
  const sampleSize = 1000
  for (let id = 1; id <= sampleSize; id++) {
    total += Buffer.byteLength(JSON.stringify(buildMessage(id, id % MEMBER_COUNT))) + 1
  }
  return total / sampleSize
}

function resolveMessageCount(options: CliOptions): number {
  if (options.targetMb === undefined) return options.messageCount
  const totalRatio = 1 + 2 * DISTRACTOR_RATIO
  return Math.max(1, Math.round((options.targetMb * 1024 * 1024) / (averageMessageBytes() * totalRatio)))
}

async function generateFixture(filePath: string, count: number): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' })
  const write = async (chunk: string) => {
    if (!stream.write(chunk)) await once(stream, 'drain')
  }

  const distractorCount = Math.max(1, Math.round(count * DISTRACTOR_RATIO))
  const writeChat = async (name: string, id: number, type: string, messageCount: number) => {
    await write(`{"name":${JSON.stringify(name)},"type":${JSON.stringify(type)},"id":${id},"messages":[`)
    const batch: string[] = []
    for (let i = 0; i < messageCount; i++) {
      batch.push(JSON.stringify(buildMessage(i + 1, i % MEMBER_COUNT)))
      if (batch.length >= 5000) {
        await write((i + 1 > batch.length ? ',' : '') + batch.join(','))
        batch.length = 0
      }
    }
    if (batch.length > 0) await write((messageCount > batch.length ? ',' : '') + batch.join(','))
    await write(']}')
  }

  await write(
    '{"about":"Here is the data you requested. Telegram export.",' +
      '"personal_information":{"user_id":100000,"first_name":"Bench"},' +
      '"chats":{"about":"This page lists all chats from this export.","list":['
  )
  await writeChat('干扰聊天 A Noise', 901, 'personal_chat', distractorCount)
  await write(',')
  await writeChat('性能测试群 Bench Group', 902, 'private_supergroup', count)
  await write(',')
  await writeChat('干扰聊天 B Noise', 903, 'personal_chat', distractorCount)
  await write(']}}')

  stream.end()
  await once(stream, 'finish')
}

interface BenchResult {
  label: string
  durationMs: number
  messages: number
  members: number
  peakRssMb: number
}

async function benchOnce(label: string, filePath: string, disableNative: boolean): Promise<BenchResult> {
  if (disableNative) process.env[ENV_KEY] = '1'
  else delete process.env[ENV_KEY]

  global.gc?.()
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, RSS_SAMPLE_INTERVAL_MS)

  let messages = 0
  let members = 0
  const start = performance.now()
  try {
    // Drain events without retaining messages (mirrors the streaming importer).
    for await (const event of parseFileWithFormat(PARSER_FORMAT_IDS.TELEGRAM_NATIVE, {
      filePath,
      formatOptions: { chatIndex: TARGET_CHAT_INDEX },
    })) {
      if (event.type === 'messages') messages += event.data.length
      else if (event.type === 'members') members += event.data.length
      else if (event.type === 'error') throw event.data
    }
  } finally {
    clearInterval(sampler)
  }

  return {
    label,
    durationMs: performance.now() - start,
    messages,
    members,
    peakRssMb: Math.max(peakRss, process.memoryUsage().rss) / 1024 / 1024,
  }
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const messageCount = resolveMessageCount(options)

  const saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  const nativeAvailable = isNativeFormatAvailable(PARSER_FORMAT_IDS.TELEGRAM_NATIVE)
  if (saved !== undefined) process.env[ENV_KEY] = saved
  if (!nativeAvailable) {
    console.log('Native Telegram kernel unavailable — benchmarking the TS parser only.\n')
  }

  const dir = createChatLabTempDir('bench', 'telegram-')
  const filePath = join(dir, 'bench.json')
  try {
    console.log(`Generating fixture: target chat ${messageCount.toLocaleString()} messages + 2 distractor chats...`)
    await generateFixture(filePath, messageCount)
    const sizeMb = statSync(filePath).size / 1024 / 1024
    console.log(`Fixture size: ${sizeMb.toFixed(1)} MB\n`)

    // Interleave runs to be fair about cache warmth, always one path at a time.
    const results: BenchResult[] = [await benchOnce('ts #1', filePath, true)]
    if (nativeAvailable) results.push(await benchOnce('native #1', filePath, false))
    results.push(await benchOnce('ts #2', filePath, true))
    if (nativeAvailable) results.push(await benchOnce('native #2', filePath, false))

    for (const result of results) {
      console.log(
        `${result.label.padEnd(10)} ${result.durationMs.toFixed(0).padStart(8)} ms | ` +
          `${(sizeMb / (result.durationMs / 1000)).toFixed(1).padStart(6)} MB/s | ` +
          `${result.messages.toLocaleString()} messages, ${result.members} members | ` +
          `peak rss ${result.peakRssMb.toFixed(0)} MB`
      )
    }

    const best = (prefix: string) =>
      Math.min(...results.filter((r) => r.label.startsWith(prefix)).map((r) => r.durationMs))
    if (nativeAvailable) {
      console.log(`\nSpeedup (best of 2): ${(best('ts') / best('native')).toFixed(2)}x`)
      const [ts, native] = [results[0], results[1]]
      if (ts.messages !== native.messages || ts.members !== native.members) {
        console.error(`Output mismatch: ts=${ts.messages}/${ts.members} native=${native.messages}/${native.members}`)
        process.exit(1)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main()
