/**
 * Local speech-to-text (Whisper via Transformers.js).
 *
 * Inference and persistence are kept apart: `createTranscriber` owns the model,
 * `transcribeSessionAttachments` owns the queue and writes each result the
 * moment it is produced, so an interrupted run resumes where it stopped instead
 * of re-paying for the audio it already transcribed.
 *
 * Everything runs on the user's machine. When the model is not cached and the
 * network is unreachable the first call fails with the model id and cache path;
 * nothing is retried in a loop.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { applyTranscript, listPendingAudioAttachments, type DatabaseAdapter } from '@openchatlab/core'
import { appLogger } from '../logging/app-logger'
import { resolveAttachmentFile } from '../services/attachment-service'
import {
  configureTransformersEnv,
  LOCAL_ONNX_SESSION_OPTIONS,
  type LoadTransformers,
} from '../semantic-index/embedding/local'
import type { SemanticIndexModelDownloadSource } from '../semantic-index/config'
import { findAudioDecoder, type AudioDecoder } from './decoders'
import { DEFAULT_TRANSCRIPTION_PROFILE_ID, TRANSCRIPTION_PROFILES, type TranscriptionProfileId } from './profiles'
import { resampleToMono16k } from './resample'

const LOG_SCOPE = 'transcription'

/** Overrides the model cache directory; used by benchmarks and smoke tests. */
export const TRANSCRIPTION_MODEL_CACHE_DIR_ENV = 'CHATLAB_MODEL_CACHE_DIR'

/**
 * `auto` leaves the language token to Whisper. Transformers.js 4.2.0 has no
 * language detection: it warns and falls back to English, so Chinese sessions
 * should pass `zh` explicitly.
 */
export type TranscriptionLanguage = 'auto' | 'zh' | 'en'

export interface CreateTranscriberOptions {
  loadTransformers: LoadTransformers
  /** Model cache directory; see `resolveTranscriptionModelCacheDir`. */
  cacheDir?: string
  modelDownloadSource?: SemanticIndexModelDownloadSource
  modelDownloadProxyUrl?: string
  profile?: TranscriptionProfileId
}

export interface TranscribePcmResult {
  text: string
  /** Wall-clock inference time in milliseconds, for progress reporting and benchmarks. */
  durationMs: number
}

export interface Transcriber {
  readonly modelId: string
  transcribePcm(pcm16k: Float32Array, options?: { language?: TranscriptionLanguage }): Promise<TranscribePcmResult>
  dispose(): Promise<void>
}

type AsrPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{ text: string } | Array<{ text: string }>>

interface DisposableAsrPipeline extends AsrPipeline {
  dispose?: () => Promise<void>
}

/**
 * Where Whisper weights are cached.
 *
 * Mirrors the semantic index (`{aiDataDir}/models/…`, outside the cache
 * directory so clearing caches does not delete a 250 MB download).
 */
export function resolveTranscriptionModelCacheDir(aiDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TRANSCRIPTION_MODEL_CACHE_DIR_ENV]?.trim()
  if (override) return path.resolve(override)
  return path.join(aiDataDir, 'models', 'transcription')
}

/** Load the model lazily and keep it for the life of the returned transcriber. */
export function createTranscriber(options: CreateTranscriberOptions): Transcriber {
  const profile = TRANSCRIPTION_PROFILES[options.profile ?? DEFAULT_TRANSCRIPTION_PROFILE_ID]
  let pipelinePromise: Promise<DisposableAsrPipeline> | null = null

  const getPipeline = (): Promise<DisposableAsrPipeline> => {
    if (!pipelinePromise) {
      pipelinePromise = loadPipeline(profile.modelId, profile.dtype, options).catch((error) => {
        pipelinePromise = null
        throw new Error(
          `Failed to load the speech recognition model ${profile.modelId}. It is downloaded on first use and cached in ${options.cacheDir ?? 'the default Transformers.js cache'}; check the network connection or the model download source.`,
          { cause: error }
        )
      })
    }
    return pipelinePromise
  }

  return {
    modelId: profile.modelId,

    async transcribePcm(pcm16k, { language = 'auto' } = {}) {
      const pipeline = await getPipeline()
      const startedAt = Date.now()
      const output = await pipeline(pcm16k, {
        ...(language === 'auto' ? {} : { language }),
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      })
      const text = Array.isArray(output) ? output.map((chunk) => chunk.text).join('') : output.text
      return { text: text.trim(), durationMs: Date.now() - startedAt }
    },

    async dispose() {
      const pending = pipelinePromise
      pipelinePromise = null
      if (!pending) return
      const pipeline = await pending.catch(() => null)
      await pipeline?.dispose?.()
    },
  }
}

async function loadPipeline(
  modelId: string,
  dtype: 'q8',
  options: CreateTranscriberOptions
): Promise<DisposableAsrPipeline> {
  const transformers = await options.loadTransformers()
  await configureTransformersEnv(transformers, {
    cacheDir: options.cacheDir,
    modelDownloadProxyUrl: options.modelDownloadProxyUrl,
    modelDownloadSource: options.modelDownloadSource,
  })
  const pipeline = await transformers.pipeline('automatic-speech-recognition', modelId, {
    dtype,
    session_options: LOCAL_ONNX_SESSION_OPTIONS,
  })
  return pipeline as unknown as DisposableAsrPipeline
}

// ---------- Session queue ----------

/** Why an attachment is not transcribed on this run. */
export type TranscriptionSkipReason = 'unreadable-path' | 'unsupported-format'

export interface TranscriptionCandidate {
  attachmentId: number
  absolutePath: string
  fileName: string
  decoder: AudioDecoder
  durationMs: number | null
}

export interface TranscriptionSkip {
  attachmentId: number
  fileName: string | null
  reason: TranscriptionSkipReason
}

export interface TranscriptionPlan {
  pending: TranscriptionCandidate[]
  skipped: TranscriptionSkip[]
}

export interface TranscriptionFailure {
  attachmentId: number
  error: string
}

export interface TranscriptionProgress {
  attachmentId: number
  completed: number
  total: number
  status: 'transcribed' | 'failed'
}

export interface TranscribeSessionAttachmentsOptions {
  db: DatabaseAdapter
  transcriber: Pick<Transcriber, 'modelId' | 'transcribePcm'>
  /** Only used to tag the log lines; the database connection already selects the session. */
  sessionId: string
  attachmentIds?: readonly number[]
  language?: TranscriptionLanguage
  onProgress?: (progress: TranscriptionProgress) => void
}

export interface TranscribeSessionAttachmentsResult {
  transcribed: number
  skipped: TranscriptionSkip[]
  failed: TranscriptionFailure[]
}

/**
 * Which untranscribed audio attachments this runtime can handle.
 *
 * Split out so `--dry-run` can report the plan without loading a model.
 */
export function planSessionTranscription(db: DatabaseAdapter, attachmentIds?: readonly number[]): TranscriptionPlan {
  const pending: TranscriptionCandidate[] = []
  const skipped: TranscriptionSkip[] = []

  for (const attachment of listPendingAudioAttachments(db, attachmentIds)) {
    const file = resolveAttachmentFile(db, attachment.id)
    if (!file) {
      skipped.push({ attachmentId: attachment.id, fileName: attachment.fileName, reason: 'unreadable-path' })
      continue
    }
    const decoder = findAudioDecoder({ fileName: file.fileName, mimeType: file.contentType })
    if (!decoder) {
      skipped.push({ attachmentId: attachment.id, fileName: file.fileName, reason: 'unsupported-format' })
      continue
    }
    pending.push({
      attachmentId: attachment.id,
      absolutePath: file.absolutePath,
      fileName: file.fileName,
      decoder,
      durationMs: attachment.durationMs,
    })
  }

  return { pending, skipped }
}

/**
 * Transcribe a session's audio attachments one at a time, writing each result
 * before starting the next. A failure on one attachment does not abort the run.
 */
export async function transcribeSessionAttachments(
  options: TranscribeSessionAttachmentsOptions
): Promise<TranscribeSessionAttachmentsResult> {
  const { db, transcriber, sessionId, language = 'auto', onProgress } = options
  const { pending, skipped } = planSessionTranscription(db, options.attachmentIds)
  const failed: TranscriptionFailure[] = []
  let transcribed = 0

  appLogger.info(LOG_SCOPE, 'Session transcription started', {
    sessionId,
    model: transcriber.modelId,
    language,
    pending: pending.length,
    skipped: skipped.length,
  })
  const startedAt = Date.now()

  for (const candidate of pending) {
    try {
      const bytes = await fs.readFile(candidate.absolutePath)
      const decoded = await candidate.decoder.decode(bytes)
      const pcm = resampleToMono16k(decoded.pcm, decoded.sampleRate)
      const { text } = await transcriber.transcribePcm(pcm, { language })
      applyTranscript(db, {
        attachmentId: candidate.attachmentId,
        text,
        model: transcriber.modelId,
        now: Date.now(),
      })
      transcribed++
      onProgress?.({
        attachmentId: candidate.attachmentId,
        completed: transcribed + failed.length,
        total: pending.length,
        status: 'transcribed',
      })
    } catch (error) {
      failed.push({ attachmentId: candidate.attachmentId, error: errorMessage(error) })
      // One unreadable file must not strand the rest of the queue.
      appLogger.warn(LOG_SCOPE, 'Attachment transcription failed', {
        sessionId,
        attachmentId: candidate.attachmentId,
        error: errorMessage(error),
      })
      onProgress?.({
        attachmentId: candidate.attachmentId,
        completed: transcribed + failed.length,
        total: pending.length,
        status: 'failed',
      })
    }
  }

  appLogger.info(LOG_SCOPE, 'Session transcription completed', {
    sessionId,
    model: transcriber.modelId,
    transcribed,
    skipped: skipped.length,
    failed: failed.length,
    elapsedMs: Date.now() - startedAt,
  })
  return { transcribed, skipped, failed }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
