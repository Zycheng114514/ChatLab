/**
 * What runs inside the transcription worker thread.
 *
 * Whisper's log-mel feature extraction happens in JavaScript, so running it on
 * the main thread freezes the Electron main process and the CLI Web server for
 * the length of the clip. The model also holds roughly a gigabyte of ONNX
 * tensors, which is why the thread is disposable: the client closes it when idle
 * and this runtime drops the pipeline with it.
 */

import type { SemanticIndexModelDownloadSource } from '../semantic-index/config'
import type { LocalEmbeddingRuntimeConfig } from '../semantic-index/embedding/local-runtime'
import { createLocalEmbeddingRuntimeManager } from '../semantic-index/embedding/local-runtime'
import type { LoadTransformers } from '../semantic-index/embedding/local'
import { createTranscriber, type ResolvedTranscriptionLanguage, type Transcriber } from './service'
import { DEFAULT_TRANSCRIPTION_PROFILE_ID, type TranscriptionProfileId } from './profiles'

export interface TranscriptionWorkerStartupOptions {
  /** Where Whisper weights are cached; see `resolveTranscriptionModelCacheDir`. */
  cacheDir: string
  profile: TranscriptionProfileId
  modelDownloadSource?: SemanticIndexModelDownloadSource
  modelDownloadProxyUrl?: string
  /** CLI only: Transformers.js lives in a managed runtime directory, not in the bundle. */
  localEmbeddingRuntime?: LocalEmbeddingRuntimeConfig
}

export class TranscriptionWorkerRuntime {
  private transcriber: Transcriber | null = null
  private profile: TranscriptionProfileId
  private readonly startup: TranscriptionWorkerStartupOptions
  private readonly loadTransformers: LoadTransformers

  constructor(startup: TranscriptionWorkerStartupOptions) {
    this.startup = startup
    this.profile = startup.profile ?? DEFAULT_TRANSCRIPTION_PROFILE_ID
    const runtimeManager = startup.localEmbeddingRuntime
      ? createLocalEmbeddingRuntimeManager(startup.localEmbeddingRuntime)
      : null
    this.loadTransformers = runtimeManager
      ? () => runtimeManager.loadTransformers()
      : () => import('@huggingface/transformers')
  }

  /** `__close` is the disposal call the thread transport makes before terminating. */
  async handleRequest(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'transcribePcm':
        return await this.transcribePcm(args[0] as Float32Array, args[1] as ResolvedTranscriptionLanguage)
      case 'setProfile':
        return await this.setProfile(args[0] as TranscriptionProfileId)
      case '__close':
        await this.close()
        return null
      default:
        throw new Error(`Unsupported transcription worker method: ${method}`)
    }
  }

  async close(): Promise<void> {
    const transcriber = this.transcriber
    this.transcriber = null
    await transcriber?.dispose()
  }

  /** Switch models; the next request loads (and downloads) the new one. */
  private async setProfile(profile: TranscriptionProfileId): Promise<null> {
    if (profile === this.profile) return null
    this.profile = profile
    await this.close()
    return null
  }

  private async transcribePcm(pcm16k: Float32Array, language: ResolvedTranscriptionLanguage) {
    this.transcriber ??= createTranscriber({
      loadTransformers: this.loadTransformers,
      cacheDir: this.startup.cacheDir,
      modelDownloadSource: this.startup.modelDownloadSource,
      modelDownloadProxyUrl: this.startup.modelDownloadProxyUrl,
      profile: this.profile,
    })
    const { text, durationMs } = await this.transcriber.transcribePcm(pcm16k, { language })
    return { text, durationMs, modelId: this.transcriber.modelId }
  }
}

export function createTranscriptionWorkerRuntime(
  startup: TranscriptionWorkerStartupOptions
): TranscriptionWorkerRuntime {
  return new TranscriptionWorkerRuntime(startup)
}
