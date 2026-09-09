/**
 * Voice transcription logic shared by the desktop IPC handlers and the CLI Web
 * routes.
 *
 * Both entry layers do the same three things — read or write the transcription
 * settings, list a session's untranscribed voice attachments, and turn PCM
 * decoded by the browser into a stored transcript — so the validation and the
 * worker plumbing live here and the handlers stay adapters.
 */

import { loadConfig, setConfigField, transcriptionConfigSchema } from '@openchatlab/config'
import { listPendingAudioAttachments, type DatabaseAdapter, type TranscriptionLanguage } from '@openchatlab/core'
import { transcribeAttachmentPcm, type TranscribeAttachmentPcmResult } from '../transcription/service'
import { TRANSCRIPTION_PROFILES, type TranscriptionProfileId } from '../transcription/profiles'
import type { TranscriptionWorkerClient } from '../transcription/worker-client'

export interface TranscriptionSettings {
  model: TranscriptionProfileId
  language: TranscriptionLanguage
}

/**
 * A voice attachment waiting to be transcribed.
 *
 * Deliberately without the stored file path: the renderer already addresses
 * attachments by id through `chatlab-media://` and `/_web/sessions/...`, and
 * handing it a filesystem path would be a new way for one to leak.
 */
export interface PendingTranscriptionItem {
  id: number
  messageId: number
  fileName: string | null
  mimeType: string | null
  durationMs: number | null
}

/** The part of `TranscriptionWorkerClient` this service uses; tests pass a fake. */
export type TranscriptionWorker = Pick<TranscriptionWorkerClient, 'transcribePcm'>

export interface TranscribeSessionAttachmentPcmOptions {
  db: DatabaseAdapter
  worker: TranscriptionWorker
  attachmentId: number
  /** Mono 16 kHz samples decoded by the caller (Web Audio in both UIs). */
  pcm16k: Float32Array
  /** Defaults to the configured language; `auto` is resolved against the session. */
  language?: TranscriptionLanguage
  /** Defaults to the configured Whisper size. */
  profile?: TranscriptionProfileId
}

export function getTranscriptionSettings(): TranscriptionSettings {
  return loadConfig().transcription
}

/**
 * Persist a partial settings change and return the settings as they now stand.
 *
 * Invalid values are rejected before anything is written, so a bad request from
 * either entry layer cannot leave a config file the app refuses to load.
 */
export function updateTranscriptionSettings(patch: { model?: unknown; language?: unknown }): TranscriptionSettings {
  const fields: Array<[keyof TranscriptionSettings, string]> = []
  if (patch.model !== undefined) fields.push(['model', parseSetting('model', patch.model)])
  if (patch.language !== undefined) fields.push(['language', parseSetting('language', patch.language)])
  for (const [key, value] of fields) {
    setConfigField(`transcription.${key}`, value)
  }
  return getTranscriptionSettings()
}

/** Thrown when a request carries a value the transcription settings do not accept. */
export class InvalidTranscriptionSettingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTranscriptionSettingError'
  }
}

/** Accepted values, read off the config schema so the two never drift apart. */
const SETTING_OPTIONS: Record<keyof TranscriptionSettings, readonly string[]> = {
  model: transcriptionConfigSchema.shape.model.removeDefault().options,
  language: transcriptionConfigSchema.shape.language.removeDefault().options,
}

function parseSetting<K extends keyof TranscriptionSettings>(key: K, value: unknown): TranscriptionSettings[K] {
  const options = SETTING_OPTIONS[key]
  if (typeof value !== 'string' || !options.includes(value)) {
    throw new InvalidTranscriptionSettingError(
      `Unsupported transcription ${key}: ${JSON.stringify(value)}. Use one of ${options.join(', ')}.`
    )
  }
  return value as TranscriptionSettings[K]
}

export function listSessionTranscriptionQueue(db: DatabaseAdapter): PendingTranscriptionItem[] {
  return listPendingAudioAttachments(db).map((attachment) => ({
    id: attachment.id,
    messageId: attachment.messageId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    durationMs: attachment.durationMs,
  }))
}

/**
 * Transcribe one attachment of an already-opened session database.
 *
 * `db` is the session's own database, so an attachment id from another session
 * simply is not there and the call fails with `attachment-not-found` — that is
 * what keeps one session's request from writing into another's.
 */
export async function transcribeSessionAttachmentPcm(
  options: TranscribeSessionAttachmentPcmOptions
): Promise<TranscribeAttachmentPcmResult> {
  const settings = getTranscriptionSettings()
  const profile = options.profile ?? settings.model
  const worker = options.worker
  return await transcribeAttachmentPcm({
    db: options.db,
    attachmentId: options.attachmentId,
    pcm16k: options.pcm16k,
    language: options.language ?? settings.language,
    transcriber: {
      // The worker reports the model it actually loaded; the profile decides it,
      // so the id is known here without waiting for the thread to start.
      modelId: TRANSCRIPTION_PROFILES[profile].modelId,
      transcribePcm: (pcm, { language }) => worker.transcribePcm(pcm, { language, profile }),
    },
  })
}
