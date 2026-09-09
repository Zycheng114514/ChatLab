/**
 * Audio decoder registry.
 *
 * The Node side only ships a WAV decoder: the desktop renderer and CLI Web page
 * already decode mp3 / m4a / ogg through Web Audio, so a headless run is the
 * only place that needs its own decoder. Formats no browser handles — WeChat
 * SILK, AMR — plug in here instead of forking the transcription service:
 *
 *   registerAudioDecoder({
 *     id: 'silk',
 *     canDecode: ({ fileName }) => fileName.toLowerCase().endsWith('.silk'),
 *     decode: async (bytes) => ({ pcm, sampleRate }),
 *   })
 *
 * `findAudioDecoder` picks the last registered decoder that accepts the input,
 * so a later registration overrides the built-in one for the same extension.
 */

import { decodeWav, type DecodedAudio } from './wav'

/** What the registry knows about a file before any bytes are read. */
export interface AudioDecoderInput {
  fileName: string
  mimeType?: string
}

export interface AudioDecoder {
  /** Stable identifier, logged when a file is decoded. */
  id: string
  canDecode(input: AudioDecoderInput): boolean
  decode(bytes: Uint8Array): Promise<DecodedAudio>
}

export const wavDecoder: AudioDecoder = {
  id: 'wav',
  canDecode: ({ fileName, mimeType }) =>
    fileName.toLowerCase().endsWith('.wav') || mimeType === 'audio/wav' || mimeType === 'audio/x-wav',
  decode: async (bytes) => decodeWav(bytes),
}

const decoders: AudioDecoder[] = [wavDecoder]

export function registerAudioDecoder(decoder: AudioDecoder): void {
  decoders.push(decoder)
}

/** The decoder that accepts this file, or null when the Node side cannot read it. */
export function findAudioDecoder(input: AudioDecoderInput): AudioDecoder | null {
  for (let i = decoders.length - 1; i >= 0; i--) {
    if (decoders[i].canDecode(input)) return decoders[i]
  }
  return null
}
