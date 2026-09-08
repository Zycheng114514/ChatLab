/**
 * Which language a session is spoken in, used to pick Whisper's language token.
 *
 * Transformers.js 4.2.0 has no language detection: with no language token it
 * warns and transcribes as English, so a Chinese voice message comes back as
 * nonsense English. The caller has to decide before the audio reaches the model,
 * and the only signal available without listening to it is the text already in
 * the chat — a good one, because a chat log is written in the language its
 * participants speak.
 *
 * Deliberately a character-ratio count and not word segmentation: the answer is
 * a two-way choice on hundreds of messages, and the two scripts do not overlap.
 */

import { MessageType } from '@openchatlab/shared-types'
import type { DatabaseAdapter } from '../interfaces'
import { hasTable } from './filters'

/** What the user asked for; `auto` is resolved against the session's messages. */
export type TranscriptionLanguage = 'auto' | 'zh' | 'en'

/** What Whisper is actually told. */
export type ResolvedTranscriptionLanguage = 'zh' | 'en'

/** Messages sampled for the decision; recent ones describe how the chat reads today. */
const SAMPLE_SIZE = 300

/**
 * Chinese, Japanese and Korean text runs far fewer characters than the Latin
 * transcription of the same speech, so a fifth of the characters being CJK
 * already means the chat is not an English one.
 */
const CJK_RATIO_THRESHOLD = 0.2

const CJK_CHAR_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu
const LATIN_LETTER_REGEX = /\p{Script=Latin}/gu

/**
 * Guess the session's spoken language from its text messages.
 *
 * Falls back to `en` for a session with no text at all — that is what Whisper
 * would have done anyway, and it keeps an empty session from failing.
 */
export function detectSessionLanguage(db: DatabaseAdapter): ResolvedTranscriptionLanguage {
  if (!hasTable(db, 'message')) return 'en'

  const rows = db
    .prepare(
      `SELECT content
         FROM message
        WHERE type = ${MessageType.TEXT} AND content IS NOT NULL AND TRIM(content) <> ''
        ORDER BY ts DESC
        LIMIT ${SAMPLE_SIZE}`
    )
    .all() as unknown as Array<{ content: string }>

  let cjk = 0
  let latin = 0
  for (const row of rows) {
    cjk += countMatches(row.content, CJK_CHAR_REGEX)
    latin += countMatches(row.content, LATIN_LETTER_REGEX)
  }

  const total = cjk + latin
  if (total === 0) return 'en'
  return cjk / total >= CJK_RATIO_THRESHOLD ? 'zh' : 'en'
}

/** Resolve `auto` once, at the entry point, so Whisper never sees it. */
export function resolveTranscriptionLanguage(
  db: DatabaseAdapter,
  language: TranscriptionLanguage
): ResolvedTranscriptionLanguage {
  return language === 'auto' ? detectSessionLanguage(db) : language
}

function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0
  let count = 0
  while (regex.exec(text) !== null) count++
  return count
}
