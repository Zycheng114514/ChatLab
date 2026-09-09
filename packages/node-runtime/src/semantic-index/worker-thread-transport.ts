import { createWorkerThreadTransport, type WorkerLike, type WorkerThreadTransport } from '../worker/thread-transport'
import type { SemanticIndexWorkerTransport } from './worker-client'
import type { SemanticIndexWorkerStartupOptions } from './worker-runtime'

export type SemanticIndexWorkerLike = WorkerLike

export interface SemanticIndexWorkerThreadTransportOptions {
  startup: SemanticIndexWorkerStartupOptions
  workerFactory?: () => SemanticIndexWorkerLike
  workerEntryUrl?: string | URL
  closeTimeoutMs?: number
}

function defaultWorkerEntryUrl(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('./worker-thread-entry.ts', import.meta.url)
    : new URL('./worker-thread-entry.js', import.meta.url)
}

export function createSemanticIndexWorkerThreadTransport(
  options: SemanticIndexWorkerThreadTransportOptions
): SemanticIndexWorkerTransport & WorkerThreadTransport<SemanticIndexWorkerStartupOptions> {
  return createWorkerThreadTransport({
    label: 'Semantic index worker',
    startup: options.startup,
    workerEntryUrl: options.workerEntryUrl ?? defaultWorkerEntryUrl(),
    workerFactory: options.workerFactory,
    closeTimeoutMs: options.closeTimeoutMs,
  })
}
