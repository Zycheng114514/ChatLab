/**
 * Benchmark: Rust native Discord parser vs pure-TS stream-json parser.
 *
 * Generates a synthetic DiscordChatExporter JSON export (one guild channel)
 * and parses it with both paths.
 *
 * Events are drained without retaining messages, so the reported peak RSS is
 * the parser's own footprint rather than the cost of holding the whole result
 * (the real importer writes each batch to SQLite and drops it).
 *
 * Usage:
 *   pnpm exec tsx scripts/bench-discord-parser.mts [messageCount]
 *   pnpm exec tsx scripts/bench-discord-parser.mts --target-mb=100
 *
 * `--target-mb` picks the message count that lands the file near that size; a
 * bare number sets the message count directly. Runs the TS path only when the
 * Rust Discord kernel is not built (pnpm build:native).
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
/** Two roles per member, so the "longer roles wins" member update path runs. */
const ROLE_NAMES = ['成员 Member', '管理员 Moderator', '机器人 Bot']

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

function buildAuthor(memberIndex: number, roleCount: number): Record<string, unknown> {
  return {
    id: String(700000000000000000n + BigInt(memberIndex)),
    name: `member${memberIndex}`,
    discriminator: '0000',
    nickname: `成员${memberIndex}号 Member`,
    color: '#1abc9c',
    isBot: false,
    roles: ROLE_NAMES.slice(0, roleCount).map((name, index) => ({
      id: String(800000000000000000n + BigInt(index)),
      name,
      color: '#3498db',
      position: index,
    })),
    avatarUrl: `https://cdn.discordapp.com/avatars/${memberIndex}/avatar.png`,
  }
}

/** One synthetic message; the index drives which Discord shape is produced. */
function buildMessage(index: number, memberIndex: number): Record<string, unknown> {
  const id = String(900000000000000000n + BigInt(index))
  const seconds = index % 60
  const base = {
    id,
    type: 'Default',
    timestamp: `2024-01-02T03:04:${String(seconds).padStart(2, '0')}.000+00:00`,
    timestampEdited: null,
    callEndedTimestamp: null,
    isPinned: false,
    content: `${SAMPLE_TEXTS[index % SAMPLE_TEXTS.length]} #${index}`,
    // Members appearing later with more roles exercise the roles-update path.
    author: buildAuthor(memberIndex, index < MEMBER_COUNT ? 1 : ROLE_NAMES.length),
    attachments: [],
    embeds: [],
    stickers: [],
  }

  switch (index % 10) {
    case 1:
      return { ...base, type: 'Reply', reference: { messageId: id, channelId: 'c1', guildId: 'g1' } }
    case 2:
      return { ...base, type: 'ChannelPinnedMessage', content: '' }
    case 3:
      // Attachment-only message: the type is rewritten from the file extension.
      return {
        ...base,
        content: '',
        attachments: [
          {
            id,
            url: `general_Files/photo_${index}.png`,
            fileName: `photo_${index}.png`,
            fileSizeBytes: 4096 + index,
          },
        ],
      }
    case 4:
      return {
        ...base,
        attachments: [
          { id, url: `general_Files/clip_${index}.mp4`, fileName: `clip_${index}.mp4`, fileSizeBytes: 1048576 },
          { id: `${id}b`, url: `general_Files/notes_${index}.pdf`, fileName: `报告_${index}.pdf`, fileSizeBytes: 2048 },
        ],
      }
    case 5:
      return {
        ...base,
        content: '',
        embeds: [
          {
            title: `链接标题 ${index}`,
            url: `https://example.com/${index}`,
            description: '这是一段比较长的描述文本，用来触发 slice(0, 30) 的分支。',
            thumbnail: { url: `https://example.com/thumb_${index}.png` },
          },
        ],
      }
    case 6:
      return { ...base, content: '', stickers: [{ id, name: `贴纸 ${index}`, format: 'PNG', sourceUrl: 'https://s' }] }
    case 7:
      return {
        ...base,
        attachments: [
          { id, url: `general_Files/voice_${index}.ogg`, fileName: `voice_${index}.ogg`, fileSizeBytes: 65536 },
        ],
        content: '',
      }
    case 8:
      return { ...base, type: 'UserJoin', content: '' }
    default:
      return base
  }
}

/** Average serialized bytes per message, used to hit a requested file size. */
function averageMessageBytes(): number {
  let total = 0
  const sampleSize = 1000
  for (let index = 0; index < sampleSize; index++) {
    total += Buffer.byteLength(JSON.stringify(buildMessage(index, index % MEMBER_COUNT))) + 1
  }
  return total / sampleSize
}

function resolveMessageCount(options: CliOptions): number {
  if (options.targetMb === undefined) return options.messageCount
  return Math.max(1, Math.round((options.targetMb * 1024 * 1024) / averageMessageBytes()))
}

async function generateFixture(filePath: string, count: number): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' })
  const write = async (chunk: string) => {
    if (!stream.write(chunk)) await once(stream, 'drain')
  }

  await write(
    '{"guild":{"id":"g1","name":"性能测试服务器 Bench Guild",' +
      '"iconUrl":"https://cdn.discordapp.com/icons/g1/icon.png"},' +
      '"channel":{"id":"c1","type":"GuildTextChat","categoryId":"cat1","category":"文字频道",' +
      '"name":"general","topic":"benchmark channel"},' +
      '"dateRange":{"after":null,"before":null},"messages":['
  )

  const batch: string[] = []
  for (let index = 0; index < count; index++) {
    batch.push(JSON.stringify(buildMessage(index, index % MEMBER_COUNT)))
    if (batch.length >= 5000) {
      await write((index + 1 > batch.length ? ',' : '') + batch.join(','))
      batch.length = 0
    }
  }
  if (batch.length > 0) await write((count > batch.length ? ',' : '') + batch.join(','))
  await write(`],"messageCount":${count}}`)

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
    for await (const event of parseFileWithFormat(PARSER_FORMAT_IDS.DISCORD_TYRRRZ, { filePath })) {
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
  const nativeAvailable = isNativeFormatAvailable(PARSER_FORMAT_IDS.DISCORD_TYRRRZ)
  if (saved !== undefined) process.env[ENV_KEY] = saved
  if (!nativeAvailable) {
    console.log('Native Discord kernel unavailable — benchmarking the TS parser only.\n')
  }

  const dir = createChatLabTempDir('bench', 'discord-')
  const filePath = join(dir, 'bench.json')
  try {
    console.log(`Generating fixture: ${messageCount.toLocaleString()} messages in one channel...`)
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
