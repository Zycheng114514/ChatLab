/**
 * RIFF/WAVE decoder.
 *
 * Whisper needs raw mono PCM, and the Node side has no audio stack, so the few
 * container details we need are parsed here instead of pulling in a dependency:
 * integer PCM (8/16/24/32-bit), 32-bit float, any sample rate, any channel
 * count (averaged down to mono) and `WAVE_FORMAT_EXTENSIBLE`, whose real format
 * lives in the sub-format GUID.
 *
 * Everything else — compressed payloads such as ADPCM, µ-law, MP3-in-WAV —
 * raises {@link UnsupportedAudioFormatError} rather than producing noise.
 */

/** A decoded audio buffer: interleaved channels are already averaged to mono. */
export interface DecodedAudio {
  pcm: Float32Array
  sampleRate: number
}

export type UnsupportedAudioFormatCode = 'not-riff-wave' | 'truncated' | 'unsupported-codec' | 'unsupported-bit-depth'

/** Audio the Node side cannot turn into PCM; the caller reports it instead of guessing. */
export class UnsupportedAudioFormatError extends Error {
  readonly code: UnsupportedAudioFormatCode

  constructor(code: UnsupportedAudioFormatCode, message: string) {
    super(message)
    this.name = 'UnsupportedAudioFormatError'
    this.code = code
  }
}

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_IEEE_FLOAT = 0x0003
const WAVE_FORMAT_EXTENSIBLE = 0xfffe
/** Header bytes before the first chunk: "RIFF" + size + "WAVE". */
const RIFF_HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

interface WavFormat {
  formatTag: number
  channels: number
  sampleRate: number
  bitsPerSample: number
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < RIFF_HEADER_BYTES) {
    throw new UnsupportedAudioFormatError('truncated', 'WAV file is shorter than a RIFF header')
  }
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new UnsupportedAudioFormatError('not-riff-wave', 'File is not a RIFF/WAVE container')
  }

  let format: WavFormat | null = null
  let data: { offset: number; length: number } | null = null

  let offset = RIFF_HEADER_BYTES
  while (offset + CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const id = readTag(view, offset)
    const declaredSize = view.getUint32(offset + 4, true)
    const body = offset + CHUNK_HEADER_BYTES
    // A truncated final chunk still decodes: keep whatever samples are present.
    const size = Math.min(declaredSize, bytes.byteLength - body)

    if (id === 'fmt ') format = readFormatChunk(view, body, size)
    else if (id === 'data') data = { offset: body, length: size }

    // Chunks are word-aligned: an odd body is followed by one padding byte.
    offset = body + size + (size % 2)
  }

  if (!format) throw new UnsupportedAudioFormatError('truncated', 'WAV file has no fmt chunk')
  if (!data) throw new UnsupportedAudioFormatError('truncated', 'WAV file has no data chunk')
  if (format.formatTag !== WAVE_FORMAT_PCM && format.formatTag !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new UnsupportedAudioFormatError(
      'unsupported-codec',
      `WAV format tag 0x${format.formatTag.toString(16)} is not linear PCM`
    )
  }
  if (format.channels < 1 || format.sampleRate < 1) {
    throw new UnsupportedAudioFormatError('truncated', 'WAV fmt chunk declares no channels or no sample rate')
  }

  return {
    pcm: readSamples(view, data.offset, data.length, format),
    sampleRate: format.sampleRate,
  }
}

function readFormatChunk(view: DataView, offset: number, size: number): WavFormat {
  if (size < 16) throw new UnsupportedAudioFormatError('truncated', 'WAV fmt chunk is too short')
  const format: WavFormat = {
    formatTag: view.getUint16(offset, true),
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    bitsPerSample: view.getUint16(offset + 14, true),
  }
  if (format.formatTag !== WAVE_FORMAT_EXTENSIBLE) return format

  // WAVE_FORMAT_EXTENSIBLE keeps the real tag in the first two bytes of the sub-format GUID.
  if (size < 40) throw new UnsupportedAudioFormatError('truncated', 'WAV extensible fmt chunk is too short')
  return { ...format, formatTag: view.getUint16(offset + 24, true) }
}

function readSamples(view: DataView, offset: number, length: number, format: WavFormat): Float32Array {
  const bytesPerSample = format.bitsPerSample / 8
  if (!Number.isInteger(bytesPerSample) || ![1, 2, 3, 4].includes(bytesPerSample)) {
    throw new UnsupportedAudioFormatError(
      'unsupported-bit-depth',
      `WAV bit depth ${format.bitsPerSample} is not supported`
    )
  }
  if (format.formatTag === WAVE_FORMAT_IEEE_FLOAT && bytesPerSample !== 4) {
    throw new UnsupportedAudioFormatError(
      'unsupported-bit-depth',
      `WAV float bit depth ${format.bitsPerSample} is not supported`
    )
  }

  const frameBytes = bytesPerSample * format.channels
  const frames = Math.floor(length / frameBytes)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    const frameOffset = offset + frame * frameBytes
    for (let channel = 0; channel < format.channels; channel++) {
      sum += readSample(view, frameOffset + channel * bytesPerSample, format.formatTag, bytesPerSample)
    }
    mono[frame] = sum / format.channels
  }
  return mono
}

/** One sample, normalized to [-1, 1). 8-bit PCM is unsigned, wider PCM is two's complement. */
function readSample(view: DataView, offset: number, formatTag: number, bytesPerSample: number): number {
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT) return view.getFloat32(offset, true)
  switch (bytesPerSample) {
    case 1:
      return (view.getUint8(offset) - 128) / 128
    case 2:
      return view.getInt16(offset, true) / 32768
    case 3: {
      const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16)
      return raw / 8388608
    }
    default:
      return view.getInt32(offset, true) / 2147483648
  }
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )
}
