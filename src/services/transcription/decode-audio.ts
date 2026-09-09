/**
 * 渲染进程音频解码：附件 URL → Whisper 要的单声道 16 kHz Float32 采样
 *
 * 桌面端与 CLI Web 页面共用这一条路径：Chromium 自带 mp3 / m4a / ogg-opus /
 * wav / flac 解码器，比 Node 侧能解的格式多得多，所以解码放在页面里，后端只
 * 拿 PCM 做推理。SILK / AMR 这类 Chromium 不认的容器会走 UnsupportedAudioError。
 */

/** Whisper 的输入采样率。 */
export const TRANSCRIPTION_SAMPLE_RATE = 16000

/** 后端拒绝更长的 PCM（MAX_TRANSCRIPTION_PCM_SAMPLES），所以上传前就拦下。 */
export const MAX_TRANSCRIPTION_DURATION_SECONDS = 30 * 60

/** 浏览器解不开这个容器 / 编码；调用方展示「格式暂不支持」。 */
export class UnsupportedAudioError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.name = 'UnsupportedAudioError'
  }
}

/** 音频超过后端上限；调用方展示时长限制而不是通用失败。 */
export class AudioTooLongError extends Error {
  constructor(readonly durationSeconds: number) {
    super(`Audio is ${Math.round(durationSeconds)}s, longer than the ${MAX_TRANSCRIPTION_DURATION_SECONDS}s limit`)
    this.name = 'AudioTooLongError'
  }
}

export interface DecodeAudioOptions {
  signal?: AbortSignal
}

/**
 * 16 kHz 重采样后的帧数；顺带把「空音频」和「超长音频」拦在解码之后、渲染之前。
 *
 * 单独导出是为了能在 Node 里覆盖这两条判定（Web Audio 本身只能在浏览器里跑）。
 */
export function targetFrameCount(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new UnsupportedAudioError('The file contains no audio')
  }
  if (durationSeconds > MAX_TRANSCRIPTION_DURATION_SECONDS) {
    throw new AudioTooLongError(durationSeconds)
  }
  return Math.ceil(durationSeconds * TRANSCRIPTION_SAMPLE_RATE)
}

/**
 * 下载并解码一个语音附件。
 *
 * 失败分三类：取不到文件（普通 Error，带 HTTP 状态）、浏览器解不开
 * （UnsupportedAudioError）、超过 30 分钟（AudioTooLongError）。
 * `signal` 只作用于下载，解码本身没有取消接口。
 */
export async function decodeAudioToPcm16k(url: string, options: DecodeAudioOptions = {}): Promise<Float32Array> {
  const response = await fetch(url, { signal: options.signal })
  if (!response.ok) {
    throw new Error(`Failed to read the audio file: HTTP ${response.status}`)
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new UnsupportedAudioError('The audio file is empty')

  const context = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(bytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UnsupportedAudioError(detail || 'The browser could not decode this audio format', { cause: error })
  } finally {
    // 解码用的 context 不再需要；不关会一直占着音频硬件。
    void context.close()
  }

  const frames = targetFrameCount(decoded.duration)
  return await renderMono16k(decoded, frames)
}

/** 用 OfflineAudioContext 把任意声道数 / 采样率的解码结果压成单声道 16 kHz。 */
async function renderMono16k(decoded: AudioBuffer, frames: number): Promise<Float32Array> {
  const offline = new OfflineAudioContext(1, frames, TRANSCRIPTION_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/**
 * 采样数据自己的 ArrayBuffer——IPC 的 structured clone 与 fetch 的 body 都只收它。
 *
 * Web Audio 给回来的是整块 buffer 的视图，所以这里通常是零拷贝。
 */
export function pcmToArrayBuffer(pcm: Float32Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = pcm
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
}
