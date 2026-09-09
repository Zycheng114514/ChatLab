<script setup lang="ts">
/**
 * 语音转文字设置区块（设置 > AI > 语音转文字）
 *
 * 只有两项：Whisper 档位与默认语言。两项都是转写时的默认值，会话页的弹窗里
 * 还能临时换语言。转写只在桌面 / CLI Web 上有后端，Web WASM 不渲染这个区块。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UITabs from '@/components/UI/Tabs.vue'
import { useTranscriptionService } from '@/services'
import type { TranscriptionLanguage, TranscriptionModel, TranscriptionSettings } from '@/services'

const { t } = useI18n()
const service = useTranscriptionService()

const k = 'settings.ai.transcription'

const settings = ref<TranscriptionSettings | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

const modelItems = (['tiny', 'base', 'small'] as const).map((value) => ({ value, label: value }))
const languageItems = computed(() =>
  (['auto', 'zh', 'en'] as const).map((value) => ({ value, label: t(`common.transcriptionLanguage.${value}`) }))
)

async function save(patch: Partial<TranscriptionSettings>) {
  if (!service) return
  saving.value = true
  error.value = null
  try {
    settings.value = await service.setConfig(patch)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (!service) return
  try {
    settings.value = await service.getConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <div class="space-y-3">
    <div>
      <h3 class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
        <UIcon name="i-heroicons-microphone" class="h-4 w-4 text-rose-500" />
        {{ t(`${k}.title`) }}
      </h3>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ t(`${k}.description`) }}</p>
    </div>

    <!-- 模型档位 -->
    <div
      class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50"
    >
      <div class="min-w-0">
        <span class="text-sm text-gray-700 dark:text-gray-300">{{ t(`${k}.model`) }}</span>
        <p class="text-xs text-gray-400">{{ t(`${k}.modelHint`) }}</p>
      </div>
      <UITabs
        v-if="settings"
        :model-value="settings.model"
        :items="modelItems"
        size="xs"
        class="shrink-0"
        @update:model-value="(value) => save({ model: value as TranscriptionModel })"
      />
    </div>

    <!-- 默认语言 -->
    <div
      class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50"
    >
      <div class="min-w-0">
        <span class="text-sm text-gray-700 dark:text-gray-300">{{ t(`${k}.language`) }}</span>
        <p class="text-xs text-gray-400">{{ t('common.transcriptionLanguage.autoHint') }}</p>
      </div>
      <UITabs
        v-if="settings"
        :model-value="settings.language"
        :items="languageItems"
        size="xs"
        class="shrink-0"
        @update:model-value="(value) => save({ language: value as TranscriptionLanguage })"
      />
    </div>

    <p v-if="saving" class="text-xs text-gray-400">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="text-xs text-red-500">{{ error }}</p>
  </div>
</template>
