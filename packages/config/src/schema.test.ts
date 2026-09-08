import assert from 'node:assert/strict'
import test from 'node:test'
import { configSchema } from './schema'

test('defaults the session landing tab to insights', () => {
  const config = configSchema.parse({})

  assert.equal(config.ui.default_session_tab, 'insights')
})

test('normalizes the released overview preference to insights', () => {
  const config = configSchema.parse({ ui: { default_session_tab: 'overview' } })

  assert.equal(config.ui.default_session_tab, 'insights')
})

test('rejects unknown session landing tabs', () => {
  assert.throws(() => configSchema.parse({ ui: { default_session_tab: 'unknown' } }))
})

test('defaults Windows close behavior to running in the background', () => {
  const config = configSchema.parse({})

  assert.equal(config.desktop.close_behavior, 'background')
})

test('accepts supported Windows close behaviors and rejects invalid values', () => {
  for (const closeBehavior of ['background', 'quit']) {
    assert.equal(
      configSchema.parse({ desktop: { close_behavior: closeBehavior } }).desktop.close_behavior,
      closeBehavior
    )
  }

  assert.throws(() => configSchema.parse({ desktop: { close_behavior: 'ask' } }))
  assert.throws(() => configSchema.parse({ desktop: { close_behavior: 'hide-forever' } }))
})

test('defaults the desktop UI scale to 1', () => {
  const config = configSchema.parse({})

  assert.equal(config.desktop.ui_scale, 1)
})

test('accepts supported desktop UI scales and rejects out-of-range or non-numeric values', () => {
  for (const uiScale of [0.8, 1.25, 2]) {
    assert.equal(configSchema.parse({ desktop: { ui_scale: uiScale } }).desktop.ui_scale, uiScale)
  }

  for (const uiScale of [0.5, 3, '1']) {
    assert.throws(() => configSchema.parse({ desktop: { ui_scale: uiScale } }))
  }
})

test('defaults transcription to the base model and automatic language', () => {
  const config = configSchema.parse({})

  assert.equal(config.transcription.model, 'base')
  assert.equal(config.transcription.language, 'auto')
})

test('accepts supported transcription models and languages and rejects the rest', () => {
  for (const model of ['tiny', 'base', 'small']) {
    assert.equal(configSchema.parse({ transcription: { model } }).transcription.model, model)
  }
  for (const language of ['auto', 'zh', 'en']) {
    assert.equal(configSchema.parse({ transcription: { language } }).transcription.language, language)
  }

  assert.throws(() => configSchema.parse({ transcription: { model: 'large' } }))
  assert.throws(() => configSchema.parse({ transcription: { language: 'ja' } }))
})
