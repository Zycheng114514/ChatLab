/**
 * Session language detection.
 *
 * Guards transcription quality: Whisper transcribes a Chinese voice message as
 * garbled English when it is told the wrong language, and Transformers.js has no
 * detection of its own, so this heuristic is the only thing standing between a
 * Chinese chat and unusable transcripts.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_DB_SCHEMA } from '../schema'
import { SqliteTestAdapter } from './__tests__/sqlite-test-adapter'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { detectSessionLanguage, resolveTranscriptionLanguage } from './session-language'

interface MessageSeed {
  content: string
  /** MessageType.TEXT unless the case is about non-text rows being ignored. */
  type?: number
}

function createSessionDb(seeds: MessageSeed[]) {
  const raw = openTestSqliteDatabase()
  raw.exec(CHAT_DB_SCHEMA)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  const insert = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, ?, ?, ?)`)
  for (const [index, seed] of seeds.entries()) {
    insert.run(index + 1, seed.type ?? 0, seed.content)
  }
  return { raw, db: new SqliteTestAdapter(raw) }
}

const cases: Array<{ name: string; seeds: MessageSeed[]; expected: 'zh' | 'en' }> = [
  {
    name: 'a Chinese chat that also uses English words',
    seeds: [
      { content: '今天的 deadline 是几点？' },
      { content: '我下午把 PR 发出来，你 review 一下' },
      { content: '好的，谢谢' },
    ],
    expected: 'zh',
  },
  {
    name: 'an English-only chat',
    seeds: [
      { content: 'are we still on for tomorrow?' },
      { content: 'yes, same time as last week' },
      { content: 'great, see you then' },
    ],
    expected: 'en',
  },
  { name: 'a session with no messages', seeds: [], expected: 'en' },
  {
    name: 'a session whose only text is punctuation and numbers',
    seeds: [{ content: '123' }, { content: '???' }],
    expected: 'en',
  },
  {
    name: 'a session whose Chinese lives in non-text messages only',
    seeds: [
      { content: 'ok sounds good' },
      // Voice/system rows are not evidence of what the members type.
      { content: '这是一条系统提示消息，内容全是中文', type: 80 },
    ],
    expected: 'en',
  },
]

for (const { name, seeds, expected } of cases) {
  test(`detectSessionLanguage returns ${expected} for ${name}`, () => {
    const { raw, db } = createSessionDb(seeds)
    try {
      assert.equal(detectSessionLanguage(db), expected)
    } finally {
      raw.close()
    }
  })
}

test('resolveTranscriptionLanguage only detects for auto', () => {
  const { raw, db } = createSessionDb([{ content: '我们晚点再聊' }])
  try {
    assert.equal(resolveTranscriptionLanguage(db, 'auto'), 'zh')
    // An explicit choice wins even when it contradicts the messages.
    assert.equal(resolveTranscriptionLanguage(db, 'en'), 'en')
    assert.equal(resolveTranscriptionLanguage(db, 'zh'), 'zh')
  } finally {
    raw.close()
  }
})
