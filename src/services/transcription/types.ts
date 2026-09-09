/**
 * 语音转文字前端服务类型
 *
 * 与桌面 IPC（apps/desktop/main/ipc/transcription.ts）和 CLI Web 路由
 * （packages/http-routes/src/routes/web/transcription.ts）的契约保持一致。
 * 推理只在 Node 侧发生，Web WASM 没有对应实现。
 */

import type { TranscriptionLanguage } from '@openchatlab/core'

export type { TranscriptionLanguage }

/** Whisper 档位；体积与中文质量的取舍见设置区文案。 */
export type TranscriptionModel = 'tiny' | 'base' | 'small'

export interface TranscriptionSettings {
  model: TranscriptionModel
  language: TranscriptionLanguage
}

/** 一条还没有转写文本的语音附件；URL 由渲染进程用 getAttachmentUrl 拼。 */
export interface PendingTranscriptionItem {
  id: number
  messageId: number
  fileName: string | null
  mimeType: string | null
  durationMs: number | null
}

export interface TranscriptionResult {
  text: string
  /** 后端是否把转写文本写回了 message.content（原文非占位时不写）。 */
  contentUpdated: boolean
}
