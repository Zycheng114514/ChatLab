/**
 * Local voice transcription (Whisper via Transformers.js).
 *
 * Node-side only: audio decoding, resampling, inference and persistence.
 * The browser runtimes decode with Web Audio and reuse the same service.
 */

export { decodeWav, UnsupportedAudioFormatError } from './wav'
export type { DecodedAudio, UnsupportedAudioFormatCode } from './wav'
export { findAudioDecoder, registerAudioDecoder, wavDecoder } from './decoders'
export type { AudioDecoder, AudioDecoderInput } from './decoders'
export { resampleToMono16k, WHISPER_SAMPLE_RATE } from './resample'
export { detectSessionChineseScript, normalizeChineseScript, resolveChineseScript } from './chinese-script'
export type { ChineseScript, ChineseScriptSetting } from './chinese-script'
export {
  DEFAULT_TRANSCRIPTION_PROFILE_ID,
  getTranscriptionProfile,
  TRANSCRIPTION_PROFILE_IDS,
  TRANSCRIPTION_PROFILES,
} from './profiles'
export type { TranscriptionProfile, TranscriptionProfileId } from './profiles'
export {
  createTranscriber,
  planSessionTranscription,
  resolveTranscriptionModelCacheDir,
  transcribeAttachmentPcm,
  TranscribeAttachmentPcmError,
  transcribeSessionAttachments,
  MAX_TRANSCRIPTION_PCM_SAMPLES,
  TRANSCRIPTION_MODEL_CACHE_DIR_ENV,
} from './service'
export type {
  CreateTranscriberOptions,
  ResolvedTranscriptionLanguage,
  TranscribeAttachmentPcmErrorCode,
  TranscribeAttachmentPcmOptions,
  TranscribeAttachmentPcmResult,
  TranscribePcmResult,
  TranscribeSessionAttachmentsOptions,
  TranscribeSessionAttachmentsResult,
  Transcriber,
  TranscriptionCandidate,
  TranscriptionFailure,
  TranscriptionLanguage,
  TranscriptionPlan,
  TranscriptionProgress,
  TranscriptionSkip,
  TranscriptionSkipReason,
} from './service'
export { createTranscriptionWorkerClient, TranscriptionWorkerClient } from './worker-client'
export type {
  TranscribeWorkerPcmOptions,
  TranscribeWorkerPcmResult,
  TranscriptionWorkerClientOptions,
  TranscriptionWorkerTransport,
  TranscriptionWorkerTransportFactory,
} from './worker-client'
export { createTranscriptionWorkerRuntime, TranscriptionWorkerRuntime } from './worker-runtime'
export type { TranscriptionWorkerStartupOptions } from './worker-runtime'
