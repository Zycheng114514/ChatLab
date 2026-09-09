import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseAdapter } from '@openchatlab/core'
import type {
  IntimacyEventDetails,
  IntimacyEventOrigin,
  IntimacyEventReview,
  IntimacyEvidence,
  IntimacyKind,
  IntimacyModelDecision,
  IntimacyObservation,
  IntimacyReviewDecision,
  IntimacyRun,
} from '@openchatlab/shared-types'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'
import type { IntimacyPreprocessOptions } from './model-protocol'
import { getIntimacyDbPath } from './paths'

const INTIMACY_SCHEMA_VERSION = 1

/** Events created from a user-confirmed candidate belong to no run. */
export const INTIMACY_USER_RUN_ID = ''

interface IntimacyStoreOptions {
  nativeBinding?: string
}

export interface IntimacyExecutionLeaseGuard {
  ownerId: string
  now: number
}

/** One analysis event as it is written to and read back from the result store. */
export interface IntimacyEventRecord {
  id: string
  kind: IntimacyKind
  subjectMemberId: number
  otherMemberId: number
  anchorMessageId: number
  anchorTs: number
  evidence: IntimacyEvidence[]
  observation: IntimacyObservation
  origin: IntimacyEventOrigin
  modelDecision: IntimacyModelDecision | null
  modelReason: string | null
  details: IntimacyEventDetails
  createdAt: number
}

export interface StoredIntimacyEvent extends IntimacyEventRecord {
  sessionId: string
  /** Empty string for user-confirmed events. */
  runId: string
}

export interface StoredIntimacyReview extends IntimacyEventReview {
  eventId: string
}

const RUN_COLUMNS = `id, session_id as sessionId, status, kinds_json as kindsJson, locale, timezone,
  target_start_ts as targetStartTs, target_end_ts as targetEndTs,
  source_signature as sourceSignature, source_message_count as sourceMessageCount,
  source_max_message_id as sourceMaxMessageId,
  total_windows as totalWindows, completed_windows as completedWindows,
  current_window_index as currentWindowIndex, failed_windows_json as failedWindowsJson,
  model_id as modelId, prompt_version as promptVersion, algorithm_version as algorithmVersion,
  input_tokens as inputTokens, output_tokens as outputTokens, model_calls as modelCalls,
  last_error as lastError, created_at as createdAt, updated_at as updatedAt`

const EVENT_COLUMNS = `session_id as sessionId, run_id as runId, id, kind,
  subject_member_id as subjectMemberId, other_member_id as otherMemberId,
  anchor_message_id as anchorMessageId, anchor_ts as anchorTs,
  observation, origin, model_decision as modelDecision, model_reason as modelReason,
  details_json as detailsJson, created_at as createdAt`

interface IntimacyRunRow {
  id: string
  sessionId: string
  status: IntimacyRun['status']
  kindsJson: string
  locale: string | null
  timezone: string
  targetStartTs: number
  targetEndTs: number
  sourceSignature: string
  sourceMessageCount: number
  sourceMaxMessageId: number
  totalWindows: number
  completedWindows: number
  currentWindowIndex: number | null
  failedWindowsJson: string
  modelId: string | null
  promptVersion: string
  algorithmVersion: string
  inputTokens: number
  outputTokens: number
  modelCalls: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

interface IntimacyEventRow {
  sessionId: string
  runId: string
  id: string
  kind: IntimacyKind
  subjectMemberId: number
  otherMemberId: number
  anchorMessageId: number
  anchorTs: number
  observation: IntimacyObservation
  origin: IntimacyEventOrigin
  modelDecision: IntimacyModelDecision | null
  modelReason: string | null
  detailsJson: string
  createdAt: number
}

interface IntimacyEvidenceRow {
  eventId: string
  messageId: number
  timestamp: number
  senderId: number
  role: IntimacyEvidence['role']
}

interface IntimacyReviewRow {
  eventId: string
  decision: IntimacyReviewDecision
  detailsJson: string | null
  revision: number
  updatedAt: number
}

export class IntimacyStore {
  private readonly db: DatabaseAdapter

  constructor(dbPath: string, options: IntimacyStoreOptions = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = openBetterSqliteDatabase(dbPath, { nativeBinding: options.nativeBinding })
    this.db.pragma('foreign_keys = ON')
    this.initialize()
  }

  close(): void {
    this.db.close()
  }

  /** The privacy settings are stored with the run so a resumed analysis redacts exactly what the first window did. */
  createRun(run: IntimacyRun, preprocess: IntimacyPreprocessOptions | null): void {
    this.db
      .prepare(
        `INSERT INTO intimacy_run (
          id, session_id, status, kinds_json, locale, timezone, preprocess_json,
          target_start_ts, target_end_ts,
          source_signature, source_message_count, source_max_message_id,
          total_windows, completed_windows, current_window_index, failed_windows_json,
          model_id, prompt_version, algorithm_version,
          input_tokens, output_tokens, model_calls, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.sessionId,
        run.status,
        JSON.stringify(run.kinds),
        run.locale,
        run.timezone,
        preprocess === null ? null : JSON.stringify(preprocess),
        run.targetStartTs,
        run.targetEndTs,
        run.sourceSignature,
        run.sourceMessageCount,
        run.sourceMaxMessageId,
        run.totalWindows,
        run.completedWindows,
        run.currentWindowIndex,
        JSON.stringify(run.failedWindowIndexes),
        run.modelId,
        run.promptVersion,
        run.algorithmVersion,
        run.inputTokens,
        run.outputTokens,
        run.modelCalls,
        run.lastError,
        run.createdAt,
        run.updatedAt
      )
  }

  updateRun(run: IntimacyRun): void {
    this.db
      .prepare(
        `UPDATE intimacy_run SET
          status = ?, total_windows = ?, completed_windows = ?, current_window_index = ?,
          failed_windows_json = ?, model_id = ?,
          input_tokens = ?, output_tokens = ?, model_calls = ?, last_error = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        run.status,
        run.totalWindows,
        run.completedWindows,
        run.currentWindowIndex,
        JSON.stringify(run.failedWindowIndexes),
        run.modelId,
        run.inputTokens,
        run.outputTokens,
        run.modelCalls,
        run.lastError,
        run.updatedAt,
        run.id
      )
  }

  updateRunIfOwned(run: IntimacyRun, guard: IntimacyExecutionLeaseGuard): boolean {
    return (
      this.db
        .prepare(
          `UPDATE intimacy_run SET
            status = ?, total_windows = ?, completed_windows = ?, current_window_index = ?,
            failed_windows_json = ?, model_id = ?,
            input_tokens = ?, output_tokens = ?, model_calls = ?, last_error = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM intimacy_execution_lease
              WHERE singleton = 1 AND run_id = ? AND owner_id = ? AND expires_at > ?
            )`
        )
        .run(
          run.status,
          run.totalWindows,
          run.completedWindows,
          run.currentWindowIndex,
          JSON.stringify(run.failedWindowIndexes),
          run.modelId,
          run.inputTokens,
          run.outputTokens,
          run.modelCalls,
          run.lastError,
          run.updatedAt,
          run.id,
          run.id,
          guard.ownerId,
          guard.now
        ).changes > 0
    )
  }

  tryAcquireExecutionLease(runId: string, ownerId: string, now: number, expiresAt: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO intimacy_execution_lease (singleton, run_id, owner_id, expires_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             run_id = excluded.run_id,
             owner_id = excluded.owner_id,
             expires_at = excluded.expires_at
           WHERE intimacy_execution_lease.owner_id = excluded.owner_id
              OR intimacy_execution_lease.expires_at <= ?`
        )
        .run(runId, ownerId, expiresAt, now).changes > 0
    )
  }

  renewExecutionLease(runId: string, ownerId: string, expiresAt: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE intimacy_execution_lease SET expires_at = ?
           WHERE singleton = 1 AND run_id = ? AND owner_id = ?`
        )
        .run(expiresAt, runId, ownerId).changes > 0
    )
  }

  ownsExecutionLease(runId: string, ownerId: string, now: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM intimacy_execution_lease
           WHERE singleton = 1 AND run_id = ? AND owner_id = ? AND expires_at > ?`
        )
        .get(runId, ownerId, now)
    )
  }

  hasLiveExecutionForSession(sessionId: string, now: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM intimacy_execution_lease lease
           JOIN intimacy_run run ON run.id = lease.run_id
           WHERE lease.singleton = 1
             AND lease.expires_at > ?
             AND run.session_id = ?
             AND run.status IN ('pending', 'running')`
        )
        .get(now, sessionId)
    )
  }

  releaseExecutionLease(runId: string, ownerId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM intimacy_execution_lease WHERE singleton = 1 AND run_id = ? AND owner_id = ?')
        .run(runId, ownerId).changes > 0
    )
  }

  getRun(runId: string): IntimacyRun | null {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM intimacy_run WHERE id = ?`).get(runId) as
      | IntimacyRunRow
      | undefined
    return row ? mapRunRow(row) : null
  }

  getRunPreprocess(runId: string): IntimacyPreprocessOptions | null {
    const row = this.db
      .prepare('SELECT preprocess_json as preprocessJson FROM intimacy_run WHERE id = ?')
      .get(runId) as { preprocessJson: string | null } | undefined
    return row?.preprocessJson == null ? null : (JSON.parse(row.preprocessJson) as IntimacyPreprocessOptions)
  }

  getLatestRun(sessionId: string): IntimacyRun | null {
    const row = this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM intimacy_run WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sessionId) as IntimacyRunRow | undefined
    return row ? mapRunRow(row) : null
  }

  /** The newest run that produced at least one committed window; a cancelled run keeps its partial results. */
  getLatestRunWithResults(sessionId: string): IntimacyRun | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM intimacy_run
         WHERE session_id = ? AND completed_windows > 0
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(sessionId) as IntimacyRunRow | undefined
    return row ? mapRunRow(row) : null
  }

  getActiveRun(): IntimacyRun | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM intimacy_run
         WHERE status IN ('pending', 'running', 'paused')
         ORDER BY created_at ASC LIMIT 1`
      )
      .get() as IntimacyRunRow | undefined
    return row ? mapRunRow(row) : null
  }

  recoverInterruptedRuns(updatedAt: number): number {
    return this.db.transaction(() => {
      const recovered = this.db
        .prepare(
          `UPDATE intimacy_run SET status = 'paused', last_error = 'Analysis interrupted by application restart', updated_at = ?
           WHERE status IN ('pending', 'running')
             AND NOT EXISTS (
               SELECT 1 FROM intimacy_execution_lease
               WHERE singleton = 1
                 AND run_id = intimacy_run.id
                 AND expires_at > ?
             )`
        )
        .run(updatedAt, updatedAt).changes
      this.db
        .prepare(
          `DELETE FROM intimacy_execution_lease
           WHERE expires_at <= ?
              OR NOT EXISTS (
                SELECT 1 FROM intimacy_run
                WHERE id = intimacy_execution_lease.run_id AND status IN ('pending', 'running')
              )`
        )
        .run(updatedAt)
      return recovered
    })
  }

  /**
   * Commit one window of events. Events already stored under the same run keep their identity: the caller
   * supplies the merged event so a sharing continued across a window boundary stays one event.
   */
  insertWindowEvents(
    sessionId: string,
    runId: string,
    events: IntimacyEventRecord[],
    guard?: IntimacyExecutionLeaseGuard
  ): void {
    this.db.transaction(() => {
      if (guard) this.assertExecutionLease(runId, guard)
      for (const event of events) this.writeEvent(sessionId, runId, event)
    })
  }

  /** Persist a user-confirmed event together with the review that keeps it counted. */
  createUserEvent(sessionId: string, event: IntimacyEventRecord): void {
    this.db.transaction(() => {
      this.writeEvent(sessionId, INTIMACY_USER_RUN_ID, event)
      this.db
        .prepare(
          `INSERT INTO intimacy_event_review (session_id, event_id, decision, details_json, revision, updated_at)
           VALUES (?, ?, 'included', NULL, 1, ?)
           ON CONFLICT(session_id, event_id) DO UPDATE SET
             decision = 'included',
             revision = intimacy_event_review.revision + 1,
             updated_at = excluded.updated_at`
        )
        .run(sessionId, event.id, event.createdAt)
    })
  }

  /** Every kind of one generation; one window call codes all of them, so callers filter what they display. */
  listEvents(sessionId: string, runId: string): StoredIntimacyEvent[] {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM intimacy_event
         WHERE session_id = ? AND run_id = ?
         ORDER BY anchor_ts ASC, anchor_message_id ASC`
      )
      .all(sessionId, runId) as unknown as IntimacyEventRow[]
    if (rows.length === 0) return []
    const evidenceRows = this.db
      .prepare(
        `SELECT event_id as eventId, message_id as messageId, timestamp, sender_id as senderId, role
         FROM intimacy_evidence
         WHERE session_id = ? AND run_id = ?
         ORDER BY message_id ASC`
      )
      .all(sessionId, runId) as unknown as IntimacyEvidenceRow[]
    const evidenceByEvent = new Map<string, IntimacyEvidence[]>()
    for (const evidence of evidenceRows) {
      const items = evidenceByEvent.get(evidence.eventId) ?? []
      items.push({
        messageId: evidence.messageId,
        timestamp: evidence.timestamp,
        senderId: evidence.senderId,
        role: evidence.role,
      })
      evidenceByEvent.set(evidence.eventId, items)
    }
    return rows.map((row) => mapEventRow(row, evidenceByEvent.get(row.id) ?? []))
  }

  /** Optimistic update. Returns null when the caller's expected revision is stale. */
  upsertReview(
    sessionId: string,
    eventId: string,
    decision: IntimacyReviewDecision,
    detailsJson: string | null,
    expectedRevision: number,
    now: number
  ): IntimacyEventReview | null {
    return this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT revision FROM intimacy_event_review WHERE session_id = ? AND event_id = ?')
        .get(sessionId, eventId) as { revision: number } | undefined
      if ((current?.revision ?? 0) !== expectedRevision) return null
      const revision = expectedRevision + 1
      this.db
        .prepare(
          `INSERT INTO intimacy_event_review (session_id, event_id, decision, details_json, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, event_id) DO UPDATE SET
             decision = excluded.decision,
             details_json = excluded.details_json,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        )
        .run(sessionId, eventId, decision, detailsJson, revision, now)
      return { decision, details: parseReviewDetails(detailsJson), revision, updatedAt: now }
    })
  }

  listReviews(sessionId: string): StoredIntimacyReview[] {
    const rows = this.db
      .prepare(
        `SELECT event_id as eventId, decision, details_json as detailsJson, revision, updated_at as updatedAt
         FROM intimacy_event_review WHERE session_id = ?`
      )
      .all(sessionId) as unknown as IntimacyReviewRow[]
    return rows.map((row) => ({
      eventId: row.eventId,
      decision: row.decision,
      details: parseReviewDetails(row.detailsJson),
      revision: row.revision,
      updatedAt: row.updatedAt,
    }))
  }

  /** Drop superseded runs of one session so results always come from a single generation. */
  pruneRuns(sessionId: string, keepRunId: string): number {
    return this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM intimacy_event WHERE session_id = ? AND run_id != '' AND run_id != ?")
        .run(sessionId, keepRunId)
      return this.db.prepare('DELETE FROM intimacy_run WHERE session_id = ? AND id != ?').run(sessionId, keepRunId)
        .changes
    })
  }

  /**
   * Remove generated results. The user's decisions survive unless the caller asks for a full reset: reviews stay
   * attached to their event ids, and events the user confirmed from candidates are decisions too, so they stay.
   */
  deleteSessionResults(sessionId: string, options: { includeReviews: boolean }): boolean {
    return this.db.transaction(() => {
      const events = options.includeReviews
        ? this.db.prepare('DELETE FROM intimacy_event WHERE session_id = ?').run(sessionId).changes
        : this.db.prepare("DELETE FROM intimacy_event WHERE session_id = ? AND run_id != ''").run(sessionId).changes
      const runs = this.db.prepare('DELETE FROM intimacy_run WHERE session_id = ?').run(sessionId).changes
      const reviews = options.includeReviews
        ? this.db.prepare('DELETE FROM intimacy_event_review WHERE session_id = ?').run(sessionId).changes
        : 0
      return events + runs + reviews > 0
    })
  }

  deleteSession(sessionId: string): boolean {
    return this.deleteSessionResults(sessionId, { includeReviews: true })
  }

  private writeEvent(sessionId: string, runId: string, event: IntimacyEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO intimacy_event (
          session_id, run_id, id, kind, subject_member_id, other_member_id,
          anchor_message_id, anchor_ts, observation, origin, model_decision, model_reason,
          details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, run_id, id) DO UPDATE SET
          observation = excluded.observation,
          model_decision = excluded.model_decision,
          model_reason = excluded.model_reason,
          details_json = excluded.details_json`
      )
      .run(
        sessionId,
        runId,
        event.id,
        event.kind,
        event.subjectMemberId,
        event.otherMemberId,
        event.anchorMessageId,
        event.anchorTs,
        event.observation,
        event.origin,
        event.modelDecision,
        event.modelReason,
        JSON.stringify(event.details),
        event.createdAt
      )
    // A continued sharing keeps the evidence role it was first cited with, so core evidence never becomes related.
    const insertEvidence = this.db.prepare(
      `INSERT OR IGNORE INTO intimacy_evidence (session_id, run_id, event_id, message_id, timestamp, sender_id, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const evidence of event.evidence) {
      insertEvidence.run(
        sessionId,
        runId,
        event.id,
        evidence.messageId,
        evidence.timestamp,
        evidence.senderId,
        evidence.role
      )
    }
  }

  private assertExecutionLease(runId: string, guard: IntimacyExecutionLeaseGuard): void {
    const owned = this.db
      .prepare(
        `UPDATE intimacy_execution_lease SET expires_at = expires_at
         WHERE singleton = 1 AND run_id = ? AND owner_id = ? AND expires_at > ?`
      )
      .run(runId, guard.ownerId, guard.now).changes
    if (owned > 0) return
    throw Object.assign(new Error('Intimacy execution lease was lost'), { code: 'INTIMACY_EXECUTION_LEASE_LOST' })
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intimacy_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO intimacy_meta (key, value) VALUES ('schema_version', '${INTIMACY_SCHEMA_VERSION}');
    `)

    const versionRow = this.db.prepare("SELECT value FROM intimacy_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
    const version = Number(versionRow?.value)
    if (!Number.isInteger(version) || version < 1 || version > INTIMACY_SCHEMA_VERSION) {
      throw new Error(`Unsupported intimacy schema version: ${versionRow?.value ?? 'missing'}`)
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intimacy_run (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        locale TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        preprocess_json TEXT,
        target_start_ts INTEGER NOT NULL,
        target_end_ts INTEGER NOT NULL,
        source_signature TEXT NOT NULL,
        source_message_count INTEGER NOT NULL,
        source_max_message_id INTEGER NOT NULL,
        total_windows INTEGER NOT NULL,
        completed_windows INTEGER NOT NULL DEFAULT 0,
        current_window_index INTEGER,
        failed_windows_json TEXT NOT NULL DEFAULT '[]',
        model_id TEXT,
        prompt_version TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        model_calls INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intimacy_execution_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES intimacy_run(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS intimacy_event (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_member_id INTEGER NOT NULL,
        other_member_id INTEGER NOT NULL,
        anchor_message_id INTEGER NOT NULL,
        anchor_ts INTEGER NOT NULL,
        observation TEXT NOT NULL,
        origin TEXT NOT NULL,
        model_decision TEXT,
        model_reason TEXT,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, run_id, id)
      );

      CREATE TABLE IF NOT EXISTS intimacy_evidence (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        event_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id, event_id, message_id),
        FOREIGN KEY (session_id, run_id, event_id) REFERENCES intimacy_event(session_id, run_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS intimacy_event_review (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        details_json TEXT,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_intimacy_run_session ON intimacy_run(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intimacy_event_session_kind ON intimacy_event(session_id, kind, anchor_ts);
    `)
  }
}

export function deleteSessionIntimacy(
  userDataDir: string,
  sessionId: string,
  options: IntimacyStoreOptions = {}
): boolean {
  const dbPath = getIntimacyDbPath(userDataDir)
  if (!fs.existsSync(dbPath)) return false
  const store = new IntimacyStore(dbPath, options)
  try {
    return store.deleteSession(sessionId)
  } finally {
    store.close()
  }
}

export function assertSessionIntimacyIdle(
  userDataDir: string,
  sessionId: string,
  options: IntimacyStoreOptions = {}
): void {
  const dbPath = getIntimacyDbPath(userDataDir)
  if (!fs.existsSync(dbPath)) return
  const store = new IntimacyStore(dbPath, options)
  try {
    const timestamp = Date.now()
    store.recoverInterruptedRuns(timestamp)
    if (!store.hasLiveExecutionForSession(sessionId, timestamp)) return
    throw Object.assign(new Error('Intimacy analysis is running for this session in another runtime'), {
      code: 'INTIMACY_EXECUTION_IN_PROGRESS',
      statusCode: 409,
    })
  } finally {
    store.close()
  }
}

function mapRunRow(row: IntimacyRunRow): IntimacyRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    kinds: parseKinds(row.kindsJson),
    locale: row.locale,
    timezone: row.timezone,
    targetStartTs: row.targetStartTs,
    targetEndTs: row.targetEndTs,
    sourceSignature: row.sourceSignature,
    sourceMessageCount: row.sourceMessageCount,
    sourceMaxMessageId: row.sourceMaxMessageId,
    totalWindows: row.totalWindows,
    completedWindows: row.completedWindows,
    currentWindowIndex: row.currentWindowIndex,
    failedWindowIndexes: parseWindowIndexes(row.failedWindowsJson),
    modelId: row.modelId,
    promptVersion: row.promptVersion,
    algorithmVersion: row.algorithmVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    modelCalls: row.modelCalls,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapEventRow(row: IntimacyEventRow, evidence: IntimacyEvidence[]): StoredIntimacyEvent {
  return {
    sessionId: row.sessionId,
    runId: row.runId,
    id: row.id,
    kind: row.kind,
    subjectMemberId: row.subjectMemberId,
    otherMemberId: row.otherMemberId,
    anchorMessageId: row.anchorMessageId,
    anchorTs: row.anchorTs,
    evidence,
    observation: row.observation,
    origin: row.origin,
    modelDecision: row.modelDecision,
    modelReason: row.modelReason,
    details: JSON.parse(row.detailsJson) as IntimacyEventDetails,
    createdAt: row.createdAt,
  }
}

function parseKinds(value: string): IntimacyKind[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid intimacy run kinds payload')
  }
  return parsed as IntimacyKind[]
}

function parseWindowIndexes(value: string): number[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item))) {
    throw new Error('Invalid intimacy run window index payload')
  }
  return parsed as number[]
}

function parseReviewDetails(value: string | null): IntimacyEventReview['details'] {
  return value === null ? null : (JSON.parse(value) as IntimacyEventReview['details'])
}
