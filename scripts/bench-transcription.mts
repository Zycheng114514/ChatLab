/**
 * Local voice transcription benchmark.
 *
 * Synthesizes roughly a minute of Chinese and a minute of English speech with
 * macOS `say` (no audio is committed to the repo, and no user data is touched),
 * then runs the tiny / base / small Whisper profiles one at a time and reports
 * elapsed time, real-time factor, first-load time, peak RSS and how much the
 * model cache grew.
 *
 * The models run serially and each one is disposed before the next starts, so
 * only one model is ever resident. RSS is process-wide, so a later row still
 * includes whatever the previous model did not return to the OS — read a row as
 * an upper bound for that model, not as an isolated measurement.
 *
 * Usage:
 *   CHATLAB_MODEL_CACHE_DIR=/tmp/chatlab-models pnpm exec tsx scripts/bench-transcription.mts [tiny,base,small]
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  createTranscriber,
  resolveTranscriptionModelCacheDir,
  TRANSCRIPTION_PROFILE_IDS,
  TRANSCRIPTION_PROFILES,
  type TranscriptionProfileId,
} from '../packages/node-runtime/src/transcription'
import { decodeWav } from '../packages/node-runtime/src/transcription/wav'
import { resampleToMono16k } from '../packages/node-runtime/src/transcription/resample'
import { createChatLabTempDir } from './chatlab-temp.mjs'

/** A bare "Eddy" resolves to the English voice and renders Chinese as silence. */
const CHINESE_VOICE = 'Eddy (Chinese (China mainland))'
const TARGET_SECONDS = 60

const CHINESE_SENTENCES = [
  '今天天气不错，我们下午出去走走吧。',
  '这个周末有人一起去打球吗？还是老地方，下午三点。',
  '我刚看完那部电影，剧情比想象中好很多，推荐你也去看看。',
  '明天的会议改到上午十点了，记得提前十分钟到会议室。',
]
const ENGLISH_SENTENCES = [
  'The weather is nice today, so we should go outside this afternoon.',
  'Does anyone want to play basketball this weekend at the usual place?',
  'I just finished that movie and the story was much better than I expected.',
  'Tomorrow the meeting moved to ten in the morning, so please arrive early.',
]

interface Sample {
  language: 'zh' | 'en'
  pcm: Float32Array
  seconds: number
}

interface ModelResult {
  id: TranscriptionProfileId
  modelId: string
  loadMs: number
  runs: Array<{ language: string; elapsedMs: number; rtf: number; text: string }>
  peakRssMb: number
  cacheGrowthMb: number
}

function assertSayAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error('This benchmark synthesizes speech with macOS `say`; run it on macOS.')
  }
  try {
    execFileSync('say', ['-v', '?'], { stdio: 'ignore' })
  } catch (error) {
    throw new Error('macOS `say` is not available, so the benchmark cannot synthesize its audio.', { cause: error })
  }
}

/** Repeat the sentences until the rendered audio is at least TARGET_SECONDS long. */
function synthesize(dir: string, language: 'zh' | 'en'): Sample {
  const sentences = language === 'zh' ? CHINESE_SENTENCES : ENGLISH_SENTENCES
  const voice = language === 'zh' ? [`-v`, CHINESE_VOICE] : []
  const wavPath = path.join(dir, `${language}.wav`)

  for (let repeats = 2; repeats <= 32; repeats *= 2) {
    const text = Array.from({ length: repeats }, () => sentences.join(' ')).join(' ')
    execFileSync('say', [...voice, '-o', wavPath, '--data-format=LEI16@16000', text])
    const decoded = decodeWav(fs.readFileSync(wavPath))
    const pcm = resampleToMono16k(decoded.pcm, decoded.sampleRate)
    const seconds = pcm.length / 16000
    if (seconds >= TARGET_SECONDS) return { language, pcm, seconds }
  }
  throw new Error(`could not synthesize ${TARGET_SECONDS}s of ${language} speech`)
}

function directorySizeMb(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  const output = execFileSync('du', ['-sk', dir], { encoding: 'utf8' })
  return Number(output.split(/\s+/)[0]) / 1024
}

async function benchmark(id: TranscriptionProfileId, samples: Sample[], cacheDir: string): Promise<ModelResult> {
  const cacheBefore = directorySizeMb(cacheDir)
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 100)
  sampler.unref()

  const transcriber = createTranscriber({
    loadTransformers: () => import('@huggingface/transformers'),
    cacheDir,
    profile: id,
  })

  try {
    // Half a second of silence: pays the download and session init without timing real audio.
    // The language is pinned so the run does not log the auto-detect fallback warning.
    const loadStartedAt = Date.now()
    await transcriber.transcribePcm(new Float32Array(8000), { language: 'en' })
    const loadMs = Date.now() - loadStartedAt

    const runs: ModelResult['runs'] = []
    for (const sample of samples) {
      const startedAt = Date.now()
      const { text } = await transcriber.transcribePcm(sample.pcm, { language: sample.language })
      const elapsedMs = Date.now() - startedAt
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      runs.push({ language: sample.language, elapsedMs, rtf: elapsedMs / 1000 / sample.seconds, text })
    }

    return {
      id,
      modelId: TRANSCRIPTION_PROFILES[id].modelId,
      loadMs,
      runs,
      peakRssMb: peakRss / 1024 / 1024,
      cacheGrowthMb: directorySizeMb(cacheDir) - cacheBefore,
    }
  } finally {
    clearInterval(sampler)
    await transcriber.dispose()
  }
}

async function main(): Promise<void> {
  assertSayAvailable()

  const requested = (process.argv[2] ?? TRANSCRIPTION_PROFILE_IDS.join(',')).split(',')
  const profiles = requested.map((id) => {
    const profile = TRANSCRIPTION_PROFILE_IDS.find((known) => known === id.trim())
    if (!profile) throw new Error(`Unknown profile: ${id}. Use ${TRANSCRIPTION_PROFILE_IDS.join(', ')}.`)
    return profile
  })

  const workDir = createChatLabTempDir('bench', 'transcription-')
  const cacheDir = resolveTranscriptionModelCacheDir(path.join(workDir, 'ai'))
  console.log(`audio: ${workDir}`)
  console.log(`model cache: ${cacheDir}`)

  const samples = [synthesize(workDir, 'zh'), synthesize(workDir, 'en')]
  for (const sample of samples) console.log(`  ${sample.language}: ${sample.seconds.toFixed(1)}s`)

  const results: ModelResult[] = []
  for (const profile of profiles) {
    console.log(`\nrunning ${profile}...`)
    results.push(await benchmark(profile, samples, cacheDir))
  }

  console.log('\nmodel   load(s)  zh(s)   zh RTF  en(s)   en RTF  peak RSS(MB)  download(MB)')
  for (const result of results) {
    const [zh, en] = result.runs
    console.log(
      [
        result.id.padEnd(7),
        (result.loadMs / 1000).toFixed(1).padStart(7),
        (zh.elapsedMs / 1000).toFixed(1).padStart(7),
        zh.rtf.toFixed(3).padStart(7),
        (en.elapsedMs / 1000).toFixed(1).padStart(7),
        en.rtf.toFixed(3).padStart(7),
        result.peakRssMb.toFixed(0).padStart(13),
        result.cacheGrowthMb.toFixed(0).padStart(12),
      ].join(' ')
    )
  }
  console.log(`\ntotal model cache: ${directorySizeMb(cacheDir).toFixed(0)} MB`)
  for (const result of results) {
    for (const run of result.runs) {
      console.log(`${result.id} ${run.language}: ${run.text.slice(0, 60)}…`)
    }
  }
}

await main()
