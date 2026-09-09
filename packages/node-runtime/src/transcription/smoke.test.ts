/**
 * Real-model smoke test (opt in with CHATLAB_TRANSCRIPTION_SMOKE=1).
 *
 * Everything else in this module runs against fake pipelines, so nothing else
 * proves the pieces fit: WAV bytes → PCM → 16 kHz → Whisper → text. It downloads
 * the base model on first run, which is why it stays out of the default suite.
 *
 *   CHATLAB_TRANSCRIPTION_SMOKE=1 CHATLAB_MODEL_CACHE_DIR=/tmp/chatlab-models \
 *     pnpm test -- packages/node-runtime/src/transcription/smoke.test.ts
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createChatLabTempDir } from '../temp-workspace'
import { decodeWav } from './wav'
import { resampleToMono16k } from './resample'
import { createTranscriber, resolveTranscriptionModelCacheDir } from './service'
import { normalizeChineseScript } from './chinese-script'

const enabled = process.env.CHATLAB_TRANSCRIPTION_SMOKE === '1'
/** Fully qualified: a bare "Eddy" resolves to the English voice and renders Chinese as silence. */
const CHINESE_VOICE = 'Eddy (Chinese (China mainland))'

test(
  'the base model transcribes synthesized Chinese and English speech',
  { skip: enabled ? false : 'set CHATLAB_TRANSCRIPTION_SMOKE=1 to run', timeout: 900_000 },
  async () => {
    if (process.platform !== 'darwin') {
      throw new Error('This smoke test synthesizes speech with macOS `say`.')
    }
    const dir = createChatLabTempDir('tests', 'transcription-smoke-')
    const transcriber = createTranscriber({
      loadTransformers: () => import('@huggingface/transformers'),
      cacheDir: resolveTranscriptionModelCacheDir(dir),
      profile: 'base',
    })

    try {
      // Whisper hallucinates on very short clips, so each sample is a full
      // sentence. Its Chinese comes back in traditional characters, so the zh
      // case goes through the same normalisation the service does before storing
      // and is checked for simplified spellings the model never produces itself.
      const cases = [
        {
          language: 'zh' as const,
          voice: CHINESE_VOICE,
          text: '今天天气不错，我们出去走走吧。',
          script: 'simplified' as const,
          expect: ['天气', '不错'],
        },
        {
          language: 'en' as const,
          voice: null,
          text: 'hello chatlab, this is a transcription test.',
          script: null,
          expect: ['hello'],
        },
      ]

      for (const { language, voice, text, script, expect } of cases) {
        const wavPath = path.join(dir, `${language}.wav`)
        execFileSync('say', [...(voice ? ['-v', voice] : []), '-o', wavPath, '--data-format=LEI16@16000', text])
        const decoded = decodeWav(fs.readFileSync(wavPath))
        const result = await transcriber.transcribePcm(resampleToMono16k(decoded.pcm, decoded.sampleRate), {
          language,
        })
        const stored = script ? normalizeChineseScript(result.text, script) : result.text

        console.log(`[smoke] ${language} (${result.durationMs} ms): ${result.text}`)
        if (script) console.log(`[smoke] ${language} stored as ${script}: ${stored}`)
        assert.ok(
          expect.some((keyword) => stored.toLowerCase().includes(keyword.toLowerCase())),
          `expected one of ${expect.join(' / ')} in ${JSON.stringify(stored)}`
        )
      }
    } finally {
      await transcriber.dispose()
    }
  }
)
