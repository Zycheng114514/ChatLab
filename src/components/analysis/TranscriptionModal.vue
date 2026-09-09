<script setup lang="ts">
/**
 * 语音转文字弹窗（当前对话）
 *
 * 解码在页面里（Web Audio 能读 Chromium 支持的全部音频容器），推理在 Node 侧，
 * 一条一条串行做：解码 → 上传 PCM → 后端落库。模型档位在 设置 > AI > 语音转文字，
 * 这里只能临时换语言。Web WASM 没有转写能力，入口不会渲染。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UITabs from '@/components/UI/Tabs.vue'
import { usePlatformService, useTranscriptionService } from '@/services'
import type { PendingTranscriptionItem, TranscriptionLanguage, TranscriptionSettings } from '@/services'
import { AudioTooLongError, decodeAudioToPcm16k, UnsupportedAudioError } from '@/services/transcription/decode-audio'

const props = defineProps<{
  modelValue: boolean
  sessionId: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 至少有一条转写成功；会话页据此重新加载消息。 */
  transcribed: []
}>()

const { t } = useI18n()
const platform = usePlatformService()
const service = useTranscriptionService()

const k = 'analysis.transcription'

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

type ItemState = 'pending' | 'running' | 'done' | 'unsupported' | 'tooLong' | 'failed'

interface QueueItem {
  attachment: PendingTranscriptionItem
  state: ItemState
  /** 失败时后端或解码给出的原文，不翻译、不吞掉。 */
  error: string | null
}

const loading = ref(false)
const loadError = ref<string | null>(null)
const settings = ref<TranscriptionSettings | null>(null)
const language = ref<TranscriptionLanguage>('auto')
const queue = ref<QueueItem[]>([])
const running = ref(false)
const cancelling = ref(false)
/** 首条要等模型加载（数秒到数十秒），进度文案跟着变。 */
const modelLoaded = ref(false)

/**
 * 当前这一轮的序号：取消、关闭、重新加载都让它自增，循环在两条之间发现自己
 * 不再是当前轮就退出。正在进行的那一条等它返回，所以任何时刻只有一条在跑。
 */
let activeRun = 0
let controller: AbortController | null = null

const languageItems = computed(() =>
  (['auto', 'zh', 'en'] as const).map((value) => ({ value, label: t(`common.transcriptionLanguage.${value}`) }))
)

const doneCount = computed(() => queue.value.filter((item) => item.state === 'done').length)
const failedCount = computed(
  () =>
    queue.value.filter((item) => item.state === 'unsupported' || item.state === 'tooLong' || item.state === 'failed')
      .length
)
const finishedCount = computed(() => doneCount.value + failedCount.value)
const progressPercent = computed(() =>
  queue.value.length > 0 ? Math.round((finishedCount.value / queue.value.length) * 100) : 0
)
const hasResults = computed(() => finishedCount.value > 0)

function itemName(item: QueueItem): string {
  return item.attachment.fileName || t(`${k}.unnamedAudio`)
}

function itemStateLabel(item: QueueItem): string {
  if (item.state === 'pending') return t(`${k}.waiting`)
  if (item.state === 'running') return modelLoaded.value ? t(`${k}.transcribing`) : t(`${k}.loadingModel`)
  return t(`${k}.status.${item.state}`)
}

async function load() {
  if (!service) return
  stopRun()
  loading.value = true
  loadError.value = null
  queue.value = []
  modelLoaded.value = false
  try {
    const [config, pending] = await Promise.all([service.getConfig(), service.listPending(props.sessionId)])
    settings.value = config
    language.value = config.language
    queue.value = pending.map((attachment) => ({ attachment, state: 'pending', error: null }))
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

/** 逐条串行；「取消」在两条之间生效，正在进行的那条等它返回。 */
async function start() {
  if (!service || running.value) return
  const token = ++activeRun
  const items = queue.value
  running.value = true
  cancelling.value = false
  controller = new AbortController()
  const signal = controller.signal

  for (const item of items) {
    if (activeRun !== token) break
    if (item.state !== 'pending') continue

    const url = platform.getAttachmentUrl(props.sessionId, item.attachment.id)
    if (!url) {
      item.state = 'unsupported'
      continue
    }

    item.state = 'running'
    item.error = null
    try {
      const pcm = await decodeAudioToPcm16k(url, { signal })
      await service.transcribePcm(props.sessionId, item.attachment.id, pcm, language.value)
      modelLoaded.value = true
      item.state = 'done'
    } catch (error) {
      if (error instanceof UnsupportedAudioError) item.state = 'unsupported'
      else if (error instanceof AudioTooLongError) item.state = 'tooLong'
      else {
        item.state = 'failed'
        item.error = error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (activeRun === token) controller = null
  running.value = false
  cancelling.value = false
}

/** 作废当前这一轮；循环退出时才把 running 放下来，所以不会有两轮并发。 */
function stopRun() {
  if (!running.value) return
  activeRun += 1
  cancelling.value = true
  controller?.abort()
  controller = null
}

function close() {
  stopRun()
  if (doneCount.value > 0) emit('transcribed')
  open.value = false
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) load()
    else stopRun()
  }
)

onUnmounted(stopRun)
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'z-[101]', overlay: 'z-[100]' }">
    <template #content>
      <div class="space-y-4 p-5">
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-microphone" class="h-5 w-5 text-rose-500" />
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t(`${k}.title`) }}</h3>
        </div>

        <div v-if="loading" class="flex items-center gap-2 text-sm text-gray-400">
          <UIcon name="i-heroicons-arrow-path" class="h-4 w-4 animate-spin" />
          {{ t('common.loading') }}
        </div>

        <p v-else-if="loadError" class="text-sm text-red-500">{{ loadError }}</p>

        <template v-else-if="queue.length === 0">
          <p class="text-sm text-gray-600 dark:text-gray-400">{{ t(`${k}.empty`) }}</p>
          <div class="flex justify-end">
            <UButton variant="ghost" @click="close">{{ t('common.close') }}</UButton>
          </div>
        </template>

        <template v-else>
          <p class="text-sm text-gray-600 dark:text-gray-400">{{ t(`${k}.description`) }}</p>

          <div
            class="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/50"
          >
            <div class="flex items-center justify-between">
              <span class="text-gray-500">{{ t(`${k}.pendingLabel`) }}</span>
              <span class="font-medium text-gray-800 dark:text-gray-200">
                {{ t(`${k}.pendingCount`, { count: queue.length }) }}
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-gray-500">{{ t(`${k}.modelLabel`) }}</span>
              <span class="text-gray-700 dark:text-gray-300">{{ settings?.model ?? '' }}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-gray-500">{{ t(`${k}.languageLabel`) }}</span>
              <UITabs v-model="language" :items="languageItems" size="xs" />
            </div>
            <p class="text-xs text-gray-400">{{ t('common.transcriptionLanguage.autoHint') }}</p>
          </div>

          <p v-if="!running && !hasResults" class="text-xs text-gray-400">{{ t(`${k}.downloadHint`) }}</p>

          <!-- 进度 -->
          <div v-if="running || hasResults" class="space-y-1">
            <div class="flex items-center justify-between text-xs text-gray-500">
              <span>{{ t(`${k}.progressLabel`) }}</span>
              <span>{{ finishedCount }} / {{ queue.length }}</span>
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                class="h-full rounded-full bg-rose-500 transition-all duration-500"
                :style="{ width: `${progressPercent}%` }"
              />
            </div>
          </div>

          <!-- 每条的状态与失败原因 -->
          <ul class="max-h-56 space-y-1 overflow-y-auto text-xs">
            <li v-for="item in queue" :key="item.attachment.id">
              <div class="flex items-start justify-between gap-3">
                <span class="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-400">{{ itemName(item) }}</span>
                <span
                  class="shrink-0"
                  :class="{
                    'text-green-600 dark:text-green-400': item.state === 'done',
                    'text-amber-600 dark:text-amber-400': item.state === 'unsupported' || item.state === 'tooLong',
                    'text-red-500': item.state === 'failed',
                    'text-gray-400': item.state === 'pending' || item.state === 'running',
                  }"
                >
                  {{ itemStateLabel(item) }}
                </span>
              </div>
              <p v-if="item.error" class="mt-0.5 break-words text-red-500">{{ item.error }}</p>
            </li>
          </ul>

          <p v-if="!running && hasResults" class="text-xs text-gray-500">
            {{ t(`${k}.summary`, { done: doneCount, failed: failedCount }) }}
          </p>

          <div class="flex justify-end gap-2">
            <UButton v-if="running" color="error" variant="soft" :disabled="cancelling" @click="stopRun">
              {{ t('common.cancel') }}
            </UButton>
            <template v-else>
              <UButton variant="ghost" @click="close">{{ t('common.close') }}</UButton>
              <UButton color="primary" :disabled="finishedCount >= queue.length" @click="start">
                {{ hasResults ? t(`${k}.startRemaining`) : t(`${k}.start`) }}
              </UButton>
            </template>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
