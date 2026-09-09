import { parentPort, workerData } from 'node:worker_threads'
import type { TranscriptionWorkerStartupOptions } from './worker-runtime'

const startup = workerData as TranscriptionWorkerStartupOptions

async function main(): Promise<void> {
  const { createTranscriptionWorkerRuntime } =
    (await import('./worker-runtime.js')) as typeof import('./worker-runtime')
  const runtime = createTranscriptionWorkerRuntime(startup)

  parentPort?.on('message', async (message) => {
    const payload = message as { id: string; method: string; args?: unknown[] }
    try {
      const result = await runtime.handleRequest(payload.method, payload.args ?? [])
      parentPort?.postMessage({ id: payload.id, success: true, result })
    } catch (error) {
      parentPort?.postMessage({
        id: payload.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

void main().catch((error) => {
  console.error('[transcription] worker failed to start:', error instanceof Error ? error.message : String(error))
  throw error
})
