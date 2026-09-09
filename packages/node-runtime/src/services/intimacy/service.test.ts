import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type PathProvider } from '@openchatlab/core'
import type {
  FollowUpDetails,
  GoodNewsResponseDetails,
  IntimacyEvent,
  IntimacyFollowUpMemberSummary,
  IntimacyMemberSummary,
  IntimacyResponseMemberSummary,
  IntimacyResults,
  SharingDetails,
  SupportResponseDetails,
} from '@openchatlab/shared-types'
import { assertDataDirCompatible, DataDirCompatibilityError, readDataDirCompatibilityMeta } from '../../data-dir-compat'
import { DatabaseManager } from '../../database-manager'
import type { SemanticIndexRuntime } from '../../semantic-index'
import { createDatabaseManagerAdapter } from '../adapters'
import type { ChatTopicModelClient } from '../topics/model-client'
import { createIntimacyService, type IntimacyService } from './service'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const baseTs = Date.parse('2026-05-01T08:00:00.000Z') / 1000
const baseNow = Date.parse('2026-05-02T08:00:00.000Z')
const MESSAGE_COUNT = 61

/** Ids of the hand-written messages inside the generated filler; senders alternate by parity. */
const ALICE_FIRST_SHARING = 5
const ALICE_CONTINUED_SHARING = 17
const BOB_RELAYED_THIRD_PARTY = 12
const ALICE_GOOD_NEWS = 25
const BOB_DIMINISHES_GOOD_NEWS = 26
const BOB_OWN_SHARING = 30
const ALICE_SUPPORTS_BOB = 31
/** The last messages of window 2, so their answer can only appear in window 3. */
const BOB_LATE_DISCLOSURE = 34
const ALICE_LATE_SUPPORT = 37
const ALICE_UNANSWERED_DISCLOSURE = 39
/** The last message of its window, so no answer to it could be visible there. */
const BOB_DISCLOSURE_AT_RANGE_END = 48
/** Long enough to end the window it lands in, so the question after it reads it as context. */
const ALICE_DECORATION_PRIOR = 49
const BOB_DECORATION_QUESTION = 50
const ALICE_VISIT_PRIOR = 51
const BOB_VISIT_QUESTION = 52
/** Bob brings his check-up up again between his first mention of it and Alice asking about it. */
const BOB_REPEATS_CHECKUP = 54
const ALICE_CHECKUP_QUESTION = 55
const BOB_LICENCE_PRIOR = 56
const ALICE_LICENCE_QUESTION = 57
const ALICE_VAGUE_QUESTION = 59
const ALICE_UNMATCHABLE_QUESTION = 61
const BOB_PHONE_NUMBER = '13800001111'

const MATTER_DECORATION = '客厅装修'
const MATTER_VISIT = '妈妈来住'
const MATTER_CHECKUP = '体检结果'
const MATTER_LICENCE = '换驾照'
const MATTER_VAGUE = '最近过得怎么样'
const MATTER_REVIEW = '复查结果'

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
    [ALICE_GOOD_NEWS, { type: 0, content: '我拿到那个 offer 了！下周一入职' }],
    [BOB_DIMINISHES_GOOD_NEWS, { type: 0, content: '就这？那家公司谁都能进吧' }],
    [
      BOB_OWN_SHARING,
      { type: 0, content: `我最近体检结果有点问题，说实话有点担心，医院让我打 ${BOB_PHONE_NUMBER} 约复查` },
    ],
    [ALICE_SUPPORTS_BOB, { type: 0, content: '听起来挺吓人的，你现在感觉怎么样？复查约在哪天' }],
    [BOB_LATE_DISCLOSURE, { type: 0, content: '我爸这两天住院了，我一个人跑上跑下有点撑不住' }],
    [ALICE_LATE_SUPPORT, { type: 0, content: '需要我请假过去帮你盯一天吗？我明天上午没会' }],
    [ALICE_UNANSWERED_DISCLOSURE, { type: 0, content: '我这两天总睡不着，心里一直发慌' }],
    [BOB_DISCLOSURE_AT_RANGE_END, { type: 0, content: '简历改完了，但一直没敢投，怕又是白忙一场' }],
    [
      ALICE_DECORATION_PRIOR,
      { type: 0, content: `我家客厅下周开始装修，师傅说要两周。${'装修的事真是麻烦。'.repeat(700)}` },
    ],
    [BOB_DECORATION_QUESTION, { type: 0, content: '装修的事进展怎么样了' }],
    [ALICE_VISIT_PRIOR, { type: 0, content: '我妈下周要来住一段时间，我有点紧张' }],
    [BOB_VISIT_QUESTION, { type: 0, content: '阿姨来住的事你准备得怎么样了' }],
    [BOB_REPEATS_CHECKUP, { type: 0, content: '体检报告还是没出来，我有点烦' }],
    [ALICE_CHECKUP_QUESTION, { type: 0, content: '你上次说的体检结果出来了吗' }],
    [BOB_LICENCE_PRIOR, { type: 0, content: '我这周还要去趟车管所换驾照' }],
    [ALICE_LICENCE_QUESTION, { type: 0, content: '驾照换好了吗' }],
    [ALICE_VAGUE_QUESTION, { type: 0, content: '你最近怎么样' }],
    [ALICE_UNMATCHABLE_QUESTION, { type: 0, content: '那次复查医生怎么说' }],
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

/** One matching call: the matter the question is about, the question itself and the candidates offered for it. */
interface PromptMatch {
  matter: string
  questionIds: number[]
  candidateIds: number[]
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

function readMatch(userPrompt: string): PromptMatch {
  const matter = /The question asks about: (.*)/.exec(userPrompt)
  assert.ok(matter)
  const questionIds: number[] = []
  const candidateIds: number[] = []
  let section: 'question' | 'candidates' | null = null
  for (const line of userPrompt.split('\n')) {
    if (line.startsWith('Question:')) section = 'question'
    else if (line.startsWith('Earlier messages from')) section = 'candidates'
    const parsed = MESSAGE_LINE.exec(line)
    if (!parsed) continue
    ;(section === 'candidates' ? candidateIds : questionIds).push(Number(parsed[1]))
  }
  return { matter: matter[1]!, questionIds, candidateIds }
}

function sharingEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'sharing',
    relatedMessageIds: [],
    categories: ['experience_or_update'],
    topic: 'work_study',
    distress: 'no',
    confidence: 'clear',
    continuesContextEvent: false,
    observation: 'sufficient',
    reason: 'synthetic coding decision',
    ...event,
  }
}

function goodNewsEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'good_news',
    relatedMessageIds: [],
    positiveForSharer: 'explicit_or_context_supported',
    confidence: 'clear',
    continuesContextEvent: false,
    observation: 'sufficient',
    reason: 'synthetic coding decision',
    ...event,
  }
}

function followUpEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'follow_up',
    confidence: 'clear',
    observation: 'sufficient',
    reason: 'synthetic coding decision',
    ...event,
  }
}

function sharingResponse(event: Record<string, unknown>): string {
  return JSON.stringify({ events: [sharingEvent(event)] })
}

function visibleResponse(messageIds: number[], labels: string[]): Record<string, unknown> {
  return { observation: 'visible_response', messageIds, labels }
}

const NO_VISIBLE_RESPONSE = { observation: 'no_visible_response', messageIds: [], labels: [] }
const RESPONSE_NOT_YET_VISIBLE = { observation: 'insufficient_context', messageIds: [], labels: [] }

/**
 * The synthetic coding decisions, keyed on the messages a window actually contains: a sharing without distress
 * and one continued in the next window, the same messages coded as both a sharing and good news, a disclosure
 * answered inside its window, one whose answer only arrives in the next window, one nobody answered, and one at
 * the end of the range where an answer could not be seen yet.
 */
function defaultWindowResponse(window: PromptWindow): string {
  const own = (id: number) => window.messages.some((message) => message.id === id && !message.context)
  const asContext = (id: number) => window.messages.some((message) => message.id === id && message.context)
  const events: Record<string, unknown>[] = []
  if (own(ALICE_FIRST_SHARING)) {
    events.push(sharingEvent({ discloser: 'A', coreMessageIds: [ALICE_FIRST_SHARING] }))
  }
  if (own(ALICE_CONTINUED_SHARING)) {
    events.push(
      sharingEvent({
        discloser: 'A',
        coreMessageIds: [ALICE_CONTINUED_SHARING],
        continuesContextEvent: true,
        categories: ['feeling'],
      })
    )
  }
  if (own(ALICE_GOOD_NEWS)) {
    events.push(sharingEvent({ discloser: 'A', coreMessageIds: [ALICE_GOOD_NEWS] }))
    events.push(
      goodNewsEvent({
        discloser: 'A',
        coreMessageIds: [ALICE_GOOD_NEWS],
        responses: visibleResponse([BOB_DIMINISHES_GOOD_NEWS], ['explicitly_diminishes']),
      })
    )
  }
  if (own(BOB_OWN_SHARING)) {
    events.push(
      sharingEvent({
        discloser: 'B',
        coreMessageIds: [BOB_OWN_SHARING],
        categories: ['worry_or_need'],
        topic: 'health',
        distress: 'yes',
        responses: visibleResponse([ALICE_SUPPORTS_BOB], ['acknowledges_feeling', 'asks_details']),
      })
    )
  }
  if (own(BOB_LATE_DISCLOSURE)) {
    events.push(
      sharingEvent({
        discloser: 'B',
        coreMessageIds: [BOB_LATE_DISCLOSURE],
        categories: ['worry_or_need'],
        topic: 'family',
        distress: 'yes',
        responses: RESPONSE_NOT_YET_VISIBLE,
      })
    )
  }
  if (asContext(BOB_LATE_DISCLOSURE) && own(ALICE_LATE_SUPPORT)) {
    events.push(
      sharingEvent({
        discloser: 'B',
        coreMessageIds: [],
        categories: [],
        continuesContextEvent: true,
        distress: 'yes',
        responses: visibleResponse([ALICE_LATE_SUPPORT], ['offers_advice_or_help']),
      })
    )
  }
  if (own(ALICE_UNANSWERED_DISCLOSURE)) {
    events.push(
      sharingEvent({
        discloser: 'A',
        coreMessageIds: [ALICE_UNANSWERED_DISCLOSURE],
        categories: ['feeling', 'worry_or_need'],
        topic: 'health',
        distress: 'yes',
        responses: NO_VISIBLE_RESPONSE,
      })
    )
  }
  if (own(BOB_DISCLOSURE_AT_RANGE_END)) {
    events.push(
      sharingEvent({
        discloser: 'B',
        coreMessageIds: [BOB_DISCLOSURE_AT_RANGE_END],
        categories: ['worry_or_need'],
        distress: 'yes',
        responses: RESPONSE_NOT_YET_VISIBLE,
      })
    )
  }
  // The earlier message is right there in this window, or in the tail it carries over from the previous one.
  if (own(BOB_DECORATION_QUESTION) && asContext(ALICE_DECORATION_PRIOR)) {
    events.push(
      followUpEvent({
        asker: 'B',
        coreMessageIds: [BOB_DECORATION_QUESTION],
        priorMessageIds: [ALICE_DECORATION_PRIOR],
        matter: MATTER_DECORATION,
        matterKeywords: ['装修'],
      })
    )
  }
  if (own(BOB_VISIT_QUESTION) && own(ALICE_VISIT_PRIOR)) {
    events.push(
      followUpEvent({
        asker: 'B',
        coreMessageIds: [BOB_VISIT_QUESTION],
        priorMessageIds: [ALICE_VISIT_PRIOR],
        matter: MATTER_VISIT,
        matterKeywords: ['来住', '阿姨'],
      })
    )
  }
  // These three cite no earlier message: the matter has to be found by the matching step, or not at all.
  if (own(ALICE_CHECKUP_QUESTION)) {
    events.push(
      followUpEvent({
        asker: 'A',
        coreMessageIds: [ALICE_CHECKUP_QUESTION],
        matter: MATTER_CHECKUP,
        matterKeywords: ['体检'],
      })
    )
  }
  if (own(ALICE_LICENCE_QUESTION)) {
    events.push(
      followUpEvent({
        asker: 'A',
        coreMessageIds: [ALICE_LICENCE_QUESTION],
        matter: MATTER_LICENCE,
        matterKeywords: ['驾照'],
      })
    )
  }
  if (own(ALICE_VAGUE_QUESTION)) {
    events.push(
      followUpEvent({
        asker: 'A',
        coreMessageIds: [ALICE_VAGUE_QUESTION],
        matter: MATTER_VAGUE,
        matterKeywords: ['最近'],
        confidence: 'uncertain',
      })
    )
  }
  if (own(ALICE_UNMATCHABLE_QUESTION)) {
    events.push(
      followUpEvent({
        asker: 'A',
        coreMessageIds: [ALICE_UNMATCHABLE_QUESTION],
        matter: MATTER_REVIEW,
        matterKeywords: ['复查'],
      })
    )
  }
  return JSON.stringify({ events })
}

/**
 * The synthetic matching decisions: the check-up and the licence are found among the candidates, the general
 * check-in matches nothing, and one answer cites a message that was never offered.
 */
function defaultMatchResponse(match: PromptMatch): string {
  if (match.matter === MATTER_CHECKUP) {
    return JSON.stringify({ priorMessageIds: [BOB_OWN_SHARING], match: 'supported' })
  }
  if (match.matter === MATTER_LICENCE) {
    return JSON.stringify({ priorMessageIds: [BOB_LICENCE_PRIOR], match: 'supported' })
  }
  if (match.matter === MATTER_REVIEW) return JSON.stringify({ priorMessageIds: [9999], match: 'supported' })
  return JSON.stringify({ priorMessageIds: [], match: 'uncertain' })
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

/** Stands in for the semantic index: every query returns the block the test wants recalled. */
function semanticStub(startMessageId: number, endMessageId: number): SemanticIndexRuntime {
  return {
    canSearch: () => true,
    search: () =>
      Promise.resolve({
        available: true,
        blocks: [{ parentId: 'p1', startMessageId, endMessageId, messages: [], tokens: 0, chunkIds: [], score: 0.6 }],
        coverage: 1,
        partial: false,
        hitCount: 1,
      }),
  } as unknown as SemanticIndexRuntime
}

function createHarness(
  modelClient: ChatTopicModelClient | null,
  options: { chatType?: 'private' | 'group'; version?: string; semanticIndex?: SemanticIndexRuntime } = {}
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
      semanticIndex: options.semanticIndex,
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

function modelStub(
  respond: (window: PromptWindow, calls: number) => string | Promise<string>,
  matchRespond: (match: PromptMatch) => string = defaultMatchResponse
): {
  client: ChatTopicModelClient
  windows: number[]
  matches: PromptMatch[]
} {
  const windows: number[] = []
  const matches: PromptMatch[] = []
  let calls = 0
  return {
    windows,
    matches,
    client: {
      modelId: 'test/model',
      async complete(prompts) {
        calls += 1
        // The matching step reuses the same client, so the stub answers whichever prompt it was given.
        if (!prompts.userPrompt.includes('\nWindow ')) {
          const match = readMatch(prompts.userPrompt)
          matches.push(match)
          return { text: matchRespond(match), inputTokens: 3, outputTokens: 2 }
        }
        const window = readWindow(prompts.userPrompt)
        windows.push(window.index)
        return { text: await respond(window, calls), inputTokens: 3, outputTokens: 2 }
      },
    },
  }
}

/** The K1 card of the mixed-kind results. */
function sharingSummary(results: IntimacyResults): IntimacyMemberSummary[] {
  const summary = results.summaries.find((item) => item.kind === 'sharing')
  assert.ok(summary?.kind === 'sharing')
  return summary.members
}

function responseSummary(
  results: IntimacyResults,
  kind: 'support_response' | 'good_news_response'
): IntimacyResponseMemberSummary[] {
  const summary = results.summaries.find((item) => item.kind === kind)
  assert.ok(summary?.kind === 'support_response' || summary?.kind === 'good_news_response')
  return summary.members
}

function followUpSummary(results: IntimacyResults): IntimacyFollowUpMemberSummary[] {
  const summary = results.summaries.find((item) => item.kind === 'follow_up')
  assert.ok(summary?.kind === 'follow_up')
  return summary.members
}

function event(results: IntimacyResults, eventId: string): IntimacyEvent {
  const found = results.events.find((item) => item.id === eventId)
  assert.ok(found, `the results contain ${eventId}`)
  return found
}

function sharingDetails(event: IntimacyEvent): SharingDetails {
  assert.ok(event.details.kind === 'sharing')
  return event.details
}

function responseDetails(event: IntimacyEvent): SupportResponseDetails | GoodNewsResponseDetails {
  assert.ok(event.details.kind === 'support_response' || event.details.kind === 'good_news_response')
  return event.details
}

function followUpDetails(event: IntimacyEvent): FollowUpDetails {
  assert.ok(event.details.kind === 'follow_up')
  return event.details
}

function evidenceRoles(event: IntimacyEvent): Array<[number, string]> {
  return event.evidence.map((item) => [item.messageId, item.role])
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
    const preflight = await service.preflight('private', {
      kinds: ['sharing', 'support_response', 'good_news_response'],
    })
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
    assert.equal(run.modelCalls, run.totalWindows + stub.matches.length)
    assert.equal(run.completedWindows, run.totalWindows)
    assert.deepEqual(run.failedWindowIndexes, [])

    const results = await service.getResults('private')
    const sharingEvents = results.events.filter((event) => event.kind === 'sharing')
    assert.equal(results.coverage?.complete, true)
    assert.equal(results.coverage?.sourceChanged, false)

    const aliceEvent = event(results, `sharing:${ALICE_FIRST_SHARING}`)
    assert.equal(aliceEvent.subjectMemberId, 1)
    assert.equal(aliceEvent.status, 'auto')
    assert.equal(aliceEvent.evidence.length, 2, 'the continued window appends evidence instead of adding an event')
    assert.deepEqual(sharingDetails(aliceEvent).categories, ['experience_or_update', 'feeling'])
    assert.equal(sharingDetails(event(results, `sharing:${BOB_OWN_SHARING}`)).topic, 'health')
    assert.deepEqual(
      sharingEvents.map((item) => item.id),
      [
        `sharing:${ALICE_FIRST_SHARING}`,
        `sharing:${ALICE_GOOD_NEWS}`,
        `sharing:${BOB_OWN_SHARING}`,
        `sharing:${BOB_LATE_DISCLOSURE}`,
        `sharing:${ALICE_UNANSWERED_DISCLOSURE}`,
        `sharing:${BOB_DISCLOSURE_AT_RANGE_END}`,
      ]
    )
    assert.equal(sharingSummary(results)[0]?.counted, 3)
    assert.equal(sharingSummary(results)[1]?.counted, 3)
    assert.equal(results.orphanReviews, 0)
    for (const evidence of aliceEvent.evidence) {
      assert.ok(results.messages[evidence.messageId], 'every cited message is returned for the evidence view')
    }
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a disclosure and the answer to it stay one support event, and a sharing with no distress makes none', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing', 'support_response', 'good_news_response'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private')

    assert.deepEqual(
      results.events.filter((item) => item.kind === 'support_response').map((item) => item.id),
      [
        `support_response:${BOB_OWN_SHARING}`,
        `support_response:${BOB_LATE_DISCLOSURE}`,
        `support_response:${ALICE_UNANSWERED_DISCLOSURE}`,
        `support_response:${BOB_DISCLOSURE_AT_RANGE_END}`,
      ],
      'only a disclosure marked as distress gets a support event, and each gets exactly one'
    )

    const answered = event(results, `support_response:${BOB_OWN_SHARING}`)
    assert.equal(answered.subjectMemberId, 2, 'the discloser is the subject')
    assert.equal(answered.otherMemberId, 1, 'the participant who answered is the other side')
    assert.deepEqual(
      answered.evidence.map((item) => [item.messageId, item.role]),
      [
        [BOB_OWN_SHARING, 'core'],
        [ALICE_SUPPORTS_BOB, 'response'],
      ]
    )
    assert.deepEqual(responseDetails(answered), {
      kind: 'support_response',
      disclosureEventId: `sharing:${BOB_OWN_SHARING}`,
      responseObservation: 'visible_response',
      responseLabels: ['acknowledges_feeling', 'asks_details'],
    })

    // The answer arrives one window after the disclosure: it joins the same event instead of opening a second one.
    const late = event(results, `support_response:${BOB_LATE_DISCLOSURE}`)
    assert.deepEqual(
      late.evidence.map((item) => [item.messageId, item.role]),
      [
        [BOB_LATE_DISCLOSURE, 'core'],
        [ALICE_LATE_SUPPORT, 'response'],
      ]
    )
    assert.equal(responseDetails(late).responseObservation, 'visible_response')
    assert.deepEqual(responseDetails(late).responseLabels, ['offers_advice_or_help'])

    const unanswered = event(results, `support_response:${ALICE_UNANSWERED_DISCLOSURE}`)
    assert.equal(responseDetails(unanswered).responseObservation, 'no_visible_response')
    assert.deepEqual(responseDetails(unanswered).responseLabels, [], 'a missing answer never carries a label')
    assert.equal(
      responseDetails(event(results, `support_response:${BOB_DISCLOSURE_AT_RANGE_END}`)).responseObservation,
      'insufficient_context',
      'a disclosure at the end of the range is reported as unreadable, not as unanswered'
    )

    const [alice, bob] = responseSummary(results, 'support_response')
    assert.deepEqual(alice, {
      memberId: 1,
      anchors: 3,
      visibleResponse: 2,
      noVisibleResponse: 0,
      insufficientContext: 1,
      byLabel: {
        acknowledges_feeling: 1,
        addresses_situation: 0,
        asks_details: 1,
        offers_advice_or_help: 1,
        shares_related_experience: 0,
        unclear: 0,
      },
    })
    assert.equal(bob?.anchors, 1)
    assert.equal(bob?.noVisibleResponse, 1)
    assert.deepEqual(
      Object.values(bob?.byLabel ?? {}),
      [0, 0, 0, 0, 0, 0],
      'a disclosure nobody answered adds no response label at all'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('good news is counted next to the sharing that reports it, with the reply that played it down', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing', 'good_news_response'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private')

    const goodNews = event(results, `good_news_response:${ALICE_GOOD_NEWS}`)
    assert.equal(goodNews.subjectMemberId, 1)
    assert.equal(goodNews.otherMemberId, 2)
    assert.deepEqual(
      goodNews.evidence.map((item) => [item.messageId, item.role]),
      [
        [ALICE_GOOD_NEWS, 'core'],
        [BOB_DIMINISHES_GOOD_NEWS, 'response'],
      ]
    )
    assert.deepEqual(responseDetails(goodNews).responseLabels, ['explicitly_diminishes'])
    // The same messages are also a personal sharing: the two kinds count the same matter for different questions.
    assert.ok(
      results.events.some((item) => item.id === `sharing:${ALICE_GOOD_NEWS}`),
      'a good news event does not take the messages away from the sharing card'
    )

    const [alice, bob] = responseSummary(results, 'good_news_response')
    assert.equal(alice?.anchors, 0)
    assert.equal(bob?.anchors, 1)
    assert.equal(bob?.visibleResponse, 1)
    assert.equal(bob?.byLabel.explicitly_diminishes, 1)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a revision relabels a reply that was seen and is refused for one that was not', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing', 'support_response'] })
    await waitForRun(service, 'private', started.id, 'completed')

    const reviewed = await service.reviewEvent('private', `support_response:${BOB_OWN_SHARING}`, {
      decision: 'included',
      expectedRevision: 0,
      details: { responseLabels: ['addresses_situation'] },
    })
    const revised = event(reviewed, `support_response:${BOB_OWN_SHARING}`)
    assert.equal(revised.status, 'confirmed')
    assert.deepEqual(responseDetails(revised).responseLabels, ['addresses_situation'])
    const [alice] = responseSummary(reviewed, 'support_response')
    assert.equal(alice?.byLabel.addresses_situation, 1)
    assert.equal(alice?.byLabel.acknowledges_feeling, 0, 'the counts follow the labels the user corrected')
    assert.equal(alice?.anchors, 3)

    await assert.rejects(
      () =>
        service.reviewEvent('private', `support_response:${BOB_OWN_SHARING}`, {
          decision: 'included',
          expectedRevision: 1,
          details: { responseLabels: ['congratulates_or_affirms'] },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      'labels of another kind do not belong on a support response'
    )
    await assert.rejects(
      () =>
        service.reviewEvent('private', `support_response:${ALICE_UNANSWERED_DISCLOSURE}`, {
          decision: 'included',
          expectedRevision: 0,
          details: { responseLabels: ['acknowledges_feeling'] },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      'a reply nobody could see must never be given a label'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a confirmed response counts the reply the user picked and refuses one the other side never sent', async () => {
  const { service, manager } = createHarness(null)

  try {
    const created = await service.createUserEvent('private', {
      kind: 'good_news_response',
      subjectMemberId: 1,
      coreMessageIds: [ALICE_GOOD_NEWS],
      responseMessageIds: [BOB_DIMINISHES_GOOD_NEWS],
      details: { positiveForSharer: 'explicit_or_context_supported', responseLabels: ['explicitly_diminishes'] },
    })
    const goodNews = event(created, `good_news_response:${ALICE_GOOD_NEWS}`)
    assert.equal(goodNews.status, 'confirmed')
    assert.equal(goodNews.origin, 'user')
    assert.deepEqual(
      goodNews.evidence.map((item) => [item.messageId, item.role]),
      [
        [ALICE_GOOD_NEWS, 'core'],
        [BOB_DIMINISHES_GOOD_NEWS, 'response'],
      ]
    )
    assert.equal(responseSummary(created, 'good_news_response')[1]?.byLabel.explicitly_diminishes, 1)

    // Confirming the same matter again relabels that event instead of counting the same reply twice.
    const relabelled = await service.createUserEvent('private', {
      kind: 'good_news_response',
      subjectMemberId: 1,
      coreMessageIds: [ALICE_GOOD_NEWS],
      responseMessageIds: [BOB_DIMINISHES_GOOD_NEWS],
      details: { positiveForSharer: 'uncertain', responseLabels: ['other_visible_response'] },
    })
    assert.equal(relabelled.events.filter((item) => item.kind === 'good_news_response').length, 1)
    assert.deepEqual(responseDetails(event(relabelled, `good_news_response:${ALICE_GOOD_NEWS}`)).responseLabels, [
      'other_visible_response',
    ])
    assert.equal(responseSummary(relabelled, 'good_news_response')[1]?.anchors, 1)

    // A support response needs the disclosure it answers, so confirming one writes that disclosure as well.
    const support = await service.createUserEvent('private', {
      kind: 'support_response',
      subjectMemberId: 2,
      coreMessageIds: [BOB_OWN_SHARING],
      responseMessageIds: [ALICE_SUPPORTS_BOB],
      details: { responseLabels: ['acknowledges_feeling'] },
    })
    const disclosure = event(support, `sharing:${BOB_OWN_SHARING}`)
    assert.equal(disclosure.origin, 'user')
    assert.equal(sharingDetails(disclosure).isDistressDisclosure, 'yes')
    assert.deepEqual(responseDetails(event(support, `support_response:${BOB_OWN_SHARING}`)), {
      kind: 'support_response',
      disclosureEventId: `sharing:${BOB_OWN_SHARING}`,
      responseObservation: 'visible_response',
      responseLabels: ['acknowledges_feeling'],
    })

    // Confirming a disclosure nobody answered records exactly that, never a label about how it went.
    const unanswered = await service.createUserEvent('private', {
      kind: 'support_response',
      subjectMemberId: 1,
      coreMessageIds: [ALICE_UNANSWERED_DISCLOSURE],
      details: { responseLabels: [] },
    })
    assert.equal(
      responseDetails(event(unanswered, `support_response:${ALICE_UNANSWERED_DISCLOSURE}`)).responseObservation,
      'no_visible_response'
    )

    const rejected: Array<[string, number[], string[]]> = [
      ['a reply the discloser sent themselves', [BOB_LATE_DISCLOSURE], ['unclear']],
      ['a reply that came before the disclosure', [ALICE_FIRST_SHARING], ['unclear']],
      ['labels without a reply to attach them to', [], ['unclear']],
      ['a reply with no label at all', [ALICE_SUPPORTS_BOB], []],
    ]
    for (const [name, responseMessageIds, responseLabels] of rejected) {
      await assert.rejects(
        () =>
          service.createUserEvent('private', {
            kind: 'support_response',
            subjectMemberId: 2,
            coreMessageIds: [BOB_DISCLOSURE_AT_RANGE_END],
            responseMessageIds,
            details: { responseLabels: responseLabels as SupportResponseDetails['responseLabels'] },
          }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
        name
      )
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

    const results = await service.getResults('private')
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
    const results = await service.getResults('private')
    assert.equal(results.events.filter((event) => event.kind === 'sharing').length, 6)
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
    assert.equal(
      run.modelCalls,
      run.totalWindows + 1 + stub.matches.length,
      'the invalid window is retried once before it is skipped'
    )
    const results = await service.getResults('private')
    assert.equal(results.coverage?.failedWindows, 1)
    assert.equal(results.coverage?.complete, false)
    assert.ok(results.events.length >= 1)
    for (const event of results.events) {
      // The core messages are the discloser's own words, except for a question, which the asker sent.
      const author = event.kind === 'follow_up' ? event.otherMemberId : event.subjectMemberId
      for (const evidence of event.evidence.filter((item) => item.role === 'core')) {
        assert.equal(evidence.senderId, author)
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
    const before = await service.getResults('private')
    const citedId = before.events[0]!.evidence[0]!.messageId

    manager.close('private')
    const db = new Database(path.join(root, 'data', 'databases', 'private.db'), { nativeBinding })
    db.prepare('DELETE FROM message WHERE id = ?').run(citedId)
    db.close()

    const after = await service.getResults('private')
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
    const initial = await service.getResults('private')
    const excludedId = event(initial, `sharing:${ALICE_FIRST_SHARING}`).id
    assert.equal(sharingSummary(initial)[0]?.counted, 3)

    const reviewed = await service.reviewEvent('private', excludedId, { decision: 'excluded', expectedRevision: 0 })
    assert.equal(reviewed.events.find((item) => item.id === excludedId)?.status, 'excluded')
    assert.equal(sharingSummary(reviewed)[0]?.counted, 2)
    await assert.rejects(
      () => service.reviewEvent('private', excludedId, { decision: 'included', expectedRevision: 0 }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    )

    advance(60_000)
    const second = service.start('private', { kinds: ['sharing'] })
    await waitForRun(service, 'private', second.id, 'completed')

    const rerun = await service.getResults('private')
    assert.equal(rerun.run?.id, second.id)
    assert.equal(rerun.events.find((event) => event.id === excludedId)?.status, 'excluded')
    assert.equal(rerun.orphanReviews, 0)
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
    assert.equal(sharingSummary(results)[1]?.counted, 1)
    assert.equal(sharingSummary(results)[0]?.counted, 0)

    // Confirming the same message again relabels the existing event instead of counting the matter twice.
    const relabelled = await service.createUserEvent('private', {
      kind: 'sharing',
      subjectMemberId: 2,
      coreMessageIds: [BOB_OWN_SHARING],
      details: { categories: ['feeling', 'worry_or_need'], topic: 'health', isDistressDisclosure: 'yes' },
    })
    assert.equal(relabelled.events.length, 1)
    assert.deepEqual(sharingDetails(relabelled.events[0]!).categories, ['feeling', 'worry_or_need'])
    assert.equal(relabelled.events[0]?.review?.revision, 2)
    assert.equal(sharingSummary(relabelled)[1]?.counted, 1)

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
      [ALICE_CHECKUP_QUESTION, BOB_REPEATS_CHECKUP, BOB_OWN_SHARING],
      'every message that mentions the matter is offered, most recent first'
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
      () => withoutLlm.service.preflight('private', { kinds: ['shared_plan'] }),
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
    const results = await service.getResults('private')
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
    const results = await service.getResults('private')
    await service.reviewEvent('private', results.events[0]!.id, { decision: 'excluded', expectedRevision: 0 })

    assert.equal(service.clearResults('private', { includeReviews: false }), true)
    const cleared = await service.getResults('private')
    assert.equal(cleared.events.length, 0)
    assert.equal(cleared.coverage, null)
    assert.equal(cleared.orphanReviews, 1, 'the kept decision is reported for re-checking')

    assert.equal(service.clearResults('private', { includeReviews: true }), true)
    assert.equal((await service.getResults('private')).orphanReviews, 0)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a follow-up question is paired with the earlier matter, by its own window or by the matching step', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  // The semantic index recalls a message no keyword and no coded event would have found.
  const { service, manager } = createHarness(stub.client, { semanticIndex: semanticStub(20, 20) })

  try {
    const preflight = await service.preflight('private', { kinds: ['follow_up'] })
    assert.equal(
      preflight.estimatedCalls,
      preflight.estimatedWindows * 2,
      'the estimate covers the pairing calls the analysis may need'
    )

    const started = service.start('private', {
      kinds: ['sharing', 'support_response', 'follow_up', 'good_news_response'],
    })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private')

    // The earlier message is in the question's own window, or in the tail it carries over from the previous one.
    const visit = event(results, `follow_up:${BOB_VISIT_QUESTION}`)
    assert.equal(visit.subjectMemberId, 1, 'the participant who was asked is the subject')
    assert.equal(visit.otherMemberId, 2, 'the asker is the other side')
    assert.equal(visit.status, 'auto')
    assert.deepEqual(evidenceRoles(visit), [
      [ALICE_VISIT_PRIOR, 'prior'],
      [BOB_VISIT_QUESTION, 'core'],
    ])
    assert.equal(followUpDetails(visit).matchConfidence, 'supported')
    assert.deepEqual(evidenceRoles(event(results, `follow_up:${BOB_DECORATION_QUESTION}`)), [
      [ALICE_DECORATION_PRIOR, 'prior'],
      [BOB_DECORATION_QUESTION, 'core'],
    ])

    // The check-up was mentioned windows earlier: the matching step has to find it among the candidates.
    const checkup = event(results, `follow_up:${ALICE_CHECKUP_QUESTION}`)
    const checkupDetails = followUpDetails(checkup)
    assert.deepEqual(evidenceRoles(checkup), [
      [BOB_OWN_SHARING, 'prior'],
      [ALICE_CHECKUP_QUESTION, 'core'],
    ])
    assert.equal(checkupDetails.priorEventId, `sharing:${BOB_OWN_SHARING}`)
    assert.equal(checkupDetails.gapSeconds, (ALICE_CHECKUP_QUESTION - BOB_OWN_SHARING) * 60)
    assert.equal(
      checkupDetails.initiationInObservedRecord,
      'after_subject_reintroduced',
      'he had brought the check-up up again himself before she asked'
    )
    const checkupCall = stub.matches.find((match) => match.matter === MATTER_CHECKUP)
    assert.ok(checkupCall)
    for (const [recall, messageId] of [
      ['the sharing this run coded', BOB_OWN_SHARING],
      ['the keyword search', BOB_REPEATS_CHECKUP],
      ['the semantic index', 20],
    ] as const) {
      assert.ok(checkupCall.candidateIds.includes(messageId), `the candidates include what came from ${recall}`)
    }
    assert.ok(
      !checkupCall.candidateIds.includes(ALICE_CHECKUP_QUESTION),
      'the asker cannot be paired with her own words'
    )

    assert.equal(
      followUpDetails(event(results, `follow_up:${ALICE_LICENCE_QUESTION}`)).initiationInObservedRecord,
      'before_subject_reintroduced',
      'nobody raised the licence again between his mention of it and her question'
    )

    // A question with nothing specific behind it is never counted, and neither is one the matching step lost.
    const vague = event(results, `follow_up:${ALICE_VAGUE_QUESTION}`)
    assert.equal(vague.status, 'uncertain')
    assert.deepEqual(evidenceRoles(vague), [[ALICE_VAGUE_QUESTION, 'core']])
    assert.equal(followUpDetails(vague).matchConfidence, 'uncertain')
    assert.ok(followUpDetails(vague).candidateMessageIds.length > 0, 'the candidates stay for the user to choose from')
    for (const messageId of followUpDetails(vague).candidateMessageIds) {
      assert.ok(results.messages[messageId], 'the page can show every candidate it may offer')
    }

    const unmatchable = event(results, `follow_up:${ALICE_UNMATCHABLE_QUESTION}`)
    assert.equal(unmatchable.status, 'uncertain', 'an answer citing a message nobody offered is not a pair')
    assert.equal(unmatchable.evidence.filter((item) => item.role === 'prior').length, 0)
    assert.equal(
      stub.matches.filter((match) => match.matter === MATTER_REVIEW).length,
      2,
      'the unreadable answer is asked for once more before the question is left open'
    )

    const [alice, bob] = followUpSummary(results)
    assert.deepEqual(alice, {
      memberId: 1,
      pairs: 2,
      matters: 2,
      uncertain: 2,
      beforeReintroduced: 1,
      afterReintroduced: 1,
      initiationUncertain: 0,
    })
    assert.equal(bob?.pairs, 2)
    assert.equal(bob?.uncertain, 0)
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a user can pair a follow-up question by hand and is refused a pair the chat does not show', async () => {
  const { service, manager } = createHarness(null)

  try {
    const created = await service.createUserEvent('private', {
      kind: 'follow_up',
      subjectMemberId: 2,
      coreMessageIds: [BOB_VISIT_QUESTION],
      priorMessageIds: [ALICE_VISIT_PRIOR],
      details: { matter: MATTER_VISIT },
    })

    const paired = event(created, `follow_up:${BOB_VISIT_QUESTION}`)
    assert.equal(paired.origin, 'user')
    assert.equal(paired.status, 'confirmed')
    assert.equal(paired.subjectMemberId, 1, 'the participant who was asked is the subject, not the one who asked')
    assert.equal(paired.otherMemberId, 2)
    assert.deepEqual(evidenceRoles(paired), [
      [ALICE_VISIT_PRIOR, 'prior'],
      [BOB_VISIT_QUESTION, 'core'],
    ])
    assert.equal(followUpDetails(paired).matchConfidence, 'supported')
    assert.equal(followUpDetails(paired).gapSeconds, 60)
    assert.equal(followUpSummary(created)[1]?.pairs, 1)
    assert.equal(followUpSummary(created)[1]?.matters, 1)

    const rejected: Array<[string, number[], string]> = [
      ['an earlier message the asker sent himself', [BOB_OWN_SHARING], MATTER_VISIT],
      ['an earlier message that comes after the question', [ALICE_CHECKUP_QUESTION], MATTER_VISIT],
      ['an earlier message with no readable text', [23], MATTER_VISIT],
      ['no earlier message at all', [], MATTER_VISIT],
      ['no matter to show the pair under', [ALICE_VISIT_PRIOR], '  '],
    ]
    for (const [name, priorMessageIds, matter] of rejected) {
      await assert.rejects(
        () =>
          service.createUserEvent('private', {
            kind: 'follow_up',
            subjectMemberId: 2,
            coreMessageIds: [BOB_DECORATION_QUESTION],
            priorMessageIds,
            details: { matter },
          }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
        name
      )
    }
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a revision points an open follow-up question at the earlier message the user picked', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['sharing', 'follow_up'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const before = await service.getResults('private')
    assert.equal(followUpSummary(before)[0]?.pairs, 2)
    assert.equal(followUpSummary(before)[0]?.uncertain, 2)

    const reviewed = await service.reviewEvent('private', `follow_up:${ALICE_VAGUE_QUESTION}`, {
      decision: 'included',
      expectedRevision: 0,
      details: { priorMessageIds: [BOB_OWN_SHARING] },
    })

    const paired = event(reviewed, `follow_up:${ALICE_VAGUE_QUESTION}`)
    assert.equal(paired.status, 'confirmed')
    assert.deepEqual(evidenceRoles(paired), [
      [BOB_OWN_SHARING, 'prior'],
      [ALICE_VAGUE_QUESTION, 'core'],
    ])
    assert.equal(followUpDetails(paired).matchConfidence, 'supported')
    assert.equal(followUpDetails(paired).priorEventId, `sharing:${BOB_OWN_SHARING}`)
    assert.equal(followUpDetails(paired).gapSeconds, (ALICE_VAGUE_QUESTION - BOB_OWN_SHARING) * 60)

    const [alice] = followUpSummary(reviewed)
    assert.equal(alice?.pairs, 3)
    assert.equal(alice?.uncertain, 1)
    assert.equal(alice?.matters, 2, 'the second question about the same matter does not add a matter')

    await assert.rejects(
      () =>
        service.reviewEvent('private', `follow_up:${ALICE_UNMATCHABLE_QUESTION}`, {
          decision: 'included',
          expectedRevision: 0,
          details: { priorMessageIds: [ALICE_FIRST_SHARING] },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      'the asker cannot be paired with her own earlier words'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})
