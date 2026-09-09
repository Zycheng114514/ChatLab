import type { AnalyticsEventName, DesktopCloseBehavior } from '@openchatlab/shared-types'
import type {
  PendingTranscriptionItem,
  TranscriptionLanguage,
  TranscriptionResult,
  TranscriptionSettings,
} from '../transcription/types'

/**
 * PlatformAdapter — 平台能力领域适配器接口
 *
 * 负责平台特定的能力：版本信息、主题、文件对话框、剪贴板、
 * 远程配置获取、开机自启、重启等。
 * 来源：window.api（Electron IPC）
 */

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory'>
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface RemoteConfigResult {
  success: boolean
  data?: unknown
  error?: string
}

export interface CheckUpdateResult {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  error?: string
}

export interface PerformUpdateResult {
  success: boolean
  error?: string
}

export interface PlatformAdapter {
  getVersion(): Promise<string>
  fetchRemoteConfig(url: string): Promise<RemoteConfigResult>

  setThemeSource(theme: 'system' | 'light' | 'dark'): void

  getOpenAtLogin(): Promise<boolean>
  setOpenAtLogin(enabled: boolean): Promise<{ success: boolean; error?: string }>
  getDesktopCloseBehavior(): Promise<DesktopCloseBehavior>
  setDesktopCloseBehavior(behavior: DesktopCloseBehavior): Promise<{ success: boolean; error?: string }>
  getUiScale(): Promise<number>
  setUiScale(scale: number): Promise<{ success: boolean; error?: string }>

  getAnalyticsEnabled(): Promise<boolean>
  setAnalyticsEnabled(enabled: boolean): Promise<{ success: boolean }>
  trackDailyActive(locale: string): Promise<void>
  trackAnalyticsEvent(eventName: AnalyticsEventName, properties?: Record<string, unknown>): Promise<void>

  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>
  copyImageToClipboard(dataUrl: string): Promise<{ success: boolean; error?: string }>

  /**
   * URL the renderer can load a message attachment from.
   * Null when the platform cannot serve local files (Web WASM).
   */
  getAttachmentUrl(sessionId: string, attachmentId: number): string | null

  /**
   * Reveal an attachment in the OS file manager; false when the file is gone.
   * Only defined on platforms that have one, so its presence is the capability check.
   */
  revealAttachment?(sessionId: string, attachmentId: number): Promise<boolean>

  /**
   * Local voice transcription, backed by Whisper in a Node worker thread.
   * Only defined where that backend exists, so its presence is the capability check.
   */
  transcription?: TranscriptionCapability

  checkUpdate(): Promise<CheckUpdateResult | void>
  performUpdate(): Promise<PerformUpdateResult>
  relaunch(): Promise<void>
}

export interface TranscriptionCapability {
  getConfig(): Promise<TranscriptionSettings>
  setConfig(patch: Partial<TranscriptionSettings>): Promise<TranscriptionSettings>
  listPending(sessionId: string): Promise<PendingTranscriptionItem[]>
  /** `pcm` holds the mono 16 kHz samples the renderer decoded with Web Audio. */
  transcribePcm(
    sessionId: string,
    attachmentId: number,
    pcm: Float32Array,
    language?: TranscriptionLanguage
  ): Promise<TranscriptionResult>
}
