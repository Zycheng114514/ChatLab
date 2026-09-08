import assert from 'node:assert/strict'
import test from 'node:test'
import { resampleToMono16k, WHISPER_SAMPLE_RATE } from './resample'

function sine(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return samples
}

/**
 * Rising zero crossings — one per cycle of a pure tone. The crossing at t=0 has
 * no preceding sample, so the count is allowed to be one cycle short.
 */
function countCycles(samples: Float32Array): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings++
  }
  return crossings
}

function peak(samples: Float32Array): number {
  let max = 0
  for (const value of samples) max = Math.max(max, Math.abs(value))
  return max
}

test('resampling preserves the tone rather than shifting or attenuating it', () => {
  // 440 Hz for one second at 44.1 kHz, a common export rate for voice messages.
  const resampled = resampleToMono16k(sine(440, 44100, 1), 44100)

  assert.equal(resampled.length, WHISPER_SAMPLE_RATE)
  assert.ok(Math.abs(countCycles(resampled) - 440) <= 1, `cycles ${countCycles(resampled)}`)
  // Linear interpolation loses a little peak amplitude between samples.
  assert.ok(peak(resampled) > 0.98, `peak ${peak(resampled)}`)
})

test('upsampling and pass-through keep the signal usable', () => {
  // 300 Hz for half a second at 8 kHz: 150 cycles, doubled to 16 kHz.
  const upsampled = resampleToMono16k(sine(300, 8000, 0.5), 8000)
  assert.equal(upsampled.length, WHISPER_SAMPLE_RATE / 2)
  assert.ok(Math.abs(countCycles(upsampled) - 150) <= 1, `cycles ${countCycles(upsampled)}`)
  assert.ok(peak(upsampled) > 0.98, `peak ${peak(upsampled)}`)

  // Already at the target rate: no copy, no interpolation error.
  const native = sine(440, WHISPER_SAMPLE_RATE, 0.1)
  assert.equal(resampleToMono16k(native, WHISPER_SAMPLE_RATE), native)

  assert.equal(resampleToMono16k(new Float32Array(0), 44100).length, 0)
})
