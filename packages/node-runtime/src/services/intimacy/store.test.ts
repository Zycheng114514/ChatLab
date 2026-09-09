import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import type { IntimacyRun } from '@openchatlab/shared-types'
import { getIntimacyDbPath } from './paths'
import { IntimacyStore, deleteSessionIntimacy, type IntimacyEventRecord } from './store'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')

function makeTempDir(): string {
  const baseDir = process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir())
  return fs.mkdtempSync(path.join(baseDir, 'chatlab-intimacy-store-'))
}

function createRun(overrides: Partial<IntimacyRun> = {}): IntimacyRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    kinds: ['sharing'],
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    targetStartTs: 1_786_200_000,
    targetEndTs: 1_786_300_000,
    sourceSignature: 'signature-v1',
    sourceMessageCount: 40,
    sourceMaxMessageId: 40,
    totalWindows: 2,
    completedWindows: 0,
    currentWindowIndex: 0,
    failedWindowIndexes: [],
    modelId: 'test/model',
    promptVersion: 'intimacy-k1-v1',
    algorithmVersion: 'intimacy-windows-v1',
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    lastError: null,
    createdAt: 1_786_205_000_000,
    updatedAt: 1_786_205_000_000,
    ...overrides,
  }
}

function createEvent(overrides: Partial<IntimacyEventRecord> = {}): IntimacyEventRecord {
  return {
    id: 'sharing:10',
    kind: 'sharing',
    subjectMemberId: 1,
    otherMemberId: 2,
    anchorMessageId: 10,
    anchorTs: 1_786_205_100,
    evidence: [
      { messageId: 10, timestamp: 1_786_205_100, senderId: 1, role: 'core' },
      { messageId: 11, timestamp: 1_786_205_160, senderId: 2, role: 'related' },
    ],
    observation: 'sufficient',
    origin: 'model',
    modelDecision: 'included',
    modelReason: 'The sender describes their own week.',
    details: { kind: 'sharing', categories: ['experience_or_update'], topic: 'work_study', isDistressDisclosure: 'no' },
    createdAt: 1_786_205_200_000,
    ...overrides,
  }
}

test('a window commit stores events with their evidence and merges a sharing continued across windows', () => {
  const store = new IntimacyStore(getIntimacyDbPath(makeTempDir()), { nativeBinding })

  try {
    store.createRun(createRun(), null)
    store.insertWindowEvents('session-1', 'run-1', [createEvent()])
    store.insertWindowEvents('session-1', 'run-1', [
      createEvent({
        evidence: [
          { messageId: 10, timestamp: 1_786_205_100, senderId: 1, role: 'core' },
          { messageId: 24, timestamp: 1_786_205_900, senderId: 1, role: 'core' },
        ],
        modelDecision: 'uncertain',
        details: {
          kind: 'sharing',
          categories: ['experience_or_update', 'feeling'],
          topic: 'work_study',
          isDistressDisclosure: 'no',
        },
      }),
      createEvent({ id: 'sharing:30', anchorMessageId: 30, anchorTs: 1_786_206_000, evidence: [] }),
    ])

    const events = store.listEvents('session-1', 'sharing', 'run-1')
    assert.deepEqual(
      events.map((event) => event.id),
      ['sharing:10', 'sharing:30']
    )
    const merged = events[0]!
    assert.deepEqual(
      merged.evidence.map((evidence) => [evidence.messageId, evidence.role]),
      [
        [10, 'core'],
        [11, 'related'],
        [24, 'core'],
      ]
    )
    assert.deepEqual(merged.details.categories, ['experience_or_update', 'feeling'])
    assert.equal(merged.modelDecision, 'uncertain')
    assert.equal(store.getEvent('session-1', 'sharing:10')?.anchorMessageId, 10)
    assert.equal(store.getEvent('session-1', 'sharing:404'), null)
  } finally {
    store.close()
  }
})

test('a runtime that lost the execution lease cannot append events to the run it no longer owns', () => {
  const store = new IntimacyStore(getIntimacyDbPath(makeTempDir()), { nativeBinding })
  const now = 1_786_205_000_000

  try {
    store.createRun(createRun(), null)
    assert.equal(store.tryAcquireExecutionLease('run-1', 'runtime-b', now, now + 30_000), true)
    assert.throws(
      () => store.insertWindowEvents('session-1', 'run-1', [createEvent()], { ownerId: 'runtime-a', now }),
      (error: unknown) => (error as { code?: string }).code === 'INTIMACY_EXECUTION_LEASE_LOST'
    )
    assert.deepEqual(store.listEvents('session-1', 'sharing', 'run-1'), [])

    store.insertWindowEvents('session-1', 'run-1', [createEvent()], { ownerId: 'runtime-b', now })
    assert.equal(store.listEvents('session-1', 'sharing', 'run-1').length, 1)
  } finally {
    store.close()
  }
})

test('reviews use optimistic revisions so a stale client cannot overwrite a newer decision', () => {
  const store = new IntimacyStore(getIntimacyDbPath(makeTempDir()), { nativeBinding })

  try {
    store.createRun(createRun(), null)
    store.insertWindowEvents('session-1', 'run-1', [createEvent()])

    const first = store.upsertReview('session-1', 'sharing:10', 'excluded', null, 0, 1_786_205_300_000)
    assert.equal(first?.revision, 1)
    assert.equal(store.upsertReview('session-1', 'sharing:10', 'included', null, 0, 1_786_205_400_000), null)

    const second = store.upsertReview(
      'session-1',
      'sharing:10',
      'included',
      JSON.stringify({ topic: 'health' }),
      1,
      1_786_205_500_000
    )
    assert.equal(second?.revision, 2)
    assert.deepEqual(store.listReviews('session-1'), [
      {
        eventId: 'sharing:10',
        decision: 'included',
        details: { topic: 'health' },
        revision: 2,
        updatedAt: 1_786_205_500_000,
      },
    ])
  } finally {
    store.close()
  }
})

test('a rerun keeps user reviews while superseded runs and their events are pruned', () => {
  const store = new IntimacyStore(getIntimacyDbPath(makeTempDir()), { nativeBinding })

  try {
    store.createRun(createRun({ status: 'completed', completedWindows: 2 }), null)
    store.insertWindowEvents('session-1', 'run-1', [createEvent()])
    store.upsertReview('session-1', 'sharing:10', 'excluded', null, 0, 1_786_205_300_000)
    store.createUserEvent(
      'session-1',
      createEvent({ id: 'sharing:80', anchorMessageId: 80, anchorTs: 1_786_206_500, origin: 'user' })
    )

    store.createRun(
      createRun({ id: 'run-2', status: 'completed', completedWindows: 2, createdAt: 1_786_206_000_000 }),
      null
    )
    store.insertWindowEvents('session-1', 'run-2', [createEvent()])
    assert.equal(store.pruneRuns('session-1', 'run-2'), 1)

    assert.equal(store.getRun('run-1'), null)
    assert.equal(store.getLatestRun('session-1')?.id, 'run-2')
    assert.equal(store.getLatestRunWithResults('session-1')?.id, 'run-2')
    assert.deepEqual(
      store.listEvents('session-1', 'sharing', 'run-2').map((event) => event.id),
      ['sharing:10']
    )
    assert.deepEqual(
      store.listEvents('session-1', 'sharing', '').map((event) => event.id),
      ['sharing:80']
    )
    assert.deepEqual(
      store.listReviews('session-1').map((review) => [review.eventId, review.decision]),
      [
        ['sharing:10', 'excluded'],
        ['sharing:80', 'included'],
      ]
    )
  } finally {
    store.close()
  }
})

test('clearing results can keep user reviews, and deleting a session removes every derived row', () => {
  const root = makeTempDir()
  const dbPath = getIntimacyDbPath(root)
  const store = new IntimacyStore(dbPath, { nativeBinding })

  try {
    store.createRun(createRun({ status: 'completed', completedWindows: 2 }), null)
    store.insertWindowEvents('session-1', 'run-1', [createEvent()])
    store.upsertReview('session-1', 'sharing:10', 'excluded', null, 0, 1_786_205_300_000)
    store.createRun(createRun({ id: 'run-9', sessionId: 'session-2', status: 'completed', completedWindows: 1 }), null)
    store.insertWindowEvents('session-2', 'run-9', [createEvent()])

    assert.equal(store.deleteSessionResults('session-1', { includeReviews: false }), true)
    assert.equal(store.getLatestRun('session-1'), null)
    assert.deepEqual(store.listEvents('session-1', 'sharing', 'run-1'), [])
    assert.equal(store.listReviews('session-1').length, 1)
  } finally {
    store.close()
  }

  assert.equal(deleteSessionIntimacy(root, 'session-1', { nativeBinding }), true)

  const reopened = new IntimacyStore(dbPath, { nativeBinding })
  try {
    assert.equal(reopened.listReviews('session-1').length, 0)
    assert.equal(reopened.getRun('run-9')?.sessionId, 'session-2')
    assert.deepEqual(
      reopened.listEvents('session-2', 'sharing', 'run-9').map((event) => event.id),
      ['sharing:10']
    )
  } finally {
    reopened.close()
  }

  const raw = new Database(dbPath, { nativeBinding })
  try {
    assert.equal(raw.prepare("SELECT COUNT(*) FROM intimacy_evidence WHERE session_id = 'session-1'").pluck().get(), 0)
    assert.equal(raw.prepare("SELECT COUNT(*) FROM intimacy_evidence WHERE session_id = 'session-2'").pluck().get(), 2)
  } finally {
    raw.close()
  }
})

test('execution leases keep one live run and recover it after the lease expires', () => {
  const store = new IntimacyStore(getIntimacyDbPath(makeTempDir()), { nativeBinding })
  const now = 1_786_205_000_000

  try {
    const run = createRun({ updatedAt: now })
    store.createRun(run, null)
    assert.equal(store.tryAcquireExecutionLease(run.id, 'runtime-a', now, now + 30_000), true)
    assert.equal(store.tryAcquireExecutionLease(run.id, 'runtime-b', now + 1, now + 30_001), false)
    assert.equal(store.hasLiveExecutionForSession('session-1', now + 10_000), true)
    assert.equal(store.recoverInterruptedRuns(now + 10_000), 0)
    assert.equal(store.getRun(run.id)?.status, 'running')
    assert.equal(
      store.updateRunIfOwned({ ...run, completedWindows: 1 }, { ownerId: 'runtime-b', now: now + 10_000 }),
      false
    )
    assert.equal(
      store.updateRunIfOwned(
        { ...run, completedWindows: 1, failedWindowIndexes: [3] },
        { ownerId: 'runtime-a', now: now + 10_000 }
      ),
      true
    )
    assert.equal(store.getRun(run.id)?.completedWindows, 1)
    assert.deepEqual(store.getRun(run.id)?.failedWindowIndexes, [3])

    assert.equal(store.recoverInterruptedRuns(now + 30_001), 1)
    assert.equal(store.getRun(run.id)?.status, 'paused')
    assert.equal(store.hasLiveExecutionForSession('session-1', now + 30_001), false)
    assert.equal(store.tryAcquireExecutionLease(run.id, 'runtime-b', now + 30_001, now + 60_001), true)
  } finally {
    store.close()
  }
})

test('a store written by a newer schema is rejected instead of silently reinterpreted', () => {
  const dbPath = getIntimacyDbPath(makeTempDir())
  const initial = new IntimacyStore(dbPath, { nativeBinding })
  initial.createRun(createRun({ status: 'completed', completedWindows: 1 }), null)
  initial.close()

  const raw = new Database(dbPath, { nativeBinding })
  raw.exec("UPDATE intimacy_meta SET value = '2' WHERE key = 'schema_version'")
  raw.close()

  assert.throws(() => new IntimacyStore(dbPath, { nativeBinding }), /Unsupported intimacy schema version/)
})
