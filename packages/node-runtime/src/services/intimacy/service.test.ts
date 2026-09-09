import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type PathProvider } from '@openchatlab/core'
import type {
  CreateIntimacyEventRequest,
  CreateSharedPlanDetails,
  FollowUpDetails,
  GoodNewsResponseDetails,
  IntimacyEvent,
  IntimacyFollowUpMemberSummary,
  IntimacyKind,
  IntimacyMemberSummary,
  IntimacyResponseMemberSummary,
  IntimacyResults,
  SharedPlanDetails,
  SharedPlanStage,
  SharedPlanSummary,
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
const MESSAGE_COUNT = 81

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

/** Long enough to end the window it lands in, so the arrangements after it start a window of their own. */
const WINDOW_BREAK_BEFORE_PLANS = 62
/** One arrangement proposed, discussed and agreed inside a single window. */
const ALICE_EXHIBITION_PROPOSAL = 63
const BOB_EXHIBITION_QUESTION = 64
const ALICE_EXHIBITION_TICKETS = 65
const BOB_EXHIBITION_AGREES = 66
/** One arrangement moved twice before it is agreed. */
const ALICE_HOTPOT_PROPOSAL = 67
const BOB_HOTPOT_MOVES_IT = 68
const ALICE_HOTPOT_MOVES_IT_AGAIN = 69
const BOB_HOTPOT_AGREES = 70
/** One arrangement called off and then agreed after all. */
const ALICE_PARENTS_PROPOSAL = 71
const BOB_PARENTS_CALLS_OFF = 72
const ALICE_PARENTS_BOOKS_TICKETS = 73
const BOB_PARENTS_AGREES = 74
/** Proposed at the end of its window, so the look back on it only arrives as the next window opens. */
const ALICE_HIKE_PROPOSAL = 75
const BOB_HIKE_LOOKBACK = 76
const WINDOW_BREAK_BEFORE_LATER_STAGES = 77
/** Later stages with no proposal in their window: one belongs to an earlier plan, one to nothing coded. */
const BOB_EXHIBITION_LOOKBACK = 78
const ALICE_BADMINTON_LOOKBACK = 79
/** Two months on, the same activity is arranged again: another arrangement, not the old one moved. */
const BOB_SECOND_HOTPOT_PROPOSAL = 80
const ALICE_SECOND_HOTPOT_AGREES = 81
const SECOND_HOTPOT_TS = baseTs + 45 * 24 * 60 * 60

const PLAN_EXHIBITION = '周六下午看摄影展'
const PLAN_HOTPOT = '一起吃火锅'
const PLAN_PARENTS = '周末回家看爸妈'
const PLAN_HIKE = '周日爬山'
const PLAN_BADMINTON = '打羽毛球'

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

  const filler = `${'闲聊 filler '.repeat(40)}`
  const written = new Map<number, { type: number; content: string | null; ts?: number }>([
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
    [WINDOW_BREAK_BEFORE_PLANS, { type: 0, content: filler.repeat(13) }],
    [ALICE_EXHIBITION_PROPOSAL, { type: 0, content: '周六去看那个摄影展吧' }],
    [BOB_EXHIBITION_QUESTION, { type: 0, content: '几点的票？下午还是晚上' }],
    [ALICE_EXHIBITION_TICKETS, { type: 0, content: '下午三点场，我买两张' }],
    [BOB_EXHIBITION_AGREES, { type: 0, content: '好，那就周六下午三点' }],
    [ALICE_HOTPOT_PROPOSAL, { type: 0, content: '下周三一起去吃那家火锅' }],
    [BOB_HOTPOT_MOVES_IT, { type: 0, content: '下周三我有事，改成周四行吗' }],
    [ALICE_HOTPOT_MOVES_IT_AGAIN, { type: 0, content: '周四我也不行，那改周五吧' }],
    [BOB_HOTPOT_AGREES, { type: 0, content: '周五可以，就周五' }],
    [ALICE_PARENTS_PROPOSAL, { type: 0, content: '这周末回家看爸妈吧' }],
    [BOB_PARENTS_CALLS_OFF, { type: 0, content: '这周末算了，我实在走不开' }],
    [ALICE_PARENTS_BOOKS_TICKETS, { type: 0, content: '我把车票订了，我们还是去吧' }],
    [BOB_PARENTS_AGREES, { type: 0, content: '行，就按你订的走' }],
    [ALICE_HIKE_PROPOSAL, { type: 0, content: '周日一起去爬山吧，早上八点出发' }],
    [BOB_HIKE_LOOKBACK, { type: 0, content: `昨天爬山回来腿还酸，风景是真好。${filler.repeat(13)}` }],
    [WINDOW_BREAK_BEFORE_LATER_STAGES, { type: 0, content: filler.repeat(13) }],
    [BOB_EXHIBITION_LOOKBACK, { type: 0, content: '上次那个摄影展的票根我还留着' }],
    [ALICE_BADMINTON_LOOKBACK, { type: 0, content: '羽毛球那次真的太累了' }],
    [BOB_SECOND_HOTPOT_PROPOSAL, { type: 0, content: '下个月再去那家火锅店吧', ts: SECOND_HOTPOT_TS }],
    [ALICE_SECOND_HOTPOT_AGREES, { type: 0, content: '好啊，那就下个月', ts: SECOND_HOTPOT_TS + 60 }],
  ])
  const insert = db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let id = 1; id <= MESSAGE_COUNT; id += 1) {
      const custom = written.get(id)
      insert.run(
        id,
        id % 2 === 1 ? 1 : 2,
        custom?.ts ?? baseTs + id * 60,
        custom?.type ?? 0,
        custom ? custom.content : `${filler}${id}`
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

/** One association call for an arrangement: what the new messages are about and the plans offered for them. */
interface PromptPlanMatch {
  activity: string
  candidateEventIds: string[]
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

function readPlanMatch(userPrompt: string): PromptPlanMatch {
  const activity = /The new messages are about: (.*)/.exec(userPrompt)
  assert.ok(activity)
  const candidateEventIds = [...userPrompt.matchAll(/^Plan (\S+) —/gm)].map((match) => match[1]!)
  return { activity: activity[1]!, candidateEventIds }
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

function sharedPlanEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'shared_plan',
    continuesContextEvent: false,
    confidence: 'clear',
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
  events.push(...sharedPlanEvents(own, asContext))
  return JSON.stringify({ events })
}

/**
 * The arrangements the windows show: one proposed, discussed and agreed on the spot, one moved twice before it is
 * agreed, one called off and then agreed after all, one whose look back only arrives in the next window, two later
 * stages with no proposal of their own, and the same activity arranged again two months on.
 */
function sharedPlanEvents(own: (id: number) => boolean, asContext: (id: number) => boolean): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  if (own(ALICE_EXHIBITION_PROPOSAL)) {
    events.push(
      sharedPlanEvent({
        proposer: 'A',
        coreMessageIds: [ALICE_EXHIBITION_PROPOSAL],
        activitySummary: PLAN_EXHIBITION,
        stages: [
          { stage: 'proposed', actor: 'A', messageIds: [ALICE_EXHIBITION_PROPOSAL] },
          { stage: 'discussed', actor: 'B', messageIds: [BOB_EXHIBITION_QUESTION] },
          {
            stage: 'mutually_confirmed',
            actor: 'B',
            messageIds: [ALICE_EXHIBITION_TICKETS, BOB_EXHIBITION_AGREES],
          },
        ],
      }),
      sharedPlanEvent({
        proposer: 'A',
        coreMessageIds: [ALICE_HOTPOT_PROPOSAL],
        activitySummary: PLAN_HOTPOT,
        stages: [
          { stage: 'proposed', actor: 'A', messageIds: [ALICE_HOTPOT_PROPOSAL] },
          { stage: 'rescheduled', actor: 'B', messageIds: [BOB_HOTPOT_MOVES_IT] },
          { stage: 'rescheduled', actor: 'A', messageIds: [ALICE_HOTPOT_MOVES_IT_AGAIN] },
          {
            stage: 'mutually_confirmed',
            actor: 'B',
            messageIds: [ALICE_HOTPOT_MOVES_IT_AGAIN, BOB_HOTPOT_AGREES],
          },
        ],
      }),
      sharedPlanEvent({
        proposer: 'A',
        coreMessageIds: [ALICE_PARENTS_PROPOSAL],
        activitySummary: PLAN_PARENTS,
        stages: [
          { stage: 'proposed', actor: 'A', messageIds: [ALICE_PARENTS_PROPOSAL] },
          { stage: 'cancelled', actor: 'B', messageIds: [BOB_PARENTS_CALLS_OFF] },
          { stage: 'discussed', actor: 'A', messageIds: [ALICE_PARENTS_BOOKS_TICKETS] },
          {
            stage: 'mutually_confirmed',
            actor: 'B',
            messageIds: [ALICE_PARENTS_BOOKS_TICKETS, BOB_PARENTS_AGREES],
          },
        ],
      })
    )
  }
  if (own(ALICE_HIKE_PROPOSAL)) {
    events.push(
      sharedPlanEvent({
        proposer: 'A',
        coreMessageIds: [ALICE_HIKE_PROPOSAL],
        activitySummary: PLAN_HIKE,
        stages: [{ stage: 'proposed', actor: 'A', messageIds: [ALICE_HIKE_PROPOSAL] }],
      })
    )
  }
  if (asContext(ALICE_HIKE_PROPOSAL) && own(BOB_HIKE_LOOKBACK)) {
    events.push(
      sharedPlanEvent({
        activitySummary: PLAN_HIKE,
        continuesContextEvent: true,
        stages: [{ stage: 'retrospective_mentioned', actor: 'B', messageIds: [BOB_HIKE_LOOKBACK] }],
      })
    )
  }
  // Neither of these two windows shows the arrangement being made: the association step has to place them.
  if (own(BOB_EXHIBITION_LOOKBACK)) {
    events.push(
      sharedPlanEvent({
        activitySummary: PLAN_EXHIBITION,
        stages: [{ stage: 'retrospective_mentioned', actor: 'B', messageIds: [BOB_EXHIBITION_LOOKBACK] }],
      })
    )
  }
  if (own(ALICE_BADMINTON_LOOKBACK)) {
    events.push(
      sharedPlanEvent({
        activitySummary: PLAN_BADMINTON,
        stages: [{ stage: 'retrospective_mentioned', actor: 'A', messageIds: [ALICE_BADMINTON_LOOKBACK] }],
      })
    )
  }
  if (own(BOB_SECOND_HOTPOT_PROPOSAL)) {
    events.push(
      sharedPlanEvent({
        proposer: 'B',
        coreMessageIds: [BOB_SECOND_HOTPOT_PROPOSAL],
        activitySummary: PLAN_HOTPOT,
        stages: [
          { stage: 'proposed', actor: 'B', messageIds: [BOB_SECOND_HOTPOT_PROPOSAL] },
          {
            stage: 'mutually_confirmed',
            actor: 'A',
            messageIds: [BOB_SECOND_HOTPOT_PROPOSAL, ALICE_SECOND_HOTPOT_AGREES],
          },
        ],
      })
    )
  }
  return events
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

/** The look back on the exhibition belongs to the arrangement that was made for it; the badminton one to nothing. */
function defaultPlanMatchResponse(match: PromptPlanMatch): string {
  if (match.activity === PLAN_EXHIBITION) {
    return JSON.stringify({ planEventId: `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`, match: 'supported' })
  }
  return JSON.stringify({ planEventId: null, match: 'uncertain' })
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
  matchRespond: (match: PromptMatch) => string = defaultMatchResponse,
  planMatchRespond: (match: PromptPlanMatch) => string = defaultPlanMatchResponse
): {
  client: ChatTopicModelClient
  windows: number[]
  matches: PromptMatch[]
  planMatches: PromptPlanMatch[]
} {
  const windows: number[] = []
  const matches: PromptMatch[] = []
  const planMatches: PromptPlanMatch[] = []
  let calls = 0
  return {
    windows,
    matches,
    planMatches,
    client: {
      modelId: 'test/model',
      async complete(prompts) {
        calls += 1
        // Every step reuses the same client, so the stub answers whichever prompt it was given.
        if (prompts.userPrompt.includes('The new messages are about: ')) {
          const match = readPlanMatch(prompts.userPrompt)
          planMatches.push(match)
          return { text: planMatchRespond(match), inputTokens: 3, outputTokens: 2 }
        }
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

function sharedPlanDetails(event: IntimacyEvent): SharedPlanDetails {
  assert.ok(event.details.kind === 'shared_plan')
  return event.details
}

/** The timeline of an arrangement as the card would read it: what happened, who did it, and where it is said. */
function planStages(event: IntimacyEvent): Array<[SharedPlanStage, number, number[]]> {
  return sharedPlanDetails(event).stages.map((stage) => [stage.stage, stage.actorMemberId, stage.messageIds])
}

function sharedPlanSummary(results: IntimacyResults): SharedPlanSummary {
  const summary = results.summaries.find((item) => item.kind === 'shared_plan')
  assert.ok(summary?.kind === 'shared_plan')
  return summary
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
    assert.equal(run.modelCalls, run.totalWindows + stub.matches.length + stub.planMatches.length)
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
      ['a reply with no label at all', [ALICE_DECORATION_PRIOR], []],
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
      run.totalWindows + 1 + stub.matches.length + stub.planMatches.length,
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

test('group chats, unknown kinds and a missing LLM are refused before any model call', async () => {
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
      () => withoutLlm.service.preflight('private', { kinds: ['reconciliation' as IntimacyKind] }),
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
      ['no matter to show the pair under', [ALICE_DECORATION_PRIOR], '  '],
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

test('a run keeps one arrangement per plan, with every stage it went through', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['shared_plan'] })
    const run = await waitForRun(service, 'private', started.id, 'completed')
    assert.deepEqual(run.failedWindowIndexes, [])
    assert.equal(
      run.modelCalls,
      run.totalWindows + stub.matches.length + stub.planMatches.length,
      'one call per window, plus the calls that place a question or a stage in what came before'
    )

    const results = await service.getResults('private')
    assert.deepEqual(
      results.events.filter((item) => item.kind === 'shared_plan').map((item) => item.id),
      [
        `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`,
        `shared_plan:${ALICE_HOTPOT_PROPOSAL}`,
        `shared_plan:${ALICE_PARENTS_PROPOSAL}`,
        `shared_plan:${ALICE_HIKE_PROPOSAL}`,
        `shared_plan:${ALICE_BADMINTON_LOOKBACK}`,
        `shared_plan:${BOB_SECOND_HOTPOT_PROPOSAL}`,
      ]
    )

    const exhibition = event(results, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)
    assert.equal(exhibition.subjectMemberId, 1, 'the participant who proposed it is the subject')
    assert.equal(exhibition.otherMemberId, 2)
    assert.equal(exhibition.status, 'auto')
    assert.deepEqual(planStages(exhibition), [
      ['proposed', 1, [ALICE_EXHIBITION_PROPOSAL]],
      ['discussed', 2, [BOB_EXHIBITION_QUESTION]],
      ['mutually_confirmed', 2, [ALICE_EXHIBITION_TICKETS, BOB_EXHIBITION_AGREES]],
      ['retrospective_mentioned', 2, [BOB_EXHIBITION_LOOKBACK]],
    ])
    assert.equal(sharedPlanDetails(exhibition).activitySummary, PLAN_EXHIBITION)
    assert.equal(sharedPlanDetails(exhibition).lastObservedStage, 'retrospective_mentioned')
    assert.equal(sharedPlanDetails(exhibition).priorCoverage, 'covered')
    assert.deepEqual(
      evidenceRoles(exhibition),
      [
        [ALICE_EXHIBITION_PROPOSAL, 'core'],
        [BOB_EXHIBITION_QUESTION, 'stage'],
        [ALICE_EXHIBITION_TICKETS, 'stage'],
        [BOB_EXHIBITION_AGREES, 'stage'],
        [BOB_EXHIBITION_LOOKBACK, 'stage'],
      ],
      'the proposal anchors the arrangement and every later stage is evidence of it'
    )

    const hotpot = event(results, `shared_plan:${ALICE_HOTPOT_PROPOSAL}`)
    assert.deepEqual(
      planStages(hotpot),
      [
        ['proposed', 1, [ALICE_HOTPOT_PROPOSAL]],
        ['rescheduled', 2, [BOB_HOTPOT_MOVES_IT]],
        ['rescheduled', 1, [ALICE_HOTPOT_MOVES_IT_AGAIN]],
        ['mutually_confirmed', 2, [ALICE_HOTPOT_MOVES_IT_AGAIN, BOB_HOTPOT_AGREES]],
      ],
      'an arrangement moved twice is still one arrangement'
    )

    const parents = event(results, `shared_plan:${ALICE_PARENTS_PROPOSAL}`)
    assert.deepEqual(
      planStages(parents),
      [
        ['proposed', 1, [ALICE_PARENTS_PROPOSAL]],
        ['cancelled', 2, [BOB_PARENTS_CALLS_OFF]],
        ['discussed', 1, [ALICE_PARENTS_BOOKS_TICKETS]],
        ['mutually_confirmed', 2, [ALICE_PARENTS_BOOKS_TICKETS, BOB_PARENTS_AGREES]],
      ],
      'calling something off and settling it after all is one timeline, not two arrangements'
    )
    assert.equal(sharedPlanDetails(parents).lastObservedStage, 'mutually_confirmed')
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a look back that only arrives in the next window joins the arrangement it belongs to', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['shared_plan'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private')

    const hike = event(results, `shared_plan:${ALICE_HIKE_PROPOSAL}`)
    assert.deepEqual(planStages(hike), [
      ['proposed', 1, [ALICE_HIKE_PROPOSAL]],
      ['retrospective_mentioned', 2, [BOB_HIKE_LOOKBACK]],
    ])
    assert.equal(
      results.events.filter((item) => item.id === `shared_plan:${BOB_HIKE_LOOKBACK}`).length,
      0,
      'the look back joins the arrangement it continues instead of opening a second one'
    )
    assert.deepEqual(
      stub.planMatches.map((match) => match.activity),
      [PLAN_EXHIBITION, PLAN_BADMINTON],
      'an arrangement the window still carries as context is placed without paying for a model call'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a stage with no proposal of its own joins an earlier arrangement, or stands alone when none is found', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['shared_plan'] })
    await waitForRun(service, 'private', started.id, 'completed')
    const results = await service.getResults('private')

    assert.deepEqual(
      stub.planMatches.map((match) => match.candidateEventIds),
      [
        [
          `shared_plan:${ALICE_HIKE_PROPOSAL}`,
          `shared_plan:${ALICE_PARENTS_PROPOSAL}`,
          `shared_plan:${ALICE_HOTPOT_PROPOSAL}`,
          `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`,
        ],
        [
          `shared_plan:${ALICE_HIKE_PROPOSAL}`,
          `shared_plan:${ALICE_PARENTS_PROPOSAL}`,
          `shared_plan:${ALICE_HOTPOT_PROPOSAL}`,
          `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`,
        ],
      ],
      'only the arrangements this run already coded are offered, most recent first'
    )

    const badminton = event(results, `shared_plan:${ALICE_BADMINTON_LOOKBACK}`)
    assert.equal(sharedPlanDetails(badminton).proposerMemberId, null, 'nobody is guessed to have proposed it')
    assert.equal(sharedPlanDetails(badminton).priorCoverage, 'not_covered')
    assert.equal(badminton.subjectMemberId, 1, 'the participant who looked back on it stands in for the proposer')
    assert.deepEqual(planStages(badminton), [['retrospective_mentioned', 1, [ALICE_BADMINTON_LOOKBACK]]])

    const laterHotpot = event(results, `shared_plan:${BOB_SECOND_HOTPOT_PROPOSAL}`)
    assert.equal(sharedPlanDetails(laterHotpot).proposerMemberId, 2)
    assert.deepEqual(planStages(laterHotpot), [
      ['proposed', 2, [BOB_SECOND_HOTPOT_PROPOSAL]],
      ['mutually_confirmed', 1, [BOB_SECOND_HOTPOT_PROPOSAL, ALICE_SECOND_HOTPOT_AGREES]],
    ])
    assert.deepEqual(
      planStages(event(results, `shared_plan:${ALICE_HOTPOT_PROPOSAL}`)).map((stage) => stage[0]),
      ['proposed', 'rescheduled', 'rescheduled', 'mutually_confirmed'],
      'the same activity arranged again six weeks later is its own arrangement, not the first one moved'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('shared plan counts separate what was newly proposed from what only moved, and a past view stops where it ended', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['shared_plan'] })
    await waitForRun(service, 'private', started.id, 'completed')

    const results = await service.getResults('private')
    const summary = sharedPlanSummary(results)
    assert.deepEqual(summary, {
      kind: 'shared_plan',
      newlyProposed: 5,
      updatedInRange: 6,
      byLastStage: {
        proposed: 0,
        discussed: 0,
        mutually_confirmed: 3,
        rescheduled: 0,
        cancelled: 0,
        retrospective_mentioned: 3,
      },
      proposedBy: { 1: 4, 2: 1 },
      confirmedBy: { 1: 1, 2: 3 },
    })
    assert.equal(
      Object.values(summary.byLastStage).reduce((sum, count) => sum + count, 0),
      results.events.filter((item) => item.kind === 'shared_plan').length,
      'every arrangement on the list stands somewhere, and stands there once'
    )

    // A view that ends the day the visit home was called off knows nothing of it being settled afterwards.
    const early = await service.getResults('private', { endTs: baseTs + BOB_PARENTS_CALLS_OFF * 60 })
    assert.deepEqual(
      early.events.filter((item) => item.kind === 'shared_plan').map((item) => item.id),
      [
        `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`,
        `shared_plan:${ALICE_HOTPOT_PROPOSAL}`,
        `shared_plan:${ALICE_PARENTS_PROPOSAL}`,
      ]
    )
    assert.equal(
      sharedPlanDetails(event(early, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)).lastObservedStage,
      'mutually_confirmed',
      'the look back weeks later does not leak into a view of the day it was settled'
    )
    assert.deepEqual(
      planStages(event(early, `shared_plan:${ALICE_PARENTS_PROPOSAL}`)).map((stage) => stage[0]),
      ['proposed', 'cancelled']
    )
    assert.equal(sharedPlanSummary(early).newlyProposed, 3)
    assert.equal(sharedPlanSummary(early).updatedInRange, 3)
    assert.equal(sharedPlanSummary(early).byLastStage.cancelled, 1)

    // A view of the last few days lists an arrangement made earlier, because it moved inside the range.
    const late = await service.getResults('private', { startTs: baseTs + BOB_EXHIBITION_LOOKBACK * 60 })
    assert.deepEqual(
      late.events.filter((item) => item.kind === 'shared_plan').map((item) => item.id),
      [
        `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`,
        `shared_plan:${ALICE_BADMINTON_LOOKBACK}`,
        `shared_plan:${BOB_SECOND_HOTPOT_PROPOSAL}`,
      ]
    )
    assert.equal(sharedPlanSummary(late).updatedInRange, 3)
    assert.equal(
      sharedPlanSummary(late).newlyProposed,
      1,
      'an arrangement proposed before the range only counts as one that moved inside it'
    )
  } finally {
    service.close()
    manager.closeAll()
  }
})

test('a user can confirm an arrangement by hand and is refused one the chat does not show', async () => {
  const { service, manager } = createHarness(null)
  const stages = [
    { stage: 'proposed' as const, actorMemberId: 1, messageIds: [ALICE_EXHIBITION_PROPOSAL] },
    { stage: 'discussed' as const, actorMemberId: 2, messageIds: [BOB_EXHIBITION_QUESTION] },
    {
      stage: 'mutually_confirmed' as const,
      actorMemberId: 2,
      messageIds: [ALICE_EXHIBITION_TICKETS, BOB_EXHIBITION_AGREES],
    },
  ]

  try {
    const created = await service.createUserEvent('private', {
      kind: 'shared_plan',
      subjectMemberId: 1,
      coreMessageIds: [ALICE_EXHIBITION_PROPOSAL],
      details: { activitySummary: PLAN_EXHIBITION, stages },
    })

    const plan = event(created, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)
    assert.equal(plan.origin, 'user')
    assert.equal(plan.status, 'confirmed')
    assert.equal(plan.runId, null)
    assert.deepEqual(evidenceRoles(plan), [
      [ALICE_EXHIBITION_PROPOSAL, 'core'],
      [BOB_EXHIBITION_QUESTION, 'stage'],
      [ALICE_EXHIBITION_TICKETS, 'stage'],
      [BOB_EXHIBITION_AGREES, 'stage'],
    ])
    assert.equal(sharedPlanDetails(plan).lastObservedStage, 'mutually_confirmed')
    assert.equal(sharedPlanDetails(plan).priorCoverage, 'covered')
    assert.equal(sharedPlanSummary(created).newlyProposed, 1)
    assert.equal(sharedPlanSummary(created).byLastStage.mutually_confirmed, 1)
    assert.deepEqual(sharedPlanSummary(created).proposedBy, { 1: 1, 2: 0 })
    assert.deepEqual(sharedPlanSummary(created).confirmedBy, { 1: 0, 2: 1 })

    // Confirming the same proposal again says where the arrangement stands now, it does not arrange it twice.
    const again = await service.createUserEvent('private', {
      kind: 'shared_plan',
      subjectMemberId: 1,
      coreMessageIds: [ALICE_EXHIBITION_PROPOSAL],
      details: {
        activitySummary: PLAN_EXHIBITION,
        stages: [stages[0]!, { stage: 'cancelled', actorMemberId: 2, messageIds: [BOB_PARENTS_CALLS_OFF] }],
      },
    })
    assert.equal(again.events.filter((item) => item.kind === 'shared_plan').length, 1)
    assert.equal(
      sharedPlanDetails(event(again, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)).lastObservedStage,
      'cancelled'
    )
    assert.equal(sharedPlanSummary(again).byLastStage.cancelled, 1)
    assert.equal(sharedPlanSummary(again).byLastStage.mutually_confirmed, 0)
    assert.equal(sharedPlanSummary(again).updatedInRange, 1)

    service.clearResults('private', { includeReviews: false })
    const kept = await service.getResults('private')
    assert.equal(kept.events.length, 1, 'an arrangement the user confirmed is a decision, not a generated result')
    assert.equal(service.clearResults('private', { includeReviews: true }), true)
    assert.equal((await service.getResults('private')).events.length, 0, 'a full reset does throw it away')

    const rejected: Array<[string, Partial<CreateIntimacyEventRequest> & { details: CreateSharedPlanDetails }]> = [
      [
        'a mutual confirmation only one of them took part in',
        {
          coreMessageIds: [ALICE_PARENTS_PROPOSAL],
          details: {
            activitySummary: PLAN_PARENTS,
            stages: [
              { stage: 'proposed', actorMemberId: 1, messageIds: [ALICE_PARENTS_PROPOSAL] },
              { stage: 'mutually_confirmed', actorMemberId: 2, messageIds: [BOB_PARENTS_AGREES] },
            ],
          },
        },
      ],
      [
        'a proposal the other participant sent',
        {
          coreMessageIds: [BOB_HOTPOT_MOVES_IT],
          details: {
            activitySummary: PLAN_HOTPOT,
            stages: [{ stage: 'proposed', actorMemberId: 2, messageIds: [BOB_HOTPOT_MOVES_IT] }],
          },
        },
      ],
      [
        'a stage the participant acting never sent',
        {
          coreMessageIds: [ALICE_PARENTS_PROPOSAL],
          details: {
            activitySummary: PLAN_PARENTS,
            stages: [
              { stage: 'proposed', actorMemberId: 1, messageIds: [ALICE_PARENTS_PROPOSAL] },
              { stage: 'cancelled', actorMemberId: 1, messageIds: [BOB_PARENTS_CALLS_OFF] },
            ],
          },
        },
      ],
      [
        'a proposal that is not one of the stages',
        {
          coreMessageIds: [ALICE_PARENTS_PROPOSAL],
          details: {
            activitySummary: PLAN_PARENTS,
            stages: [{ stage: 'cancelled', actorMemberId: 2, messageIds: [BOB_PARENTS_CALLS_OFF] }],
          },
        },
      ],
      [
        'an arrangement with no stage at all',
        { coreMessageIds: [ALICE_PARENTS_PROPOSAL], details: { activitySummary: PLAN_PARENTS, stages: [] } },
      ],
      [
        'an unknown stage',
        {
          coreMessageIds: [ALICE_PARENTS_PROPOSAL],
          details: {
            activitySummary: PLAN_PARENTS,
            stages: [{ stage: 'agreed' as SharedPlanStage, actorMemberId: 1, messageIds: [ALICE_PARENTS_PROPOSAL] }],
          },
        },
      ],
      [
        'an arrangement with no activity to name it by',
        {
          coreMessageIds: [ALICE_PARENTS_PROPOSAL],
          details: {
            activitySummary: '  ',
            stages: [{ stage: 'proposed', actorMemberId: 1, messageIds: [ALICE_PARENTS_PROPOSAL] }],
          },
        },
      ],
    ]
    for (const [name, request] of rejected) {
      await assert.rejects(
        () =>
          service.createUserEvent('private', {
            kind: 'shared_plan',
            subjectMemberId: 1,
            coreMessageIds: [],
            ...request,
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

test('a revision says where an arrangement stands and survives the next analysis', async () => {
  const stub = modelStub((window) => defaultWindowResponse(window))
  const { service, manager, advance } = createHarness(stub.client)

  try {
    const started = service.start('private', { kinds: ['shared_plan'] })
    await waitForRun(service, 'private', started.id, 'completed')

    const reviewed = await service.reviewEvent('private', `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`, {
      decision: 'included',
      expectedRevision: 0,
      details: { lastObservedStage: 'cancelled' },
    })
    const exhibition = event(reviewed, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)
    assert.equal(exhibition.status, 'confirmed')
    assert.equal(sharedPlanDetails(exhibition).lastObservedStage, 'cancelled')
    assert.deepEqual(
      planStages(exhibition).map((stage) => stage[0]),
      ['proposed', 'discussed', 'mutually_confirmed', 'retrospective_mentioned'],
      'the stages are evidence: saying where it stands does not rewrite what was said'
    )
    assert.equal(sharedPlanSummary(reviewed).byLastStage.cancelled, 1)
    assert.equal(sharedPlanSummary(reviewed).byLastStage.retrospective_mentioned, 2)
    assert.equal(sharedPlanSummary(reviewed).updatedInRange, 6, 'a revision does not add or remove an arrangement')

    await assert.rejects(
      () =>
        service.reviewEvent('private', `shared_plan:${ALICE_HOTPOT_PROPOSAL}`, {
          decision: 'included',
          expectedRevision: 0,
          details: { lastObservedStage: 'agreed' as SharedPlanStage },
        }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      'where an arrangement stands is one of the six stages, not free text'
    )

    advance(60_000)
    const second = service.start('private', { kinds: ['shared_plan'] })
    await waitForRun(service, 'private', second.id, 'completed')
    const rerun = await service.getResults('private')
    assert.equal(
      sharedPlanDetails(event(rerun, `shared_plan:${ALICE_EXHIBITION_PROPOSAL}`)).lastObservedStage,
      'cancelled'
    )
    assert.equal(rerun.orphanReviews, 0)
  } finally {
    service.close()
    manager.closeAll()
  }
})
