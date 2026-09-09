/**
 * ElectronPlatformAdapter — wrap window.api
 */

import type { AnalyticsEventName, DesktopCloseBehavior } from '@openchatlab/shared-types'
import type {
  PlatformAdapter,
  OpenDialogOptions,
  OpenDialogResult,
  RemoteConfigResult,
  TranscriptionCapability,
} from './types'
import type { TranscriptionLanguage, TranscriptionSettings } from '../transcription/types'
import { pcmToArrayBuffer } from '../transcription/decode-audio'

export class ElectronPlatformAdapter implements PlatformAdapter {
  getVersion(): Promise<string> {
    return window.api.app.getVersion()
  }

  fetchRemoteConfig(url: string): Promise<RemoteConfigResult> {
    return window.api.app.fetchRemoteConfig(url)
  }

  setThemeSource(theme: 'system' | 'light' | 'dark'): void {
    window.api.setThemeSource(theme)
  }

  getOpenAtLogin(): Promise<boolean> {
    return window.api.app.getOpenAtLogin()
  }

  setOpenAtLogin(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return window.api.app.setOpenAtLogin(enabled)
  }

  getDesktopCloseBehavior(): Promise<DesktopCloseBehavior> {
    return window.api.app.getDesktopCloseBehavior()
  }

  setDesktopCloseBehavior(behavior: DesktopCloseBehavior): Promise<{ success: boolean; error?: string }> {
    return window.api.app.setDesktopCloseBehavior(behavior)
  }

  getUiScale(): Promise<number> {
    return window.api.app.getUiScale()
  }

  setUiScale(scale: number): Promise<{ success: boolean; error?: string }> {
    return window.api.app.setUiScale(scale)
  }

  getAttachmentUrl(sessionId: string, attachmentId: number): string | null {
    return `chatlab-media://session/${encodeURIComponent(sessionId)}/attachment/${attachmentId}`
  }

  revealAttachment(sessionId: string, attachmentId: number): Promise<boolean> {
    return window.api.attachment.revealInFolder(sessionId, attachmentId)
  }

  readonly transcription: TranscriptionCapability = {
    getConfig: () => window.api.transcription.getConfig(),
    setConfig: (patch: Partial<TranscriptionSettings>) => window.api.transcription.setConfig(patch),
    listPending: async (sessionId: string) => (await window.api.transcription.listPending(sessionId)).items,
    // structured clone copies the buffer, so the caller keeps its samples.
    transcribePcm: (sessionId: string, attachmentId: number, pcm: Float32Array, language?: TranscriptionLanguage) =>
      window.api.transcription.transcribePcm(sessionId, attachmentId, pcmToArrayBuffer(pcm), language),
  }

  getAnalyticsEnabled(): Promise<boolean> {
    return window.api.app.getAnalyticsEnabled()
  }

  setAnalyticsEnabled(enabled: boolean): Promise<{ success: boolean }> {
    return window.api.app.setAnalyticsEnabled(enabled)
  }

  trackDailyActive(locale: string): Promise<void> {
    return window.api.app.trackDailyActive(locale)
  }

  trackAnalyticsEvent(eventName: AnalyticsEventName, properties?: Record<string, unknown>): Promise<void> {
    return window.api.app.trackAnalyticsEvent(eventName, properties)
  }

  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult> {
    return window.api.dialog.showOpenDialog(options as Electron.OpenDialogOptions)
  }

  copyImageToClipboard(dataUrl: string): Promise<{ success: boolean; error?: string }> {
    return window.api.clipboard.copyImage(dataUrl)
  }

  async checkUpdate(): Promise<void> {
    window.api.app.checkUpdate()
  }

  async performUpdate(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Use built-in updater' }
  }

  relaunch(): Promise<void> {
    return window.api.app.relaunch()
  }
}
