/**
 * Main-thread handle on the transcription worker.
 *
 * The thread is started by the first request, not at boot: most sessions have no
 * voice messages and nobody should pay a gigabyte of resident memory for a model
 * they never use. It is closed again after a few idle minutes, but never while a
 * request is in flight.
 */

import { appLogger } from '../logging/app-logger'
import type { SemanticIndexModelDownloadSource } from '../semantic-index/config'
import type { LocalEmbeddingRuntimeConfig } from '../semantic-index/embedding/local-runtime'
import { createWorkerThreadTransport } from '../worker/thread-transport'
import { DEFAULT_TRANSCRIPTION_PROFILE_ID, type TranscriptionProfileId } from './profiles'
import { resolveTranscriptionModelCacheDir, type ResolvedTranscriptionLanguage } from './service'
import type { TranscriptionWorkerStartupOptions } from './worker-runtime'

const LOG_SCOPE = 'transcription'
const DEFAULT_IDLE_CLOSE_MS = 5 * 60 * 1000

export interface TranscriptionWorkerTransport {
  request<T>(method: string, args: unknown[], transferList?: readonly unknown[]): Promise<T>
  close(): void | Promise<void>
}

export type TranscriptionWorkerTransportFactory = (
  startup: TranscriptionWorkerStartupOptions
) => TranscriptionWorkerTransport

interface WorkerClientTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export interface TranscriptionWorkerClientOptions {
  /** Model weights are cached under this directory, next to the semantic index's. */
  aiDataDir: string
  localEmbeddingRuntime?: LocalEmbeddingRuntimeConfig
  downloadSource?: SemanticIndexModelDownloadSource
  proxyUrl?: string
  profile?: TranscriptionProfileId
  idleCloseMs?: number
  workerEntryUrl?: string | URL
  /** Injected by tests; production uses the worker thread transport. */
  transportFactory?: TranscriptionWorkerTransportFactory
  timers?: WorkerClientTimers
}

export interface TranscribeWorkerPcmOptions {
  language: ResolvedTranscriptionLanguage
  /** Whisper size to use; a change from the last call reloads the model in the worker. */
  profile?: TranscriptionProfileId
}

export interface TranscribeWorkerPcmResult {
  text: string
  durationMs: number
  modelId: string
}

const defaultTimers: WorkerClientTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export class TranscriptionWorkerClient {
  private transport: TranscriptionWorkerTransport | null = null
  private pendingRequests = 0
  private idleTimer: unknown = null
  private activeProfile: TranscriptionProfileId
  private readonly defaultProfile: TranscriptionProfileId
  private readonly startup: Omit<TranscriptionWorkerStartupOptions, 'profile'>
  private readonly transportFactory: TranscriptionWorkerTransportFactory
  private readonly idleCloseMs: number
  private readonly timers: WorkerClientTimers

  constructor(options: TranscriptionWorkerClientOptions) {
    this.defaultProfile = options.profile ?? DEFAULT_TRANSCRIPTION_PROFILE_ID
    this.activeProfile = this.defaultProfile
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
    this.timers = options.timers ?? defaultTimers
    this.startup = {
      cacheDir: resolveTranscriptionModelCacheDir(options.aiDataDir),
      modelDownloadSource: options.downloadSource,
      modelDownloadProxyUrl: options.proxyUrl,
      localEmbeddingRuntime: options.localEmbeddingRuntime,
    }
    this.transportFactory = options.transportFactory ?? defaultTransportFactory(options.workerEntryUrl)
  }

  async transcribePcm(pcm16k: Float32Array, options: TranscribeWorkerPcmOptions): Promise<TranscribeWorkerPcmResult> {
    const profile = options.profile ?? this.defaultProfile
    const transport = this.ensureTransport(profile)
    this.pendingRequests++
    this.clearIdleTimer()
    try {
      if (profile !== this.activeProfile) {
        await transport.request('setProfile', [profile])
        this.activeProfile = profile
      }
      // postMessage clones the samples in any case; hand over a private copy
      // through the transfer list so the caller's buffer is never detached and
      // no more than one copy of a long clip exists at a time.
      const payload = new Float32Array(pcm16k)
      return await transport.request<TranscribeWorkerPcmResult>(
        'transcribePcm',
        [payload, options.language],
        [payload.buffer]
      )
    } catch (error) {
      appLogger.error(LOG_SCOPE, 'Transcription worker request failed', error)
      throw error
    } finally {
      this.pendingRequests--
      this.scheduleIdleCloseIfNeeded()
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer()
    await this.closeTransport()
  }

  private ensureTransport(profile: TranscriptionProfileId): TranscriptionWorkerTransport {
    if (!this.transport) {
      this.transport = this.transportFactory({ ...this.startup, profile })
      this.activeProfile = profile
      appLogger.info(LOG_SCOPE, 'Transcription worker started', { profile })
    }
    return this.transport
  }

  private scheduleIdleCloseIfNeeded(): void {
    if (!this.transport || this.pendingRequests > 0) return
    this.clearIdleTimer()
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null
      void this.closeTransport().catch((error) => {
        appLogger.warn(LOG_SCOPE, 'Idle transcription worker close failed', error)
      })
    }, this.idleCloseMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      this.timers.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport
    this.transport = null
    this.activeProfile = this.defaultProfile
    if (!transport) return
    await transport.close()
    appLogger.info(LOG_SCOPE, 'Transcription worker stopped')
  }
}

function defaultTransportFactory(workerEntryUrl?: string | URL): TranscriptionWorkerTransportFactory {
  const entryUrl =
    workerEntryUrl ??
    (import.meta.url.endsWith('.ts')
      ? new URL('./worker-thread-entry.ts', import.meta.url)
      : new URL('./worker-thread-entry.js', import.meta.url))
  return (startup) => createWorkerThreadTransport({ label: 'Transcription worker', startup, workerEntryUrl: entryUrl })
}

export function createTranscriptionWorkerClient(options: TranscriptionWorkerClientOptions): TranscriptionWorkerClient {
  return new TranscriptionWorkerClient(options)
}
