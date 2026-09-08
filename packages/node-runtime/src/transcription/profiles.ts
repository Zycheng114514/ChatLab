/**
 * Whisper model profiles (static definitions, single source of truth).
 *
 * All three are the ONNX community exports of OpenAI Whisper, quantized to q8:
 * fp32 triples the download and gains nothing on a laptop CPU. `base` is the
 * default — `tiny` drops too much Chinese, `small` is roughly 3x the runtime.
 */

export type TranscriptionProfileId = 'tiny' | 'base' | 'small'

export interface TranscriptionProfile {
  id: TranscriptionProfileId
  modelId: string
  dtype: 'q8'
}

export const TRANSCRIPTION_PROFILES: Record<TranscriptionProfileId, TranscriptionProfile> = {
  tiny: { id: 'tiny', modelId: 'onnx-community/whisper-tiny', dtype: 'q8' },
  base: { id: 'base', modelId: 'onnx-community/whisper-base', dtype: 'q8' },
  small: { id: 'small', modelId: 'onnx-community/whisper-small', dtype: 'q8' },
}

export const DEFAULT_TRANSCRIPTION_PROFILE_ID: TranscriptionProfileId = 'base'

export const TRANSCRIPTION_PROFILE_IDS = Object.keys(TRANSCRIPTION_PROFILES) as TranscriptionProfileId[]

export function getTranscriptionProfile(id: string): TranscriptionProfile | null {
  return TRANSCRIPTION_PROFILES[id as TranscriptionProfileId] ?? null
}
