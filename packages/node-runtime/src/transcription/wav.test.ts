import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWav, UnsupportedAudioFormatError } from './wav'

interface WavOptions {
  /** One array per channel, values in [-1, 1). */
  channels: number[][]
  sampleRate: number
  bitsPerSample: 8 | 16 | 24 | 32
  float?: boolean
  extensible?: boolean
  /** Insert an odd-length chunk before `data` to exercise word alignment. */
  oddChunkBefore?: boolean
}

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_IEEE_FLOAT = 0x0003
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

function encodeWav(options: WavOptions): Uint8Array {
  const { channels, sampleRate, bitsPerSample, float = false, extensible = false, oddChunkBefore = false } = options
  const channelCount = channels.length
  const frames = channels[0].length
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = bytesPerSample * channelCount
  const formatTag = float ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM

  const fmtSize = extensible ? 40 : 16
  const extraChunk = oddChunkBefore ? { id: 'LIST', body: new Uint8Array([1, 2, 3]) } : null
  const extraBytes = extraChunk ? 8 + extraChunk.body.length + (extraChunk.body.length % 2) : 0
  const dataSize = frames * blockAlign
  const total = 12 + 8 + fmtSize + extraBytes + 8 + dataSize

  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  let offset = 0
  const writeTag = (tag: string) => {
    for (const char of tag) view.setUint8(offset++, char.charCodeAt(0))
  }

  writeTag('RIFF')
  view.setUint32(offset, total - 8, true)
  offset += 4
  writeTag('WAVE')

  writeTag('fmt ')
  view.setUint32(offset, fmtSize, true)
  offset += 4
  view.setUint16(offset, extensible ? WAVE_FORMAT_EXTENSIBLE : formatTag, true)
  offset += 2
  view.setUint16(offset, channelCount, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true)
  offset += 4
  view.setUint16(offset, blockAlign, true)
  offset += 2
  view.setUint16(offset, bitsPerSample, true)
  offset += 2
  if (extensible) {
    view.setUint16(offset, 22, true) // cbSize
    view.setUint16(offset + 2, bitsPerSample, true) // valid bits
    view.setUint32(offset + 4, 0, true) // channel mask
    view.setUint16(offset + 8, formatTag, true) // sub-format GUID: real tag first
    offset += 24
  }

  if (extraChunk) {
    writeTag(extraChunk.id)
    view.setUint32(offset, extraChunk.body.length, true)
    offset += 4
    bytes.set(extraChunk.body, offset)
    offset += extraChunk.body.length + (extraChunk.body.length % 2)
  }

  writeTag('data')
  view.setUint32(offset, dataSize, true)
  offset += 4
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      writeSample(view, offset, channels[channel][frame], bitsPerSample, float)
      offset += bytesPerSample
    }
  }
  return bytes
}

function writeSample(view: DataView, offset: number, value: number, bitsPerSample: number, float: boolean): void {
  if (float) {
    view.setFloat32(offset, value, true)
    return
  }
  switch (bitsPerSample) {
    case 8:
      view.setUint8(offset, Math.round(value * 128) + 128)
      return
    case 16:
      view.setInt16(offset, Math.round(value * 32768), true)
      return
    case 24: {
      const raw = Math.round(value * 8388608)
      view.setUint8(offset, raw & 0xff)
      view.setUint8(offset + 1, (raw >> 8) & 0xff)
      view.setUint8(offset + 2, (raw >> 16) & 0xff)
      return
    }
    default:
      view.setInt32(offset, Math.round(value * 2147483648), true)
  }
}

/** Chosen so every sample round-trips exactly at 8, 16, 24 and 32 bits. */
const MONO = [-0.5, 0, 0.25, 0.75]

test('WAV variants decode to the same mono PCM', () => {
  const cases: Array<{ name: string; wav: Uint8Array; sampleRate: number; expected: number[] }> = [
    {
      name: '16-bit mono',
      wav: encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 16 }),
      sampleRate: 16000,
      expected: MONO,
    },
    {
      name: '16-bit stereo averages the channels',
      wav: encodeWav({
        // +1.0 is not representable in signed 16-bit PCM, so the fixture stays inside [-0.75, 0.75].
        channels: [
          [0.5, 0.25, -0.75, 0],
          [-0.5, 0.25, 0.75, 0.5],
        ],
        sampleRate: 44100,
        bitsPerSample: 16,
      }),
      sampleRate: 44100,
      expected: [0, 0.25, 0, 0.25],
    },
    {
      name: '8-bit mono is unsigned',
      wav: encodeWav({ channels: [MONO], sampleRate: 8000, bitsPerSample: 8 }),
      sampleRate: 8000,
      expected: MONO,
    },
    {
      name: '24-bit mono',
      wav: encodeWav({ channels: [MONO], sampleRate: 48000, bitsPerSample: 24 }),
      sampleRate: 48000,
      expected: MONO,
    },
    {
      name: '32-bit integer mono',
      wav: encodeWav({ channels: [MONO], sampleRate: 22050, bitsPerSample: 32 }),
      sampleRate: 22050,
      expected: MONO,
    },
    {
      name: '32-bit float mono',
      wav: encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 32, float: true }),
      sampleRate: 16000,
      expected: MONO,
    },
    {
      name: 'WAVE_FORMAT_EXTENSIBLE reads the sub-format tag',
      wav: encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 16, extensible: true }),
      sampleRate: 16000,
      expected: MONO,
    },
    {
      name: 'odd-length chunks stay word aligned',
      wav: encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 16, oddChunkBefore: true }),
      sampleRate: 16000,
      expected: MONO,
    },
  ]

  for (const { name, wav, sampleRate, expected } of cases) {
    const decoded = decodeWav(wav)
    assert.equal(decoded.sampleRate, sampleRate, name)
    assert.deepEqual(Array.from(decoded.pcm), expected, name)
  }
})

test('unsupported and malformed containers report a code instead of noise', () => {
  const validWav = encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 16 })

  const notRiff = new Uint8Array(validWav)
  notRiff.set([0x4f, 0x67, 0x67, 0x53], 0) // "OggS"

  // µ-law payload: a real codec the Node side cannot decode.
  const muLaw = new Uint8Array(validWav)
  new DataView(muLaw.buffer).setUint16(20, 0x0007, true)

  const cases: Array<[string, Uint8Array, string]> = [
    ['not a RIFF/WAVE file', notRiff, 'not-riff-wave'],
    ['header shorter than RIFF', validWav.slice(0, 8), 'truncated'],
    ['no data chunk', validWav.slice(0, 36), 'truncated'],
    ['compressed codec', muLaw, 'unsupported-codec'],
  ]

  for (const [name, bytes, code] of cases) {
    assert.throws(
      () => decodeWav(bytes),
      (error: unknown) => error instanceof UnsupportedAudioFormatError && error.code === code,
      name
    )
  }
})

test('a truncated data chunk keeps the frames that are present', () => {
  const wav = encodeWav({ channels: [MONO], sampleRate: 16000, bitsPerSample: 16 })
  // Drop the last two frames; the data chunk header still claims all four.
  const decoded = decodeWav(wav.slice(0, wav.length - 4))
  assert.deepEqual(Array.from(decoded.pcm), MONO.slice(0, 2))
})
