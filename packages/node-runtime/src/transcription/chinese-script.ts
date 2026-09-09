/**
 * Simplified/traditional normalisation for Chinese transcripts.
 *
 * Whisper writes Chinese in traditional characters no matter what the speaker
 * or the chat uses — «今天天气不错» comes back as «今天天氣不錯» — so a
 * transcript dropped into a simplified conversation reads as a different script
 * from every message around it, and a keyword search for 天气 misses it. The
 * fix is one conversion between inference and the database.
 *
 * Which script to convert to is the session's own, taken from the text already
 * in it, exactly as the spoken language is (`detectSessionLanguage`). Users who
 * chat in traditional keep traditional transcripts; the setting can pin either.
 *
 * This lives in node-runtime and not in core because it needs `chinese-conv`,
 * and core stays dependency-free for the browser runtime.
 */

import { sampleRecentTextMessages, type DatabaseAdapter } from '@openchatlab/core'
import { sify, tify } from 'chinese-conv'

/** The script a transcript is actually stored in. */
export type ChineseScript = 'simplified' | 'traditional'

/** What the user asked for; `auto` is resolved against the session's messages. */
export type ChineseScriptSetting = 'auto' | ChineseScript

/** Convert a transcript to one script; non-Chinese text passes through unchanged. */
export function normalizeChineseScript(text: string, script: ChineseScript): string {
  return script === 'simplified' ? sify(text) : tify(text)
}

/**
 * Guess which script a session is written in.
 *
 * Characters that only exist in one script are the evidence: converting a
 * message to simplified changes exactly its traditional-only characters, and
 * converting it to traditional changes its simplified-only ones. Whichever side
 * moves more is the script the chat is written in.
 *
 * A session with no Chinese at all comes back `simplified`: it is the script of
 * most ChatLab conversations, and with no Chinese text there is nothing for the
 * conversion to change anyway.
 */
export function detectSessionChineseScript(db: DatabaseAdapter): ChineseScript {
  let traditionalChars = 0
  let simplifiedChars = 0

  for (const content of sampleRecentTextMessages(db)) {
    traditionalChars += countChangedChars(content, sify(content))
    simplifiedChars += countChangedChars(content, tify(content))
  }

  return traditionalChars > simplifiedChars ? 'traditional' : 'simplified'
}

/** Resolve `auto` once, at the entry point, so the conversion runs per attachment. */
export function resolveChineseScript(db: DatabaseAdapter, setting: ChineseScriptSetting): ChineseScript {
  return setting === 'auto' ? detectSessionChineseScript(db) : setting
}

/**
 * How many characters the conversion rewrote.
 *
 * `chinese-conv` maps character by character, so the two strings line up and a
 * positional comparison counts exactly the script-specific characters. The
 * length guard is only there so a future mapping that is not one-to-one cannot
 * read past the end.
 */
function countChangedChars(before: string, after: string): number {
  const shared = Math.min(before.length, after.length)
  let changed = Math.abs(before.length - after.length)
  for (let i = 0; i < shared; i++) {
    if (before[i] !== after[i]) changed++
  }
  return changed
}
