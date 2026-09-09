import type { PreprocessConfig } from '@electron/preload/index'
import type { useSettingsStore } from './settings'

export function shouldEnsureDesensitizeRulesBeforeSerialize(
  config: Pick<PreprocessConfig, 'desensitize' | 'desensitizeRules'>
): boolean {
  return config.desensitize && !config.desensitizeRules.some((rule) => rule.builtin)
}

export function buildSerializablePreprocessConfig(config: PreprocessConfig) {
  const hasPreprocess =
    config.dataCleaning ||
    config.mergeConsecutive ||
    config.blacklistKeywords.length > 0 ||
    config.denoise ||
    config.desensitize ||
    config.anonymizeNames

  if (!hasPreprocess) return undefined
  return {
    dataCleaning: config.dataCleaning,
    mergeConsecutive: config.mergeConsecutive,
    mergeWindowSeconds: config.mergeWindowSeconds,
    blacklistKeywords: [...config.blacklistKeywords],
    denoise: config.denoise,
    desensitize: config.desensitize,
    desensitizeRules: config.desensitizeRules.map((rule) => ({
      ...rule,
      locales: [...rule.locales],
    })),
    anonymizeNames: config.anonymizeNames,
  }
}

/**
 * 送给后端的隐私设置：AI 对话和亲密关系分析都用这一份，
 * 保证同一份脱敏 / 匿名设置在所有走模型的请求里表现一致。
 */
export async function buildReadySerializablePreprocessConfig(settingsStore: ReturnType<typeof useSettingsStore>) {
  if (shouldEnsureDesensitizeRulesBeforeSerialize(settingsStore.aiPreprocessConfig)) {
    await settingsStore.ensureDesensitizeRules()
  }

  return buildSerializablePreprocessConfig(settingsStore.aiPreprocessConfig)
}
