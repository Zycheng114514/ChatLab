import assert from 'node:assert/strict'
import test from 'node:test'

test('probes kernel ids so an older loadable native binary is not treated as format-capable', async (t) => {
  class OlderNativeParser {
    constructor(formatId: string) {
      if (
        formatId !== 'chatlab' &&
        formatId !== 'shuakami-qq-exporter' &&
        formatId !== 'telegram' &&
        formatId !== 'discord'
      ) {
        throw new Error(`unsupported format: ${formatId}`)
      }
    }
  }

  await t.mock.module('@openchatlab/parser-native', {
    namedExports: { NativeParser: OlderNativeParser },
  })

  const { isNativeFormatAvailable } = await import('./loader')
  assert.equal(isNativeFormatAvailable('chatlab'), true)
  assert.equal(isNativeFormatAvailable('qq-shuakami'), true)
  assert.equal(isNativeFormatAvailable('shuakami-qq-exporter'), true)
  // Both public Telegram format ids resolve to the single 'telegram' kernel.
  assert.equal(isNativeFormatAvailable('telegram-native'), true)
  assert.equal(isNativeFormatAvailable('telegram-native-single'), true)
  assert.equal(isNativeFormatAvailable('discord-tyrrrz'), true)
  // This fake binary predates the WeFlow kernel, so both ids that resolve to it
  // must report unavailable instead of trusting module availability alone.
  assert.equal(isNativeFormatAvailable('weflow'), false)
  assert.equal(isNativeFormatAvailable('echotrace'), false)

  const saved = process.env.CHATLAB_DISABLE_NATIVE_PERF
  try {
    process.env.CHATLAB_DISABLE_NATIVE_PERF = '1'
    assert.equal(isNativeFormatAvailable('chatlab'), false)
  } finally {
    if (saved === undefined) delete process.env.CHATLAB_DISABLE_NATIVE_PERF
    else process.env.CHATLAB_DISABLE_NATIVE_PERF = saved
  }
})
