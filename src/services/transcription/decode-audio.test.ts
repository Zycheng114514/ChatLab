import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AudioTooLongError,
  decodeAudioToPcm16k,
  MAX_TRANSCRIPTION_DURATION_SECONDS,
  targetFrameCount,
  TRANSCRIPTION_SAMPLE_RATE,
  UnsupportedAudioError,
} from './decode-audio'

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
}

/** Web Audio 不存在于 Node：只替身出解码这一步，够测错误映射。 */
function stubAudioContext(decodeAudioData: () => Promise<unknown>): () => void {
  return replaceGlobal(
    'OfflineAudioContext',
    class {
      decodeAudioData = decodeAudioData
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  )
}

describe('targetFrameCount', () => {
  it('rounds up to whole 16 kHz frames', () => {
    const cases: Array<{ seconds: number; frames: number }> = [
      { seconds: 1, frames: TRANSCRIPTION_SAMPLE_RATE },
      { seconds: 0.5, frames: 8000 },
      { seconds: 1.00001, frames: 16001 },
      { seconds: MAX_TRANSCRIPTION_DURATION_SECONDS, frames: MAX_TRANSCRIPTION_DURATION_SECONDS * 16000 },
    ]
    for (const { seconds, frames } of cases) {
      assert.equal(targetFrameCount(seconds), frames, `${seconds}s`)
    }
  })

  it('rejects audio past the 30 minute backend limit before it is uploaded', () => {
    assert.throws(() => targetFrameCount(MAX_TRANSCRIPTION_DURATION_SECONDS + 0.5), AudioTooLongError)
  })

  it('treats an empty or unreadable duration as an unsupported file', () => {
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => targetFrameCount(seconds), UnsupportedAudioError, String(seconds))
    }
  })
})

describe('decodeAudioToPcm16k', () => {
  it('reports a codec the browser cannot read as an unsupported format, keeping the reason', async () => {
    const restoreFetch = replaceGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]))))
    const restoreAudio = stubAudioContext(() => Promise.reject(new Error('Unable to decode audio data')))
    try {
      await assert.rejects(decodeAudioToPcm16k('chatlab-media://session/s/attachment/1'), (error: unknown) => {
        assert.ok(error instanceof UnsupportedAudioError)
        assert.equal(error.message, 'Unable to decode audio data')
        return true
      })
    } finally {
      restoreAudio()
      restoreFetch()
    }
  })

  it('reports a missing attachment file as a transport failure, not a format problem', async () => {
    const restoreFetch = replaceGlobal('fetch', () =>
      Promise.resolve(new Response('not found', { status: 404, statusText: 'Not Found' }))
    )
    const restoreAudio = stubAudioContext(() => Promise.reject(new Error('never reached')))
    try {
      await assert.rejects(decodeAudioToPcm16k('/_web/sessions/s/attachments/1'), (error: unknown) => {
        assert.ok(error instanceof Error && !(error instanceof UnsupportedAudioError))
        assert.match(error.message, /HTTP 404/)
        return true
      })
    } finally {
      restoreAudio()
      restoreFetch()
    }
  })

  it('reports an empty attachment file as an unsupported format', async () => {
    const restoreFetch = replaceGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array())))
    const restoreAudio = stubAudioContext(() => Promise.reject(new Error('never reached')))
    try {
      await assert.rejects(decodeAudioToPcm16k('/_web/sessions/s/attachments/1'), UnsupportedAudioError)
    } finally {
      restoreAudio()
      restoreFetch()
    }
  })
})
