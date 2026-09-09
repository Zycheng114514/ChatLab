/**
 * Request/response transport over a `node:worker_threads` worker.
 *
 * ChatLab pushes model inference off the main thread twice — semantic index
 * embedding and voice transcription — and both need the same three things: a
 * worker that can be booted from TypeScript sources in development, `postMessage`
 * correlated into promises, and a close that lets the worker release its
 * databases and models before the thread is terminated.
 *
 * Everything specific to a feature (what the worker does, what its startup data
 * looks like, where its entry module lives) is supplied by the caller.
 */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'

/** The slice of `node:worker_threads.Worker` this transport uses; fakes implement it in tests. */
export interface WorkerLike {
  postMessage(message: unknown, transferList?: readonly unknown[]): void
  terminate(): Promise<number>
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
}

export interface WorkerThreadTransportOptions<TStartup> {
  /** Human-readable worker name; only used in error messages. */
  label: string
  /** Cloned into the worker as `workerData`. */
  startup: TStartup
  /** Module the worker runs. A `.ts` URL is booted through tsx. */
  workerEntryUrl: string | URL
  workerFactory?: () => WorkerLike
  closeTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const DEFAULT_CLOSE_TIMEOUT_MS = 3_000

type ModuleWorkerOptions = WorkerOptions & { type: 'module' }

function createDefaultWorker<TStartup>(startup: TStartup, entryUrlInput: string | URL): WorkerLike {
  const entryUrl = typeof entryUrlInput === 'string' ? new URL(entryUrlInput) : entryUrlInput
  if (!entryUrl.href.endsWith('.ts')) {
    return new Worker(entryUrl, { workerData: startup }) as WorkerLike
  }

  const bootstrap = `
    import { register } from 'tsx/esm/api';
    register();
    await import(${JSON.stringify(entryUrl.href)});
  `
  const options: ModuleWorkerOptions = {
    eval: true,
    type: 'module',
    workerData: startup,
    execArgv: [],
  }
  return new Worker(bootstrap, options) as WorkerLike
}

export class WorkerThreadTransport<TStartup> {
  private worker: WorkerLike
  private pending = new Map<string, PendingRequest>()
  private requestId = 0
  private readonly label: string
  private readonly closeTimeoutMs: number

  constructor(options: WorkerThreadTransportOptions<TStartup>) {
    this.label = options.label
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.worker = options.workerFactory?.() ?? createDefaultWorker(options.startup, options.workerEntryUrl)

    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.rejectAll(error))
    this.worker.on('exit', (code) => {
      if (code !== 0) this.rejectAll(new Error(`${this.label} exited with code ${code}`))
    })
  }

  /**
   * @param transferList Buffers handed over instead of copied. Anything listed
   *   here is detached in this thread, so pass only buffers the caller owns.
   */
  request<T>(method: string, args: unknown[], transferList?: readonly unknown[]): Promise<T> {
    const id = `req_${++this.requestId}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.worker.postMessage({ id, method, args }, transferList)
    })
  }

  async close(): Promise<void> {
    await this.requestRuntimeClose()
    await this.worker.terminate()
    this.rejectAll(new Error(`${this.label} closed`))
  }

  private async requestRuntimeClose(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.closeTimeoutMs)
    })

    try {
      // 先让 worker 内的 service 正常 close，避免 SQLite/vector 资源被直接中断；超时后仍会 terminate。
      await Promise.race([this.request('__close', []).then(() => undefined), timeoutPromise])
    } catch {
      // Worker may already be gone; terminate below still clears local state.
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private handleMessage(message: unknown): void {
    const payload = message as { id?: string; success?: boolean; result?: unknown; error?: string }
    if (!payload.id) return
    const pending = this.pending.get(payload.id)
    if (!pending) return
    this.pending.delete(payload.id)
    if (payload.success) pending.resolve(payload.result)
    else pending.reject(new Error(payload.error ?? `${this.label} request failed`))
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}

export function createWorkerThreadTransport<TStartup>(
  options: WorkerThreadTransportOptions<TStartup>
): WorkerThreadTransport<TStartup> {
  return new WorkerThreadTransport(options)
}
