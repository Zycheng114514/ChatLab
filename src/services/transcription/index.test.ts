import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTranscriptionErrorMessage } from './index'

describe('normalizeTranscriptionErrorMessage', () => {
  it('shows the backend message instead of the platform wrapper around it', () => {
    const cases: Array<{ name: string; raw: string; expected: string }> = [
      {
        name: 'electron ipc rejection',
        raw: "Error invoking remote method 'transcription:transcribePcm': Error: Attachment 999 not found",
        expected: 'Attachment 999 not found',
      },
      {
        name: 'electron ipc rejection without an error class prefix',
        raw: "Error invoking remote method 'transcription:listPending': Session s1 not found",
        expected: 'Session s1 not found',
      },
      {
        name: 'cli web error envelope',
        raw: 'HTTP 400: {"success":false,"error":{"code":"INVALID_PAYLOAD","message":"Attachment 999 not found"}}',
        expected: 'Attachment 999 not found',
      },
      {
        name: 'non-json http failure keeps the raw text',
        raw: 'HTTP 502: <html>Bad Gateway</html>',
        expected: 'HTTP 502: <html>Bad Gateway</html>',
      },
      {
        name: 'plain error passes through',
        raw: 'Failed to read the audio file: HTTP 404',
        expected: 'Failed to read the audio file: HTTP 404',
      },
    ]
    for (const { name, raw, expected } of cases) {
      assert.equal(normalizeTranscriptionErrorMessage(new Error(raw)), expected, name)
    }
  })
})
