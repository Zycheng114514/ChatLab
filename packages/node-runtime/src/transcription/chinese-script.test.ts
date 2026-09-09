/**
 * Simplified/traditional normalisation of Chinese transcripts.
 *
 * Guards the script a transcript is stored in: Whisper always writes Chinese in
 * traditional characters, so without this a simplified chat gets voice messages
 * in a script none of its other messages use — visibly odd, and invisible to a
 * keyword search for the simplified spelling. Detection matters as much as the
 * conversion: getting it backwards would rewrite a traditional user's chat.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openTestSqliteDatabase } from '../../../../tests/helpers/sqlite.mts'
import { BetterSqliteAdapter } from '../better-sqlite3-adapter'
import { detectSessionChineseScript, normalizeChineseScript, type ChineseScript } from './chinese-script'

const conversionCases: Array<{ name: string; text: string; script: ChineseScript; expected: string }> = [
  {
    name: 'traditional to simplified (what Whisper actually returns)',
    text: '今天天氣不錯,我們出去走走吧',
    script: 'simplified',
    expected: '今天天气不错,我们出去走走吧',
  },
  {
    name: 'simplified to traditional',
    text: '今天天气不错，我们出去走走吧',
    script: 'traditional',
    expected: '今天天氣不錯，我們出去走走吧',
  },
  {
    name: 'simplified text asked for simplified is left alone',
    text: '我们下午开会',
    script: 'simplified',
    expected: '我们下午开会',
  },
  {
    name: 'Chinese mixed with Latin keeps the Latin untouched',
    text: '這個 pull request 我明天 review',
    script: 'simplified',
    expected: '这个 pull request 我明天 review',
  },
  {
    name: 'text with no Chinese at all passes through',
    text: 'Hello ChatLab, this is a transcription test.',
    script: 'simplified',
    expected: 'Hello ChatLab, this is a transcription test.',
  },
  {
    name: 'an empty transcript stays empty',
    text: '',
    script: 'traditional',
    expected: '',
  },
]

for (const { name, text, script, expected } of conversionCases) {
  test(`normalizeChineseScript: ${name}`, () => {
    assert.equal(normalizeChineseScript(text, script), expected)
  })
}

function createSessionDb(contents: string[]) {
  const raw = openTestSqliteDatabase()
  raw.exec(CHAT_DB_SCHEMA)
  raw.prepare(`INSERT INTO member (platform_id, account_name) VALUES ('u1', 'Alice')`).run()
  const insert = raw.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (1, ?, 0, ?)`)
  for (const [index, content] of contents.entries()) insert.run(index + 1, content)
  return { raw, db: new BetterSqliteAdapter(raw) }
}

const detectionCases: Array<{ name: string; messages: string[]; expected: ChineseScript }> = [
  {
    name: 'a traditional chat',
    messages: [
      '今天天氣不錯，我們出去走走吧',
      '後來他發現這個問題很難解決',
      '請問這個檔案要怎麼開啟？',
      '我明天會去臺北開會',
    ],
    expected: 'traditional',
  },
  {
    name: 'a simplified chat',
    messages: ['今天天气不错，我们出去走走吧', '后来他发现这个问题很难解决', '请问这个文件要怎么打开？'],
    expected: 'simplified',
  },
  {
    name: 'a chat with no Chinese in it',
    messages: ['see you tomorrow', 'sounds good to me', '12:30 works'],
    expected: 'simplified',
  },
  {
    name: 'an empty session',
    messages: [],
    expected: 'simplified',
  },
  {
    name: 'mostly traditional with a few simplified messages',
    messages: [
      '這個禮拜的進度還好嗎？',
      '我們約在車站見面',
      '請幫我確認一下時間',
      '好的',
      '这个我来处理', // one simplified message does not flip a traditional chat
    ],
    expected: 'traditional',
  },
]

for (const { name, messages, expected } of detectionCases) {
  test(`detectSessionChineseScript: ${name}`, (t) => {
    const { raw, db } = createSessionDb(messages)
    t.after(() => raw.close())

    assert.equal(detectSessionChineseScript(db), expected)
  })
}
