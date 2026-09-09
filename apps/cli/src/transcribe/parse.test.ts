/**
 * `clb transcribe` option parsing.
 *
 * Guards against a typo being swallowed: every one of these flags also has a
 * config-file default, so an unrecognised value that fell through to the default
 * would run the whole transcription — minutes of CPU, then a database write — in
 * a model, language or script the user did not ask for.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChineseScript, parseLanguage, parseProfile } from './command'

const parsers = {
  model: parseProfile,
  language: parseLanguage,
  'chinese-script': parseChineseScript,
} as const

const cases: Array<{ flag: keyof typeof parsers; accepted: string[]; rejected: string[] }> = [
  { flag: 'model', accepted: ['tiny', 'base', 'small'], rejected: ['large', 'Base', '', 'medium'] },
  { flag: 'language', accepted: ['auto', 'zh', 'en'], rejected: ['ja', 'zh-CN', '', 'chinese'] },
  {
    flag: 'chinese-script',
    accepted: ['auto', 'simplified', 'traditional'],
    rejected: ['zh-TW', 'simplifed', '', 'trad'],
  },
]

for (const { flag, accepted, rejected } of cases) {
  test(`--${flag} accepts its documented values and rejects the rest`, () => {
    const parse = parsers[flag]
    for (const value of accepted) assert.equal(parse(value), value)
    for (const value of rejected) {
      assert.throws(() => parse(value), /Use one of/, `--${flag} ${JSON.stringify(value)} should not be accepted`)
    }
  })
}
