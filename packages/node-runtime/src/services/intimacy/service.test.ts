import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type PathProvider } from '@openchatlab/core'
import { assertDataDirCompatible, DataDirCompatibilityError, readDataDirCompatibilityMeta } from '../../data-dir-compat'
import { DatabaseManager } from '../../database-manager'
import { createDatabaseManagerAdapter } from '../adapters'
import type { ChatTopicModelClient } from '../topics/model-client'
import { createIntimacyService, type IntimacyService } from './service'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = Date.parse('2026-05-01T08:00:00.000Z') / 1000
const baseNow = Date.parse('2026-05-02T08:00:00.000Z')
const MESSAGE_COUNT = 48

/** Ids of the hand-written messages inside the generated filler; senders alternate by parity. */
const ALICE_FIRST_SHARING = 5
const ALICE_CONTINUED_SHARING = 17
const BOB_RELAYED_THIRD_PARTY = 12
const BOB_OWN_SHARING = 30
const BOB_PHONE_NUMBER = '13800001111'

/** UTC-10 all year, so a message sent at 08:30 UTC belongs to the previous local calendar day. */
const RUN_TIMEZONE = 'Pacific/Honolulu'
const PHONE_RULE = {
  id: 'phone',
  label: 'Phone number',
  pattern: '\\d{11}',
  replacement: '[phone]',
  enabled: true,
  builtin: false,
}

function makeTempDir(): string {
  const baseDir = process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir())
  return fs.mkdtempSync(path.join(baseDir, 'chatlab-intimacy-service-'))
}

function createPathProvider(root: string): PathProvider {
  return {
    getSystemDir: () => root,
    getUserDataDir: () => path.join(root, 'data'),
    getDatabaseDir: () => path.join(root, 'data', 'databases'),
    getVectorDir: () => path.join(root, 'data', 'vector'),
    getAiDataDir: () => path.join(root, 'ai'),
    getSettingsDir: () => path.join(root, 'settings'),
    getCacheDir: () => path.join(root, 'cache'),
    getTempDir: () => path.join(root, 'temp'),
    getLogsDir: () => path.join(root, 'logs'),
    getDownloadsDir: () => path.join(root, 'downloads'),
  }
}

/**
 * A synthetic two-person chat: long filler turns so the range needs several windows, plus a few written
 * messages covering a sharing continued later, a relayed third party, both sides sharing, and a voice message.
 */
function createSession(root: string, chatType: 'private' | 'group' = 'private'): void {
  const dbDir = path.join(root, 'data', 'databases')
  fs.mkdirSync(dbDir, { recursive: true })
  const db = new Database(path.join(dbDir, `${chatType}.db`), { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare(
    `INSERT INTO meta (name, platform, type, imported_at, owner_id, schema_version) VALUES (?, 'wechat', ?, ?, 'alice', 10)`
  ).run(chatType === 'private' ? 'Alice & Bob' : 'Team', chatType, baseTs)
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (2, 'bob', 'Bob')").run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (3, 'system', '系统消息')").run()

  const written = new Map<number, { type: number; content: string | null }>([
    [ALICE_FIRST_SHARING, { type: 0, content: '这周项目终于上线了，我连着加了三天班，现在整个人是空的' }],
    [BOB_RELAYED_THIRD_PARTY, { type: 0, content: '她说她很难过，我不知道该怎么接这句话' }],
    [ALICE_CONTINUED_SHARING, { type: 0, content: 'The launch is finally out, and I am mostly relieved now.' }],
    [23, { type: 2, content: null }],
    [
      BOB_OWN_SHARING,
      { type: 0, content: `我最近体检结果有点问题，说实话有点担心，医院让我打 ${BOB_PHONE_NUMBER} 约复查` },
    ],
  ])
  const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let id = 1; id <= MESSAGE_COUNT; id += 1) {
      const custom = written.get(id)
      insert.run(
        id,
        id % 2 === 1 ? 1 : 2,
        baseTs + id * 60,
        custom?.type ?? 0,
        custom ? custom.content : `${'闲聊 filler '.repeat(40)}${id}`
      )
    }
    insert.run(MESSAGE_COUNT + 1, 3, baseTs + 10, 80, '对方撤回了一条消息')
  })()
  db.close()
}

interface PromptMessage {
  id: number
  t: string
  from: 'A' | 'B'
  type: string
  text: string
  context: boolean
}

interface PromptWindow {
  index: number
  total: number
  messages: PromptMessage[]
}

const MESSAGE_LINE = /^(\d+) ([AB]) (\d\d:\d\d) (.*)$/
const DATE_LINE = /^\[(\d{4}-\d\d-\d\d)\]$/

/**
 * Read the message lines of a prompt the way a model would: one line per message under the date it falls on, a
 * placeholder such as [type:voice] standing for a non-text message, and the lines under "Context" marked as such.
 */
function readMessageLines(userPrompt: string): PromptMessage[] {
  const messages: PromptMessage[] = []
  let date = ''
  let context = false
  for (const line of userPrompt.split('\n')) {
    if (line.startsWith('Context (')) context = true
    else if (line.startsWith('Messages:')) context = false
    const dated = DATE_LINE.exec(line)
    if (dated) {
      date = dated[1]!
      continue
    }
    const parsed = MESSAGE_LINE.exec(line)
    if (!parsed) continue
    const placeholder = /^\[type:([a-z0-9_]+)\]$/.exec(parsed[4]!)
    messages.push({
      id: Number(parsed[1]),
      t: `${date} ${parsed[3]}`,
      from: parsed[2] as 'A' | 'B',
      type: placeholder ? placeholder[1]! : 'text',
      text: placeholder ? '' : parsed[4]!.replace(/\\n/g, '\n'),
      context,
    })
  }
  return messages
}

/** Read a window prompt the way a model would: the participant legend plus the message lines. */
function readWindow(userPrompt: string): PromptWindow {
  const header = /Window (\d+)\/(\d+)/.exec(userPrompt)
  assert.ok(header)
  return { index: Number(header[1]), total: Number(header[2]), messages: readMessageLines(userPrompt) }
}

function pickMessage(window: PromptWindow, from: 'A' | 'B', preferred: number[] = []): number {
  const usable = window.messages.filter((item) => !item.context && item.from === from && item.type === 'text')
  const preferredHit = usable.find((item) => preferred.includes(item.id))
  const chosen = preferredHit ?? usable.at(-1)
  assert.ok(chosen, `window ${window.index} has no usable message for ${from}`)
  return chosen.id
}

function sharingResponse(event: Record<string, unknown>): string {
  return JSON.stringify({
    events: [
      {
        relatedMessageIds: [],
        categories: ['experience_or_update'],
        topic: 'work_study',
        distress: 'no',
        confidence: 'clear',
        continuesContextEvent: false,
        observation: 'sufficient',
        reason: 'synthetic coding decision',
        ...event,
      },
    ],
  })
}

/** Alice shares in window 1, continues it in window 2, Bob shares his own matter in the last window. */
function defaultWindowResponse(window: PromptWindow): string {
  if (window.index === 1) {
    return sharingResponse({ discloser: 'A', coreMessageIds: [pickMessage(window, 'A', [ALICE_FIRST_SHARING])] })
  }
  if (window.index === 2) {
    return sharingResponse({
      discloser: 'A',
      coreMessageIds: [pickMessage(window, 'A', [ALICE_CONTINUED_SHARING])],
      continuesContextEvent: true,
      categories: ['feeling'],
    })
  }
  if (window.index === window.total) {
    return sharingResponse({
      discloser: 'B',
      coreMessageIds: [pickMessage(window, 'B', [BOB_OWN_SHARING])],
      topic: 'health',
      distress: 'yes',
      categories: ['worry_or_need'],
    })
  }
  return JSON.stringify({ events: [] })
}

interface Harness {
  root: string
  service: IntimacyService
  manager: DatabaseManager
  paths: PathProvider
  advance(ms: number): void
  /** Close the service and open a new one on the same data directory, the way a restarted application would. */
  restart(): IntimacyService
}

function createHarness(
  modelClient: ChatTopicModelClient | null,
  options: { chatType?: 'private' | 'group'; version?: string } = {}
): Harness {
  const root = makeTempDir()
  const chatType = options.chatType ?? 'private'
  createSession(root, chatType)
  const paths = createPathProvider(root)
  const runtimeIdentity = { version: options.version ?? '0.38.0', kind: 'cli' } as const
  const manager = new DatabaseManager(paths, { nativeBinding, runtime: runtimeIdentity })
  let clock = baseNow
  let nextRunId = 1
  const build = () =>
    createIntimacyService({
      runtime: createDatabaseManagerAdapter(manager),
      pathProvider: paths,
      runtimeIdentity,
      nativeBinding,
      getModelClient: () => modelClient,
      now: () => clock,
      generateId: () => `run-${nextRunId++}`,
    })
  const harness: Harness = {
    root,
    service: build(),
    manager,
    paths,
    advance: (ms: number) => {
      clock += ms
    },
    restart: () => {
      harness.service.close()
      harness.service = build()
      return harness.service
    },
  }
  return harness
}

function modelStub(respond: (window: PromptWindow, calls: number) => string | Promise<string>): {
  client: ChatTopicModelClient
  windows: number[]
} {
  const windows: number[] = []
  let calls = 0
  return {
    windows,
    client: {
      modelId: 'test/model',
      async complete(prompts) {
        calls += 1
        const window = readWindow(prompts.userPrompt)
        windows.push(window.index)
        return { text: await respond(window, calls), inputTokens: 3, outputTokens: 2 }
      },
    },
  }
}

async function waitForRun(service: IntimacyService, sessionId: string, runId: string, status: string) {
  await waitUntil(() => service.getRun(sessionId, runId)?.status === status)
  return service.getRun(sessionId, runId)!
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for the intimacy service')
}

test('a full run codes each matter once and keeps a sharing continued across windows as one event', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const preflight = await service.preflight('private', { kinds: ['sharing'] })
    assert.ok(preflight.estimatedWindows >= 3)
    assert.equal(preflight.messageCount, MESSAGE_COUNT)
    assert.equal(preflight.modelId, 'test/model')
    assert.equal(preflight.semanticSearchAvailable, false)
    assert.deepEqual(
      preflight.members.map((member) => [member.memberId, member.name, member.isOwner]),
      [
        [1, 'Alice', true],
        [2, 'Bob', false],
      ]
    )

    const started = service.start('private', { kinds: ['sharing'], locale: 'zh-CN' })
    assert.ok(started.totalWindows >= 3)
    const run = await waitForRun(service, 'private', started.id, 'completed')
    assert.equal(run.modelCalls, run.totalWindows)
    assert.equal(run.completedWindows, run.totalWindows)
    assert.deepEqual(run.failedWindowIndexes, [])

    const results = await service.getResults('private', 'sharing')
    assert.equal(results.events.length, 2)
    assert.equal(results.coverage?.complete, true)
    assert.equal(results.coverage?.sourceChanged, false)

    const [aliceEvent, bobEvent] = results.events
    assert.equal(aliceEvent?.subjectMemberId, 1)
    assert.equal(aliceEvent?.status, 'auto')
    assert.equal(aliceEvent?.evidence.length, 2, 'the continued window appends evidence instead of adding an event')
    assert.deepEqual(aliceEvent?.details.categories, ['experience_or_update', 'feeling'])
    assert.equal(bobEvent?.subjectMemberId, 2)
    assert.equal(bobEvent?.details.topic, 'health')
    assert.equal(results.summary.members[0]?.counted, 1)
    assert.equal(results.summary.members[1]?.counted, 1)
    assert.equal(results.summary.orphanReviews, 0)
    for (const evidence of aliceEvent?.evidence ?? []) {
      assert.ok(results.messages[evidence.messageId], 'every cited message is returned for the evidence view')
    }
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('cancelling keeps the windows already paid for and reports the range as incomplete', async () => {
  let secondWindowStarted = false
  const stub = modelStub(async (window) => {
    if (window.index === 1) return defaultWindowResponse(window)
    secondWindowStarted = true
    await new Promise(() => {})
    return ''
  })
  const client: ChatTopicModelClient = {
    modelId: stub.client.modelId,
    complete(prompts, options) {
      return Promise.race([
        stub.client.complete(prompts, options),
        new Promise<never>((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      ])
    },
  }
  const { service, manager } = createHarness(client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    await waitUntil(() => secondWindowStarted)
    service.cancel('private', started.id)
    const cancelled = await waitForRun(service, 'private', started.id, 'cancelled')
    assert.equal(cancelled.completedWindows, 1)

    const results = await service.getResults('private', 'sharing')
    assert.equal(results.events.length, 1)
    assert.equal(results.coverage?.complete, false)
    assert.equal(results.coverage?.completedWindows, 1)
    assert.ok((results.coverage?.totalWindows ?? 0) > 1)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('resuming continues at the window the analysis stopped on instead of paying for it again', async () => {
  let pauseNow = true
  const stub = modelStub(async (window) => {
    if (window.index >= 2 && pauseNow) {
      await new Promise(() => {})
    }
    return defaultWindowResponse(window)
  })
  const client: ChatTopicModelClient = {
    modelId: stub.client.modelId,
    complete(prompts, options) {
      return Promise.race([
        stub.client.complete(prompts, options),
        new Promise<never>((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('paused')), { once: true })
        }),
      ])
    },
  }
  const { service, manager } = createHarness(client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    await waitUntil(() => stub.windows.length === 2)
    service.pause('private', started.id)
    await waitForRun(service, 'private', started.id, 'paused')
    await new Promise<void>((resolve) => setImmediate(resolve))

    pauseNow = false
    service.resume('private', started.id)
    const completed = await waitForRun(service, 'private', started.id, 'completed')

    assert.equal(stub.windows.filter((index) => index === 1).length, 1, 'the first window is not analysed twice')
    assert.equal(completed.completedWindows, completed.totalWindows)
    const results = await service.getResults('private', 'sharing')
    assert.equal(results.events.length, 2)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('an analysis resumed after a restart keeps hiding redacted text and reading the local calendar', async () => {
  const prompts: PromptWindow[] = []
  let blocked = true
  const stub = modelStub(async (window) => {
    prompts.push(window)
    if (window.index >= 2 && blocked) await new Promise(() => {})
    return defaultWindowResponse(window)
  })
  const client: ChatTopicModelClient = {
    modelId: stub.client.modelId,
    complete(prompts_, options) {
      return Promise.race([
        stub.client.complete(prompts_, options),
        new Promise<never>((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('paused')), { once: true })
        }),
      ])
    },
  }
  const harness = createHarness(client)

  try {
    const started = harness.service.start('private', {
      kinds: ['sharing'],
      timezone: RUN_TIMEZONE,
      preprocessConfig: { desensitize: true, desensitizeRules: [PHONE_RULE] },
    })
    assert.equal(started.timezone, RUN_TIMEZONE)
    await waitUntil(() => stub.windows.length === 2)
    harness.service.pause('private', started.id)
    await waitForRun(harness.service, 'private', started.id, 'paused')
    await new Promise<void>((resolve) => setImmediate(resolve))

    // The new instance never saw the start request: the timezone and the privacy settings must come from the run.
    const service = harness.restart()
    prompts.length = 0
    blocked = false
    service.resume('private', started.id)
    await waitForRun(service, 'private', started.id, 'completed')

    const line = prompts.flatMap((window) => window.messages).find((message) => message.id === BOB_OWN_SHARING)
    assert.ok(line, 'the message carrying the phone number is analysed after the restart')
    assert.ok(!line.text.includes(BOB_PHONE_NUMBER), 'the text the user asked to hide never reaches the model')
    assert.ok(line.text.includes(PHONE_RULE.replacement))
    assert.equal(line.t, '2026-04-30 22:30', 'message times stay in the timezone the run was started with')
    assert.equal(service.getRun('private', started.id)?.timezone, RUN_TIMEZONE)
  } finally {
    harness.service.close()
    harness.manager.closeAll()
  }
})

test('a window the model keeps mis-attributing is skipped while the rest of the range still finishes', async () => {
  const stub = modelStub((window) => {
    if (window.index !== 2) return defaultWindowResponse(window)
    // Attributing the other participant's message to Alice must never be accepted as her own sharing.
    const foreign = window.messages.find((item) => !item.context && item.from === 'B' && item.type === 'text')
    return sharingResponse({ discloser: 'A', coreMessageIds: [foreign?.id ?? BOB_RELAYED_THIRD_PARTY] })
  })
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    const run = await waitForRun(service, 'private', started.id, 'completed')

    assert.deepEqual(run.failedWindowIndexes, [1])
    assert.equal(run.modelCalls, run.totalWindows + 1, 'the invalid window is retried once before it is skipped')
    const results = await service.getResults('private', 'sharing')
    assert.equal(results.coverage?.failedWindows, 1)
    assert.equal(results.coverage?.complete, false)
    assert.ok(results.events.length >= 1)
    for (const event of results.events) {
      for (const evidence of event.evidence.filter((item) => item.role === 'core')) {
        assert.equal(evidence.senderId, event.subjectMemberId)
      }
    }
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('deleting a cited message marks its event stale and reports the range as changed', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { root, service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const before = await service.getResults('private', 'sharing')
    const citedId = before.events[0]!.evidence[0]!.messageId

    manager.close('private')
    const db = new Database(path.join(root, 'data', 'databases', 'private.db'), { nativeBinding })
    db.prepare('DELETE FROM message WHERE id = ?').run(citedId)
    db.close()

    const after = await service.getResults('private', 'sharing')
    assert.equal(after.events[0]?.stale, true)
    assert.equal(after.coverage?.sourceChanged, true)
    assert.equal(after.messages[citedId], undefined)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a rerun replaces the generated events but keeps the decisions the user made', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager, advance } = createHarness(stub.client)

  try {
    const first = service.start('private', { kinds: ['sharing'] })
    await waitForRun(service, 'private', first.id, 'completed')
    const initial = await service.getResults('private', 'sharing')
    const excludedId = initial.events[0]!.id

    const reviewed = await service.reviewEvent('private', excludedId, { decision: 'excluded', expectedRevision: 0 })
    assert.equal(reviewed.events.find((event) => event.id === excludedId)?.status, 'excluded')
    assert.equal(reviewed.summary.members[0]?.counted, 0)
    await assert.rejects(
      () => service.reviewEvent('private', excludedId, { decision: 'included', expectedRevision: 0 }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    )

    advance(60_000)
    const second = service.start('private', { kinds: ['sharing'] })
    await waitForRun(service, 'private', second.id, 'completed')

    const rerun = await service.getResults('private', 'sharing')
    assert.equal(rerun.run?.id, second.id)
    assert.equal(rerun.events.find((event) => event.id === excludedId)?.status, 'excluded')
    assert.equal(rerun.summary.orphanReviews, 0)
    assert.equal(service.getRun('private', first.id), null, 'the superseded run is pruned')
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a confirmed candidate is counted without a run and rejects messages the participant never sent', async () => {
  const { service, manager } = createHarness(null)

  try {
    const results = await service.createUserEvent('private', {
      kind: 'sharing',
      subjectMemberId: 2,
      coreMessageIds: [BOB_OWN_SHARING],
      details: { categories: ['worry_or_need'], topic: 'health', isDistressDisclosure: 'yes' },
    })

    assert.equal(results.run, null)
    assert.equal(results.events.length, 1)
    assert.equal(results.events[0]?.origin, 'user')
    assert.equal(results.events[0]?.runId, null)
    assert.equal(results.events[0]?.status, 'confirmed')
    assert.equal(results.summary.members[1]?.counted, 1)
    assert.equal(results.summary.members[0]?.counted, 0)

    // Confirming the same message again relabels the existing event instead of counting the matter twice.
    const relabelled = await service.createUserEvent('private', {
      kind: 'sharing',
      subjectMemberId: 2,
      coreMessageIds: [BOB_OWN_SHARING],
      details: { categories: ['feeling', 'worry_or_need'], topic: 'health', isDistressDisclosure: 'yes' },
    })
    assert.equal(relabelled.events.length, 1)
    assert.deepEqual(relabelled.events[0]?.details.categories, ['feeling', 'worry_or_need'])
    assert.equal(relabelled.events[0]?.review?.revision, 2)
    assert.equal(relabelled.summary.members[1]?.counted, 1)

    await assert.rejects(
      () =>
        service.createUserEvent('private', {
          kind: 'sharing',
          subjectMemberId: 1,
          coreMessageIds: [BOB_OWN_SHARING],
          details: { categories: ['feeling'], topic: 'other', isDistressDisclosure: 'no' },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )
    await assert.rejects(
      () =>
        service.createUserEvent('private', {
          kind: 'sharing',
          subjectMemberId: 1,
          coreMessageIds: [23],
          details: { categories: ['feeling'], topic: 'other', isDistressDisclosure: 'no' },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )

    const candidates = await service.searchCandidates('private', { kind: 'sharing', query: '体检' })
    assert.equal(candidates.semanticAvailable, false)
    assert.deepEqual(
      candidates.keyword.map((message) => message.messageId),
      [BOB_OWN_SHARING]
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('group chats, unimplemented kinds and a missing LLM are refused before any model call', async () => {
  const groupHarness = createHarness(
    {
      modelId: 'test/model',
      async complete() {
        throw new Error('the model must not be called')
      },
    },
    { chatType: 'group' }
  )
  const withoutLlm = createHarness(null)

  try {
    await assert.rejects(
      () => groupHarness.service.preflight('group', { kinds: ['sharing'] }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )
    await assert.rejects(
      () => withoutLlm.service.preflight('private', { kinds: ['follow_up'] }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )
    assert.throws(
      () => withoutLlm.service.start('private', { kinds: ['sharing'] }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    )
    assert.equal(withoutLlm.service.getLatestRun('private'), null)
  } finally {
    groupHarness.service.close()
    groupHarness.manager.closeAll()
    withoutLlm.service.close()
    withoutLlm.manager.closeAll()
  }
})

test('the intimacy store raises the data directory gate only from runtimes that can already ship it', () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const supported = createHarness(stub.client)
  const development = createHarness(stub.client, { version: '0.37.1' })

  try {
    const meta = readDataDirCompatibilityMeta(supported.paths.getUserDataDir())
    assert.equal(meta?.minRuntimeVersion, '0.38.0')
    assert.ok(meta?.reasons.includes('intimacy-store'))
    assert.throws(
      () => assertDataDirCompatible(supported.paths, { version: '0.37.1', kind: 'cli' }),
      (error: unknown) => error instanceof DataDirCompatibilityError && error.code === 'DATA_DIR_REQUIRES_NEWER_RUNTIME'
    )
    assert.equal(readDataDirCompatibilityMeta(development.paths.getUserDataDir()), null)
    assert.doesNotThrow(() => assertDataDirCompatible(supported.paths, { version: '0.38.0', kind: 'desktop' }))
  } finally {
    supported.service.close()
    supported.manager.closeAll()
    development.service.close()
    development.manager.closeAll()
  }
})

test('deleting a session removes the intimacy results derived from it', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private', 'sharing')
    await service.reviewEvent('private', results.events[0]!.id, { decision: 'excluded', expectedRevision: 0 })

    assert.equal(manager.deleteSessionDatabaseFiles('private'), true)
    assert.equal(service.getLatestRun('private'), null, 'paid results must not outlive the chat they describe')
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('clearing results can keep the user decisions and is refused while an analysis is running', async () => {
  let blocked = true
  const stub = modelStub(async (window) => {
    if (window.index >= 2 && blocked) await new Promise(() => {})
    return defaultWindowResponse(window)
  })
  const client: ChatTopicModelClient = {
    modelId: stub.client.modelId,
    complete(prompts, options) {
      return Promise.race([
        stub.client.complete(prompts, options),
        new Promise<never>((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
      ])
    },
  }
  const { service, manager } = createHarness(client)

  try {
    const started = service.start('private', { kinds: ['sharing'] })
    await waitUntil(() => stub.windows.length === 2)
    assert.throws(
      () => service.clearResults('private', { includeReviews: false }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    )

    blocked = false
    service.cancel('private', started.id)
    await waitForRun(service, 'private', started.id, 'cancelled')
    const results = await service.getResults('private', 'sharing')
    await service.reviewEvent('private', results.events[0]!.id, { decision: 'excluded', expectedRevision: 0 })

    assert.equal(service.clearResults('private', { includeReviews: false }), true)
    const cleared = await service.getResults('private', 'sharing')
    assert.equal(cleared.events.length, 0)
    assert.equal(cleared.coverage, null)
    assert.equal(cleared.summary.orphanReviews, 1, 'the kept decision is reported for re-checking')

    assert.equal(service.clearResults('private', { includeReviews: true }), true)
    assert.equal((await service.getResults('private', 'sharing')).summary.orphanReviews, 0)
  } finally {
    service.close()
    manager.closeAll()
  }
})
