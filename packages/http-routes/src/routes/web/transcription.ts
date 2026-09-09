/**
 * Voice transcription routes — /_web/transcription/* and the per-session PCM endpoint.
 *
 * CLI Web only: the page decodes the attachment with Web Audio (Chromium reads
 * mp3, m4a and ogg, which the Node decoders cannot) and posts the raw 16 kHz
 * mono Float32 samples. The desktop app does the same over IPC instead, so the
 * whole group is skipped when no worker client is injected.
 */

import type { FastifyInstance } from 'fastify'
import {
  InvalidTranscriptionSettingError,
  getTranscriptionSettings,
  listSessionTranscriptionQueue,
  MAX_TRANSCRIPTION_PCM_SAMPLES,
  transcribeSessionAttachmentPcm,
  TranscribeAttachmentPcmError,
  updateTranscriptionSettings,
  type TranscriptionWorker,
} from '@openchatlab/node-runtime'
import type { TranscriptionLanguage } from '@openchatlab/core'
import type { RuntimeRouteContext } from '../../context/runtime'
import { invalidPayload } from '../../errors'

const FLOAT32_BYTES = 4

/**
 * Body limit for the PCM endpoint: 30 minutes of Float32 samples, about 115 MB.
 *
 * The shared server's default is 50 MB, which a long voice note would exceed,
 * and Fastify's own default is 1 MB — so this route has to raise it explicitly.
 */
export const TRANSCRIPTION_PCM_BODY_LIMIT = MAX_TRANSCRIPTION_PCM_SAMPLES * FLOAT32_BYTES

type TranscriptionRouteContext = Pick<RuntimeRouteContext, 'sessionAdapter'>

export function registerTranscriptionRoutes(
  server: FastifyInstance,
  ctx: TranscriptionRouteContext,
  worker: TranscriptionWorker
): void {
  const adapter = ctx.sessionAdapter

  // Raw PCM arrives as application/octet-stream; Fastify rejects unknown
  // content types with 415 unless a parser is registered for them.
  server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body)
  )

  server.get('/_web/transcription/config', async () => getTranscriptionSettings())

  server.patch<{ Body: { model?: unknown; language?: unknown } }>('/_web/transcription/config', async (request) => {
    try {
      return updateTranscriptionSettings(request.body ?? {})
    } catch (error) {
      if (error instanceof InvalidTranscriptionSettingError) throw invalidPayload(error.message)
      throw error
    }
  })

  server.get<{ Params: { id: string } }>('/_web/sessions/:id/transcription/pending', async (request) => {
    return { items: listSessionTranscriptionQueue(adapter.ensureReadonly(request.params.id)) }
  })

  server.post<{
    Params: { id: string; attachmentId: string }
    Querystring: { language?: string }
    Body: Buffer
  }>(
    '/_web/sessions/:id/attachments/:attachmentId/transcribe',
    { bodyLimit: TRANSCRIPTION_PCM_BODY_LIMIT },
    async (request) => {
      const db = adapter.ensureWritable(request.params.id)
      const attachmentId = Number(request.params.attachmentId)
      if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
        throw invalidPayload(`Invalid attachment ID: ${request.params.attachmentId}`)
      }

      const language = parseLanguage(request.query.language)
      const pcm16k = toPcm(request.body)

      try {
        return await transcribeSessionAttachmentPcm({ db, worker, attachmentId, pcm16k, language })
      } catch (error) {
        // An attachment id from another session is simply absent from this
        // session's database, so the cross-session case lands here too.
        if (error instanceof TranscribeAttachmentPcmError) throw invalidPayload(error.message)
        throw error
      }
    }
  )
}

function parseLanguage(value: string | undefined): TranscriptionLanguage | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'auto' && value !== 'zh' && value !== 'en') {
    throw invalidPayload(`Unsupported transcription language: ${value}. Use one of auto, zh, en.`)
  }
  return value
}

function toPcm(body: Buffer): Float32Array {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw invalidPayload('Request body must be 32-bit float PCM samples')
  }
  if (body.byteLength % FLOAT32_BYTES !== 0) {
    throw invalidPayload(`PCM payload is not a whole number of 32-bit floats (${body.byteLength} bytes)`)
  }
  // Copy into a fresh buffer rather than viewing the request's: Node's pooled
  // Buffers are rarely 4-byte aligned, which a Float32Array view requires.
  // Wire format is little-endian, matching every platform ChatLab runs on.
  const samples = new Float32Array(body.byteLength / FLOAT32_BYTES)
  new Uint8Array(samples.buffer).set(body)
  return samples
}
