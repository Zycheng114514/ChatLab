import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

/**
 * The chatlab-media URL is the only thing an attacker-controlled page could
 * craft, so parsing must reject anything but the exact session/attachment shape.
 */
test('chatlab-media URLs are parsed only in their exact shape', async () => {
  await mock.module('electron', {
    namedExports: {
      protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
      net: { fetch: async () => new Response('') },
    },
  })

  const { buildMediaProtocolUrl, parseMediaProtocolUrl } = await import('./media-protocol.js')

  assert.deepEqual(parseMediaProtocolUrl('chatlab-media://session/chat-1/attachment/42'), {
    sessionId: 'chat-1',
    attachmentId: 42,
  })
  assert.deepEqual(parseMediaProtocolUrl(buildMediaProtocolUrl('chat_2@x', 7)), {
    sessionId: 'chat_2@x',
    attachmentId: 7,
  })

  const rejected = [
    'chatlab-media://session/chat-1/attachment/42/extra',
    'chatlab-media://session/chat-1/file/42',
    'chatlab-media://other/chat-1/attachment/42',
    'chatlab-media://session/chat-1/attachment/abc',
    'chatlab-media://session/chat-1/attachment/0',
    'chatlab-media://session/chat-1/attachment/-1',
    'chatlab-media://session//attachment/42',
    // A session id that could climb out of the database directory.
    'chatlab-media://session/..%2F..%2Fetc/attachment/42',
    'file:///etc/passwd',
    'https://example.com/session/chat-1/attachment/42',
    'not a url',
  ]
  for (const url of rejected) {
    assert.equal(parseMediaProtocolUrl(url), null, `should reject ${url}`)
  }

  // Unencoded dot segments are collapsed by URL parsing, so they address a
  // plain session id rather than escaping the database directory.
  assert.deepEqual(parseMediaProtocolUrl('chatlab-media://session/.././chat/attachment/42'), {
    sessionId: 'chat',
    attachmentId: 42,
  })
})
