/**
 * useTranscriptionService — 语音转文字前端服务
 *
 * 桌面端走 IPC、CLI Web 走 /_web 路由，两条路的差别由平台适配器吸收；
 * 适配器上有 `transcription` 才代表这个平台能转写（Web WASM 没有），
 * 所以这里在没有能力时返回 null，调用方用它同时做能力判断。
 */

import { usePlatformService } from '../platform/service'
import type {
  PendingTranscriptionItem,
  TranscriptionLanguage,
  TranscriptionResult,
  TranscriptionSettings,
} from './types'

export interface TranscriptionService {
  getConfig(): Promise<TranscriptionSettings>
  setConfig(patch: Partial<TranscriptionSettings>): Promise<TranscriptionSettings>
  listPending(sessionId: string): Promise<PendingTranscriptionItem[]>
  transcribePcm(
    sessionId: string,
    attachmentId: number,
    pcm: Float32Array,
    language?: TranscriptionLanguage
  ): Promise<TranscriptionResult>
}

/** Electron 把被拒绝的 handler 包成 `Error invoking remote method 'x': Error: 真正的消息`。 */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/

/** utils/http 的失败形状：`HTTP 400: {"success":false,"error":{"message":"…"}}`。 */
const HTTP_FAILURE = /^HTTP \d+: ([\s\S]*)$/

/**
 * 把两端各自的错误包装还原成后端写的那句话。
 *
 * 用户看到的是「附件 999 不存在」「模型下载失败」这类原文，而不是 Electron 的
 * 调用噪声或者一整段 JSON 信封。
 */
export function normalizeTranscriptionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const httpBody = HTTP_FAILURE.exec(raw)
  if (httpBody) {
    try {
      const parsed = JSON.parse(httpBody[1]) as { error?: { message?: unknown } }
      const message = parsed.error?.message
      if (typeof message === 'string' && message.length > 0) return message
    } catch {
      /* 不是 JSON 信封（例如网关返回的 HTML）时保留原文 */
    }
    return raw
  }
  return raw.replace(IPC_INVOKE_PREFIX, '')
}

async function unwrapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(normalizeTranscriptionErrorMessage(error), { cause: error })
  }
}

/** 当前平台不能转写（Web WASM）时返回 null。 */
export function useTranscriptionService(): TranscriptionService | null {
  const capability = usePlatformService().transcription
  if (!capability) return null
  return {
    getConfig: () => unwrapErrors(() => capability.getConfig()),
    setConfig: (patch) => unwrapErrors(() => capability.setConfig(patch)),
    listPending: (sessionId) => unwrapErrors(() => capability.listPending(sessionId)),
    transcribePcm: (sessionId, attachmentId, pcm, language) =>
      unwrapErrors(() => capability.transcribePcm(sessionId, attachmentId, pcm, language)),
  }
}
