import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MessageType } from '@openchatlab/shared-types'
import { inferAttachmentFromContent, normalizeAttachments } from './attachments'

describe('inferAttachmentFromContent', () => {
  const cases: Array<{
    type: MessageType
    content: string | null
    expected: { kind: string; path: string } | undefined
  }> = [
    { type: MessageType.IMAGE, content: 'a.jpg', expected: { kind: 'image', path: 'a.jpg' } },
    { type: MessageType.IMAGE, content: 'images/a.jpg', expected: { kind: 'image', path: 'images/a.jpg' } },
    { type: MessageType.VOICE, content: 'voice/a.mp3', expected: { kind: 'audio', path: 'voice/a.mp3' } },
    { type: MessageType.VIDEO, content: 'video/a.mp4', expected: { kind: 'video', path: 'video/a.mp4' } },
    { type: MessageType.FILE, content: 'docs/a.pdf', expected: { kind: 'file', path: 'docs/a.pdf' } },
    { type: MessageType.IMAGE, content: 'C:\\wechat\\a.jpg', expected: { kind: 'image', path: 'C:\\wechat\\a.jpg' } },
    // Rejected: remote address, whitespace, no extension, marker text, empty, non-media type.
    { type: MessageType.IMAGE, content: 'http://x/a.jpg', expected: undefined },
    { type: MessageType.IMAGE, content: 'https://example.com/a.jpg', expected: undefined },
    { type: MessageType.IMAGE, content: '你好 a.jpg', expected: undefined },
    { type: MessageType.IMAGE, content: '[图片]', expected: undefined },
    { type: MessageType.IMAGE, content: 'photo', expected: undefined },
    { type: MessageType.IMAGE, content: '', expected: undefined },
    { type: MessageType.IMAGE, content: null, expected: undefined },
    { type: MessageType.TEXT, content: 'a.jpg', expected: undefined },
    { type: MessageType.EMOJI, content: 'a.gif', expected: undefined },
    { type: MessageType.SYSTEM, content: 'a.jpg', expected: undefined },
  ]

  for (const testCase of cases) {
    it(`type=${testCase.type} content=${JSON.stringify(testCase.content)}`, () => {
      const inferred = inferAttachmentFromContent(testCase.type, testCase.content)
      assert.deepEqual(inferred && { kind: inferred.kind, path: inferred.path }, testCase.expected)
    })
  }
})

describe('normalizeAttachments', () => {
  it('keeps valid entries and reports skipped ones', () => {
    const result = normalizeAttachments([
      { kind: 'image', path: 'a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 10, width: 2, height: 3 },
      { kind: 'audio', path: 'b.mp3', durationMs: 1500 },
      { kind: 'nope', path: 'c.bin' },
      { kind: 'file' },
      { path: 'd.bin' },
      'not an object',
      null,
    ])

    assert.equal(result.skipped, 5)
    assert.deepEqual(result.attachments, [
      {
        kind: 'image',
        path: 'a.jpg',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        size: 10,
        durationMs: undefined,
        width: 2,
        height: 3,
      },
      {
        kind: 'audio',
        path: 'b.mp3',
        name: undefined,
        mimeType: undefined,
        size: undefined,
        durationMs: 1500,
        width: undefined,
        height: undefined,
      },
    ])
  })

  it('treats a missing field as no attachments and a non-array as one skipped entry', () => {
    assert.deepEqual(normalizeAttachments(undefined), { skipped: 0 })
    assert.deepEqual(normalizeAttachments(null), { skipped: 0 })
    assert.deepEqual(normalizeAttachments([]), { attachments: undefined, skipped: 0 })
    assert.deepEqual(normalizeAttachments('nope'), { skipped: 1 })
  })
})
