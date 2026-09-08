/**
 * Sample-rate conversion for Whisper input.
 *
 * Whisper's feature extractor is fixed at 16 kHz, so every decoded buffer is
 * resampled here. Linear interpolation is enough for speech: the models are
 * trained on 16 kHz mel spectrograms and the residual aliasing sits above the
 * band that carries the words.
 */

export const WHISPER_SAMPLE_RATE = 16000

/** Resample mono PCM to 16 kHz. Buffers already at 16 kHz are returned untouched. */
export function resampleToMono16k(pcm: Float32Array, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sample rate: ${sampleRate}`)
  }
  if (sampleRate === WHISPER_SAMPLE_RATE || pcm.length === 0) return pcm

  const ratio = sampleRate / WHISPER_SAMPLE_RATE
  const outputLength = Math.max(1, Math.floor(pcm.length / ratio))
  const output = new Float32Array(outputLength)
  const lastIndex = pcm.length - 1

  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio
    const left = Math.min(Math.floor(position), lastIndex)
    const right = Math.min(left + 1, lastIndex)
    const fraction = position - left
    output[i] = pcm[left] + (pcm[right] - pcm[left]) * fraction
  }
  return output
}
