/**
 * Transcription worker client.
 *
 * Guards three things the user would notice: a transcription in flight is never
 * killed by the idle timer (the click would fail after a minute of waiting), the
 * caller's audio samples survive being sent to the worker (a second attachment
 * in the same batch would otherwise transcribe as silence), and switching the
 * model size in settings actually reaches the worker instead of silently
 * transcribing with the previous model.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranscriptionWorkerClient, type TranscriptionWorkerTransport } from './worker-client'
import type { TranscriptionWorkerStartupOptions } from './worker-runtime'

class FakeTransport implements TranscriptionWorkerTransport {
  requests: Array<{ method: string; args: unknown[]; transferList?: readonly unknown[] }> = []
  closed = false
  /** Set to hold the next transcribePcm open until the test resolves it. */
  gate: { resolve: () => void; promise: Promise<void> } | null = null

  constructor(readonly startup: TranscriptionWorkerStartupOptions) {}

  async request<T>(method: string, args: unknown[], transferList?: readonly unknown[]): Promise<T> {
    this.requests.push({ method, args, transferList })
    if (method === 'transcribePcm') {
      if (this.gate) await this.gate.promise
      const pcm = args[0] as Float32Array
      return { text: `frames:${pcm.length}`, durationMs: 1, modelId: 'fake/whisper' } as T
    }
    return null as T
  }

  close(): void {
    this.closed = true
  }
}

/** Timer queue the test drives by hand, so idle behaviour is deterministic. */
function makeTimers() {
  const scheduled: Array<{ id: number; callback: () => void } | null> = []
  return {
    scheduledCount: () => scheduled.filter((entry) => entry !== null).length,
    fireAll: () => {
      for (const entry of [...scheduled]) {
        if (entry) entry.callback()
      }
    },
    timers: {
      setTimeout(callback: () => void): unknown {
        const id = scheduled.length
        scheduled.push({ id, callback })
        return id
      },
      clearTimeout(timer: unknown): void {
        scheduled[timer as number] = null
      },
    },
  }
}

function makeClient(options?: { profile?: 'tiny' | 'base' | 'small' }) {
  const transports: FakeTransport[] = []
  const { timers, scheduledCount, fireAll } = makeTimers()
  const client = createTranscriptionWorkerClient({
    aiDataDir: '/tmp/chatlab-ai',
    profile: options?.profile,
    idleCloseMs: 1000,
    timers,
    transportFactory: (startup) => {
      const transport = new FakeTransport(startup)
      transports.push(transport)
      return transport
    },
  })
  return { client, transports, scheduledCount, fireAll }
}

test('the idle timer never closes a worker with a request in flight', async () => {
  const { client, transports, scheduledCount, fireAll } = makeClient()
  let release!: () => void
  const gate = { promise: new Promise<void>((resolve) => (release = resolve)), resolve: () => release() }

  const pending = client.transcribePcm(new Float32Array(16), { language: 'en' })
  transports[0].gate = gate
  // A second call is what actually exercises the guard: the first one's `finally`
  // must not arm an idle close while this one is still waiting on the worker.
  const gated = client.transcribePcm(new Float32Array(16), { language: 'en' })
  await pending

  fireAll()
  assert.equal(transports[0].closed, false, 'idle close fired while a request was still running')

  gate.resolve()
  await gated
  assert.equal(scheduledCount(), 1)
  fireAll()
  await Promise.resolve()
  assert.equal(transports[0].closed, true)

  // The next request starts a fresh worker rather than reusing the closed one.
  await client.transcribePcm(new Float32Array(8), { language: 'en' })
  assert.equal(transports.length, 2)
  await client.close()
})

test('the caller keeps its samples after they are sent to the worker', async () => {
  const { client, transports } = makeClient()
  const pcm = Float32Array.from([0.25, -0.5, 0.75, 1])

  const result = await client.transcribePcm(pcm, { language: 'zh' })

  assert.equal(result.text, 'frames:4')
  assert.deepEqual([...pcm], [0.25, -0.5, 0.75, 1], 'the caller-owned buffer was detached by the transfer list')
  const sent = transports[0].requests[0]
  assert.notEqual(sent.args[0], pcm)
  assert.deepEqual([...(sent.args[0] as Float32Array)], [0.25, -0.5, 0.75, 1])
  // Still transferred rather than structured-cloned a second time.
  assert.equal(sent.transferList?.length, 1)
  assert.equal(sent.transferList?.[0], (sent.args[0] as Float32Array).buffer)
  await client.close()
})

test('a changed model profile reaches the worker before the next transcription', async () => {
  const { client, transports } = makeClient({ profile: 'base' })

  await client.transcribePcm(new Float32Array(4), { language: 'en' })
  await client.transcribePcm(new Float32Array(4), { language: 'en', profile: 'small' })
  await client.transcribePcm(new Float32Array(4), { language: 'en', profile: 'small' })

  assert.equal(transports.length, 1, 'switching profiles should not restart the thread')
  assert.deepEqual(
    transports[0].requests.map((request) => request.method),
    ['transcribePcm', 'setProfile', 'transcribePcm', 'transcribePcm']
  )
  assert.deepEqual(transports[0].requests[1].args, ['small'])
  assert.equal(transports[0].startup.profile, 'base')
  await client.close()
})

test('the first request decides the profile the thread starts with', async () => {
  const { client, transports } = makeClient({ profile: 'base' })

  await client.transcribePcm(new Float32Array(4), { language: 'en', profile: 'tiny' })

  assert.equal(transports[0].startup.profile, 'tiny')
  assert.deepEqual(
    transports[0].requests.map((request) => request.method),
    ['transcribePcm']
  )
  await client.close()
})
