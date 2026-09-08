/**
 * `clb transcribe` — turn a session's voice attachments into text locally.
 *
 * Headless runs only see what the Node decoders can read (WAV today); the
 * desktop app and CLI Web decode the rest in the browser. Attachments this
 * runtime cannot handle are listed with a reason instead of being dropped.
 */

import path from 'node:path'
import type { Command } from 'commander'
import {
  SemanticIndexConfigStore,
  SEMANTIC_INDEX_CONFIG_FILE,
  createLocalEmbeddingRuntimeManager,
  createTranscriber,
  planSessionTranscription,
  resolveTranscriptionModelCacheDir,
  transcribeSessionAttachments,
  TRANSCRIPTION_PROFILE_IDS,
  type TranscriptionLanguage,
  type TranscriptionProfileId,
  type TranscriptionSkip,
} from '@openchatlab/node-runtime'
import { initRuntime } from '../runtime'
import { resolveCliLocalEmbeddingRuntimeConfig } from '../semantic-index/local-runtime'

const LANGUAGES: TranscriptionLanguage[] = ['auto', 'zh', 'en']

const SKIP_REASON_TEXT: Record<TranscriptionSkip['reason'], string> = {
  'unreadable-path': 'file is remote or outside the imported directory',
  'unsupported-format': 'no Node decoder for this format (use the desktop app or CLI Web)',
}

interface TranscribeCommandOptions {
  session: string
  model: string
  language: string
  attachment?: string[]
  dryRun?: boolean
}

export function registerTranscribeCommand(program: Command): void {
  program
    .command('transcribe')
    .description('Transcribe the voice attachments of a session with a local Whisper model')
    .requiredOption('--session <id>', 'Session ID whose voice attachments should be transcribed')
    .option(`--model <${TRANSCRIPTION_PROFILE_IDS.join('|')}>`, 'Whisper model size', 'base')
    .option(`--language <${LANGUAGES.join('|')}>`, 'Spoken language; auto leaves it to the model', 'auto')
    .option('--attachment <id...>', 'Restrict the run to these attachment IDs')
    .option('--dry-run', 'List what would be transcribed and why the rest is skipped')
    .action(async (options: TranscribeCommandOptions) => {
      try {
        await runTranscribe(options)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}

async function runTranscribe(options: TranscribeCommandOptions): Promise<void> {
  const profile = parseProfile(options.model)
  const language = parseLanguage(options.language)
  const attachmentIds = parseAttachmentIds(options.attachment)

  const { pathProvider, dbManager } = initRuntime()
  try {
    // Writable: the transcript lands on the attachment row and the message text.
    const db = dbManager.openWritable(options.session)
    if (!db) throw new Error(`Session ${options.session} not found`)

    const plan = planSessionTranscription(db, attachmentIds)
    printSkipped(plan.skipped)

    if (options.dryRun) {
      for (const candidate of plan.pending) {
        console.log(`  would transcribe #${candidate.attachmentId} ${candidate.fileName} (${candidate.decoder.id})`)
      }
      console.log(`${plan.pending.length} to transcribe, ${plan.skipped.length} skipped (dry run)`)
      return
    }
    if (plan.pending.length === 0) {
      console.log('Nothing to transcribe: every audio attachment already has a transcript or cannot be decoded here.')
      return
    }

    const aiDataDir = pathProvider.getAiDataDir()
    const runtimeManager = createLocalEmbeddingRuntimeManager(resolveCliLocalEmbeddingRuntimeConfig(aiDataDir))
    const downloadSource = new SemanticIndexConfigStore(path.join(aiDataDir, SEMANTIC_INDEX_CONFIG_FILE)).get().local
      .downloadSource
    const transcriber = createTranscriber({
      loadTransformers: () => runtimeManager.loadTransformers(),
      cacheDir: resolveTranscriptionModelCacheDir(aiDataDir),
      modelDownloadSource: downloadSource,
      profile,
    })

    console.log(`Transcribing ${plan.pending.length} attachment(s) with ${transcriber.modelId} (${language})`)
    try {
      const result = await transcribeSessionAttachments({
        db,
        transcriber,
        sessionId: options.session,
        attachmentIds,
        language,
        // stderr: stdout stays a clean summary for agent/script consumers.
        onProgress: (progress) =>
          console.error(`  [${progress.completed}/${progress.total}] #${progress.attachmentId} ${progress.status}`),
      })

      console.log(`Transcribed ${result.transcribed}, skipped ${result.skipped.length}, failed ${result.failed.length}`)
      for (const failure of result.failed) {
        console.error(`  failed #${failure.attachmentId}: ${failure.error}`)
      }
      if (result.failed.length > 0) process.exitCode = 1
    } finally {
      await transcriber.dispose()
    }
  } finally {
    dbManager.closeAll()
  }
}

function printSkipped(skipped: TranscriptionSkip[]): void {
  for (const skip of skipped) {
    console.error(`  skipped #${skip.attachmentId} ${skip.fileName ?? ''}: ${SKIP_REASON_TEXT[skip.reason]}`)
  }
}

function parseProfile(value: string): TranscriptionProfileId {
  const profile = TRANSCRIPTION_PROFILE_IDS.find((id) => id === value)
  if (!profile) throw new Error(`Unknown model: ${value}. Use one of ${TRANSCRIPTION_PROFILE_IDS.join(', ')}.`)
  return profile
}

function parseLanguage(value: string): TranscriptionLanguage {
  const language = LANGUAGES.find((id) => id === value)
  if (!language) throw new Error(`Unknown language: ${value}. Use one of ${LANGUAGES.join(', ')}.`)
  return language
}

function parseAttachmentIds(values?: string[]): number[] | undefined {
  if (!values || values.length === 0) return undefined
  return values.map((value) => {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid attachment ID: ${value}`)
    return id
  })
}
