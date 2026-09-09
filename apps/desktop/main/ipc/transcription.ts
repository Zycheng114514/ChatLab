/**
 * Voice transcription IPC.
 *
 * The renderer decodes the attachment with Web Audio — Chromium reads mp3, m4a
 * and ogg, which the Node decoders cannot — and hands the main process mono
 * 16 kHz PCM. Inference happens in a worker thread; the main process only opens
 * the session database, checks the arguments and stores the result.
 */

import * as path from 'node:path'
import { ipcMain } from 'electron'
import {
  createTranscriptionWorkerClient,
  getTranscriptionSettings,
  listSessionTranscriptionQueue,
  MAX_TRANSCRIPTION_PCM_SAMPLES,
  SEMANTIC_INDEX_CONFIG_FILE,
  SemanticIndexConfigStore,
  transcribeSessionAttachmentPcm,
  updateTranscriptionSettings,
  WHISPER_SAMPLE_RATE,
  type TranscriptionLanguage,
  type TranscriptionWorkerClient,
} from '@openchatlab/node-runtime'
import type { DatabaseAdapter } from '@openchatlab/core'
import { getInternalDbManager } from '../internal-api/server'
import { getPathProvider } from '../paths/provider'
import { resolveModelDownloadProxyUrl } from '../network/proxy'

const FLOAT32_BYTES = 4

let workerClient: TranscriptionWorkerClient | null = null
let workerClientPromise: Promise<TranscriptionWorkerClient> | null = null

/**
 * The transcription worker client: one per process, built by the first request.
 *
 * Download source and proxy are the semantic index's settings, read once here;
 * the thread itself is started and released by the client.
 */
async function getWorkerClient(): Promise<TranscriptionWorkerClient> {
  if (workerClient) return workerClient
  workerClientPromise ??= (async () => {
    const aiDataDir = getPathProvider().getAiDataDir()
    const downloadSource = new SemanticIndexConfigStore(path.join(aiDataDir, SEMANTIC_INDEX_CONFIG_FILE)).get().local
      .downloadSource
    const client = createTranscriptionWorkerClient({
      aiDataDir,
      downloadSource,
      proxyUrl: await resolveModelDownloadProxyUrl(),
      profile: getTranscriptionSettings().model,
      workerEntryUrl: import.meta.url.endsWith('.ts')
        ? undefined
        : new URL('./transcription-worker.js', import.meta.url),
    })
    workerClient = client
    return client
  })()
  try {
    return await workerClientPromise
  } catch (error) {
    workerClientPromise = null
    throw error
  }
}

function openSession(sessionId: string): DatabaseAdapter {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Session ID is required')
  const dbManager = getInternalDbManager()
  if (!dbManager) throw new Error('Database manager is not ready')
  const db = dbManager.openWritable(sessionId)
  if (!db) throw new Error(`Session ${sessionId} not found`)
  return db
}

/** ArrayBuffer to samples: a whole number of floats, at most 30 minutes of audio. */
function toPcm(pcm: ArrayBuffer): Float32Array {
  if (!(pcm instanceof ArrayBuffer)) throw new Error('PCM payload must be an ArrayBuffer of 32-bit floats')
  if (pcm.byteLength % FLOAT32_BYTES !== 0) {
    throw new Error(`PCM payload is not a whole number of 32-bit floats (${pcm.byteLength} bytes)`)
  }
  if (pcm.byteLength / FLOAT32_BYTES > MAX_TRANSCRIPTION_PCM_SAMPLES) {
    const minutes = MAX_TRANSCRIPTION_PCM_SAMPLES / WHISPER_SAMPLE_RATE / 60
    throw new Error(`Audio is longer than the ${minutes} minute limit`)
  }
  return new Float32Array(pcm)
}

function toAttachmentId(attachmentId: number): number {
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
    throw new Error(`Invalid attachment ID: ${String(attachmentId)}`)
  }
  return attachmentId
}

export function registerTranscriptionHandlers(): void {
  ipcMain.handle('transcription:getConfig', () => getTranscriptionSettings())

  ipcMain.handle('transcription:setConfig', (_, patch: { model?: string; language?: string }) =>
    updateTranscriptionSettings(patch ?? {})
  )

  ipcMain.handle('transcription:listPending', (_, sessionId: string) => ({
    items: listSessionTranscriptionQueue(openSession(sessionId)),
  }))

  ipcMain.handle(
    'transcription:transcribePcm',
    async (_, sessionId: string, attachmentId: number, pcm: ArrayBuffer, language?: TranscriptionLanguage) => {
      // Open and validate before touching the worker: a bad request should not
      // pay for loading a model.
      const db = openSession(sessionId)
      const id = toAttachmentId(attachmentId)
      const pcm16k = toPcm(pcm)
      return await transcribeSessionAttachmentPcm({
        db,
        worker: await getWorkerClient(),
        attachmentId: id,
        pcm16k,
        language,
      })
    }
  )
}

/** Stop the worker thread on quit; five idle minutes would close it anyway. */
export async function closeTranscriptionWorker(): Promise<void> {
  const client = workerClient
  workerClient = null
  workerClientPromise = null
  await client?.close()
}
