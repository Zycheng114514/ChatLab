<script setup lang="ts">
// 私聊洞察「亲密关系」子标签：K1 个人分享。
// 页面只报告「在所选范围内识别到多少个这样的事件」，不给分数、比例或好坏判断。
import { computed, onUnmounted, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { useI18n } from 'vue-i18n'
import type { TimeFilter } from '@openchatlab/shared-types'
import { EmptyState, LoadingState, SectionCard } from '@/components/UI'
import { useToast } from '@/composables/useToast'
import { useLayoutStore } from '@/stores/layout'
import { useSettingsStore } from '@/stores/settings'
import { buildReadySerializablePreprocessConfig } from '@/stores/aiPreprocessConfig'
import { IS_WEB_WASM } from '@/utils/platform'
import {
  IntimacyRequestError,
  useIntimacyService,
  type IntimacyEvent,
  type IntimacyPreflight,
  type IntimacyResults,
  type IntimacyRun,
  type SharingCategory,
  type SharingTopic,
} from '@/services'
import IntimacyCandidatePanel from './IntimacyCandidatePanel.vue'
import IntimacyEventList from './IntimacyEventList.vue'
import {
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPIC_LABEL_KEYS,
  buildIntimacyTopicFilterOptions,
  filterIntimacyEventsByTopic,
  partitionIntimacyEvents,
  selectSharingEvents,
  summarizeIntimacyEvents,
  type IntimacyTopicFilter,
} from './intimacy-summary'

const props = defineProps<{
  sessionId: string
  timeFilter?: TimeFilter
}>()

const { t, locale } = useI18n()
const toast = useToast()
const layoutStore = useLayoutStore()
const settingsStore = useSettingsStore()
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const results = ref<IntimacyResults | null>(null)
const run = ref<IntimacyRun | null>(null)
const loading = ref(false)
const actionLoading = ref(false)
const topicFilter = ref<IntimacyTopicFilter>('all')
const showExcluded = ref(false)
const showMethods = ref(false)
const showPreflightModal = ref(false)
const showClearModal = ref(false)
const clearReviews = ref(false)
const preflight = ref<IntimacyPreflight | null>(null)
const preflightLoading = ref(false)
let loadVersion = 0
let pollTimer: ReturnType<typeof setTimeout> | null = null

const events = computed(() => results.value?.events ?? [])
const members = computed(() => results.value?.members ?? [])
const sharingEvents = computed(() => selectSharingEvents(events.value))
const filteredEvents = computed(() => filterIntimacyEventsByTopic(sharingEvents.value, topicFilter.value))
const listedEvents = computed(() => partitionIntimacyEvents(filteredEvents.value).listed)
const excludedEvents = computed(() => partitionIntimacyEvents(filteredEvents.value).excluded)
const topicOptions = computed(() => buildIntimacyTopicFilterOptions(sharingEvents.value))
const summaries = computed(() => summarizeIntimacyEvents(filteredEvents.value, members.value))
const hasModel = computed(() => Boolean(results.value?.modelId))

const activeRun = computed(() => run.value && ['pending', 'running'].includes(run.value.status))
const resumableRun = computed(() => run.value && ['paused', 'failed'].includes(run.value.status))
// 后端把暂停中的 run 也算占用，这时开新分析或清除结果都会 409，所以按钮先禁用。
const blockingRun = computed(() => run.value && ['pending', 'running', 'paused'].includes(run.value.status))
const progressPercent = computed(() => {
  if (!run.value || run.value.totalWindows === 0) return 0
  return Math.min(100, Math.round((run.value.completedWindows / run.value.totalWindows) * 100))
})

const rangeText = computed(() => {
  const startTs = results.value?.coverage?.targetStartTs ?? props.timeFilter?.startTs
  const endTs = results.value?.coverage?.targetEndTs ?? props.timeFilter?.endTs
  if (startTs === undefined || endTs === undefined) return t('views.intimacy.info.rangeAll')
  return t('views.intimacy.info.range', { start: formatDay(startTs), end: formatDay(endTs) })
})

const sourceText = computed(() => {
  const resultRun = results.value?.run
  if (resultRun) {
    return t('views.intimacy.info.sourceModel', {
      model: resultRun.modelId ?? '—',
      time: dayjs(resultRun.createdAt).format('YYYY-MM-DD HH:mm'),
    })
  }
  return events.value.length > 0 ? t('views.intimacy.info.sourceUserOnly') : t('views.intimacy.info.sourceNone')
})

async function loadResults(options: { silent?: boolean } = {}) {
  const version = ++loadVersion
  clearPollTimer()
  if (!options.silent) loading.value = true
  try {
    const next = await useIntimacyService().getResults(props.sessionId, {
      startTs: props.timeFilter?.startTs,
      endTs: props.timeFilter?.endTs,
    })
    if (version !== loadVersion) return
    results.value = next
    run.value = next.latestRun
    schedulePoll()
  } catch (error) {
    if (version !== loadVersion) return
    toast.fail(t('views.intimacy.loadFailed'), { description: errorMessage(error) })
  } finally {
    if (version === loadVersion && !options.silent) loading.value = false
  }
}

async function refreshRun() {
  if (!run.value) return
  try {
    const next = await useIntimacyService().getRun(props.sessionId, run.value.id)
    const changed = next.status !== run.value.status || next.completedWindows !== run.value.completedWindows
    run.value = next
    // 每提交一个窗口就重新拉结果，事件是逐段出现的。
    if (changed) await loadResults({ silent: true })
    else schedulePoll()
  } catch {
    clearPollTimer()
  }
}

function schedulePoll() {
  clearPollTimer()
  if (run.value && ['pending', 'running'].includes(run.value.status)) {
    pollTimer = setTimeout(() => void refreshRun(), 800)
  }
}

function clearPollTimer() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function openPreflight() {
  showPreflightModal.value = true
  preflight.value = null
  preflightLoading.value = true
  try {
    preflight.value = await useIntimacyService().preflight(props.sessionId, analysisRequest())
  } catch (error) {
    toast.fail(t('views.intimacy.preflight.failed'), { description: errorMessage(error) })
  } finally {
    preflightLoading.value = false
  }
}

function analysisRequest() {
  return {
    kinds: ['sharing' as const],
    startTs: props.timeFilter?.startTs,
    endTs: props.timeFilter?.endTs,
    locale: locale.value,
    timezone,
  }
}

async function startRun() {
  actionLoading.value = true
  try {
    run.value = await useIntimacyService().start(props.sessionId, {
      ...analysisRequest(),
      preprocessConfig: await buildReadySerializablePreprocessConfig(settingsStore),
    })
    showPreflightModal.value = false
    schedulePoll()
  } catch (error) {
    toast.fail(t('views.intimacy.actions.startFailed'), { description: errorMessage(error) })
  } finally {
    actionLoading.value = false
  }
}

async function runAction(action: 'pause' | 'resume' | 'cancel') {
  if (!run.value) return
  actionLoading.value = true
  try {
    run.value = await useIntimacyService()[action](props.sessionId, run.value.id)
    // 暂停 / 取消后已提交的窗口仍然算数，重新拉一次才能看到它们和最终的覆盖情况。
    await loadResults({ silent: true })
  } catch (error) {
    toast.fail(t('views.intimacy.actions.actionFailed'), { description: errorMessage(error) })
  } finally {
    actionLoading.value = false
  }
}

async function clearAllResults() {
  actionLoading.value = true
  try {
    await useIntimacyService().clearResults(props.sessionId, { includeReviews: clearReviews.value })
    showClearModal.value = false
    clearReviews.value = false
    run.value = null
    await loadResults()
  } catch (error) {
    toast.fail(t('views.intimacy.actions.clearFailed'), { description: errorMessage(error) })
  } finally {
    actionLoading.value = false
  }
}

async function handleReview(payload: {
  event: IntimacyEvent
  decision: 'included' | 'excluded'
  details?: { categories: SharingCategory[]; topic: SharingTopic }
}) {
  actionLoading.value = true
  try {
    await useIntimacyService().reviewEvent(props.sessionId, payload.event.id, {
      decision: payload.decision,
      expectedRevision: payload.event.review?.revision ?? 0,
      details: payload.details,
    })
  } catch (error) {
    if (error instanceof IntimacyRequestError && error.status === 409) {
      toast.fail(t('views.intimacy.event.conflict'))
    } else {
      toast.fail(t('views.intimacy.event.saveFailed'), { description: errorMessage(error) })
    }
  } finally {
    actionLoading.value = false
  }
  // 修订接口返回的是不带时间范围的结果，所以统一按页面范围重新拉一次。
  await loadResults({ silent: true })
}

function viewMessage(messageId: number) {
  layoutStore.openChatRecordDrawer({ sessionId: props.sessionId, scrollToMessageId: messageId })
}

function memberName(memberId: number): string {
  return members.value.find((member) => member.memberId === memberId)?.name ?? String(memberId)
}

function formatDay(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

watch(
  () => [props.sessionId, props.timeFilter],
  () => {
    if (IS_WEB_WASM) return
    topicFilter.value = 'all'
    void loadResults()
  },
  { immediate: true, deep: true }
)

onUnmounted(clearPollTimer)
</script>

<template>
  <div v-if="IS_WEB_WASM" class="main-content mx-auto max-w-[920px] p-4 sm:p-6">
    <SectionCard :title="t('views.intimacy.k1.title')" :capturable="false">
      <EmptyState padding="lg" :text="t('views.intimacy.unavailable.title')" />
      <p class="px-6 pb-6 text-center text-xs leading-relaxed text-gray-400">
        {{ t('views.intimacy.unavailable.description') }}
      </p>
    </SectionCard>
  </div>

  <div v-else :class="loading ? 'h-full' : ''">
    <LoadingState v-if="loading" variant="page" :text="t('common.loading')" />
    <div v-else class="main-content mx-auto max-w-[920px] space-y-4 p-4 sm:p-6">
      <!-- 信息条 -->
      <section class="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span v-if="members.length > 0" class="font-medium text-gray-700 dark:text-gray-200">
            {{ members.map((member) => member.name).join(' · ') }}
          </span>
          <span>{{ rangeText }}</span>
          <span>{{ sourceText }}</span>
          <span v-if="results?.coverage">
            {{
              t('views.intimacy.info.coverage', {
                completed: results.coverage.completedWindows,
                total: results.coverage.totalWindows,
              })
            }}
          </span>
        </div>
        <p
          v-if="results?.coverage && !results.coverage.complete"
          class="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400"
        >
          {{ t('views.intimacy.info.coverageIncomplete') }}
          <span v-if="results.coverage.failedWindows > 0">
            {{ t('views.intimacy.info.coverageFailed', { count: results.coverage.failedWindows }) }}
          </span>
        </p>
        <p v-if="results?.coverage?.sourceChanged" class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {{ t('views.intimacy.info.sourceChanged') }}
        </p>
        <p v-if="results && results.orphanReviews > 0" class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {{ t('views.intimacy.info.orphanReviews', { count: results.orphanReviews }) }}
        </p>
      </section>

      <!-- 操作区 -->
      <section class="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            color="primary"
            size="sm"
            icon="i-heroicons-sparkles"
            :disabled="!results || !hasModel || Boolean(blockingRun) || actionLoading"
            @click="openPreflight"
          >
            {{ results?.run ? t('views.intimacy.actions.reanalyze') : t('views.intimacy.actions.analyze') }}
          </UButton>
          <UButton
            v-if="results?.run || events.length > 0"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="Boolean(blockingRun) || actionLoading"
            @click="showClearModal = true"
          >
            {{ t('views.intimacy.actions.clear') }}
          </UButton>
          <span v-if="results && !hasModel" class="text-xs text-amber-600 dark:text-amber-400">
            {{ t('common.errorNoAIConfig') }}
          </span>
        </div>
        <p v-if="results && !hasModel" class="mt-1.5 text-[11px] text-gray-400">
          {{ t('views.intimacy.k1.noModelHint') }}
        </p>

        <div v-if="run && (activeRun || resumableRun)" class="mt-3">
          <div class="flex items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <UIcon
                :name="activeRun ? 'i-heroicons-arrow-path' : 'i-heroicons-pause-circle'"
                class="h-4 w-4 shrink-0 text-pink-500"
                :class="{ 'animate-spin': activeRun }"
              />
              <span class="truncate">{{ t(`views.intimacy.run.status.${run.status}`) }}</span>
            </span>
            <span class="text-[11px] tabular-nums text-gray-400">
              {{ t('views.intimacy.run.progress', { completed: run.completedWindows, total: run.totalWindows }) }}
            </span>
          </div>
          <UProgress class="mt-2" :value="progressPercent" size="xs" />
          <p v-if="run.lastError" class="mt-1 line-clamp-2 text-[11px] text-gray-500">{{ run.lastError }}</p>
          <div class="mt-2 flex gap-1.5">
            <UButton
              v-if="activeRun"
              size="xs"
              color="neutral"
              variant="soft"
              :disabled="actionLoading"
              @click="runAction('pause')"
            >
              {{ t('common.pause') }}
            </UButton>
            <UButton
              v-if="resumableRun"
              size="xs"
              color="primary"
              variant="soft"
              :loading="actionLoading"
              @click="runAction('resume')"
            >
              {{ t('common.resume') }}
            </UButton>
            <UButton size="xs" color="neutral" variant="ghost" :disabled="actionLoading" @click="runAction('cancel')">
              {{ t('common.cancel') }}
            </UButton>
          </div>
        </div>
      </section>

      <!-- K1 个人分享 -->
      <SectionCard :title="t('views.intimacy.k1.title')" :description="t('views.intimacy.k1.definition')">
        <div class="px-5 py-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <div
              v-for="summary in summaries"
              :key="summary.memberId"
              class="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700"
            >
              <p class="truncate text-xs text-gray-500 dark:text-gray-400">{{ memberName(summary.memberId) }}</p>
              <p class="mt-1 font-mono text-2xl font-black tabular-nums text-gray-900 dark:text-white">
                {{ summary.counted }}
              </p>
              <p class="text-[11px] text-gray-400">{{ t('views.intimacy.k1.countedLabel') }}</p>
              <p class="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                {{
                  t('views.intimacy.k1.countBreakdown', {
                    auto: summary.autoCount,
                    confirmed: summary.confirmedCount,
                    uncertain: summary.uncertainCount,
                  })
                }}
              </p>
            </div>
          </div>

          <p class="mt-3 text-[11px] text-gray-400">{{ t('views.intimacy.k1.uncertainNote') }}</p>

          <div class="mt-4">
            <p class="text-xs font-medium text-gray-600 dark:text-gray-300">
              {{ t('views.intimacy.k1.categoryTitle') }}
            </p>
            <div class="mt-2 grid grid-cols-3 gap-3">
              <div
                v-for="category in SHARING_CATEGORIES"
                :key="category"
                class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50"
              >
                <p class="truncate text-[11px] text-gray-400">{{ t(SHARING_CATEGORY_LABEL_KEYS[category]) }}</p>
                <p class="mt-0.5 font-mono text-sm font-bold tabular-nums text-gray-700 dark:text-gray-200">
                  {{ summaries.reduce((total, summary) => total + summary.byCategory[category], 0) }}
                </p>
              </div>
            </div>
            <p class="mt-1.5 text-[11px] text-gray-400">{{ t('views.intimacy.k1.categoryNote') }}</p>
          </div>

          <div v-if="topicOptions.length > 1" class="mt-4 flex flex-wrap items-center gap-1.5">
            <span class="mr-1 text-[11px] text-gray-400">{{ t('views.intimacy.k1.topicFilter') }}</span>
            <button
              v-for="option in topicOptions"
              :key="option.topic"
              type="button"
              class="rounded-full px-2 py-0.5 text-[11px] transition-colors"
              :class="
                topicFilter === option.topic
                  ? 'bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400'
              "
              @click="topicFilter = option.topic"
            >
              {{ option.topic === 'all' ? t('views.intimacy.k1.topicAll') : t(SHARING_TOPIC_LABEL_KEYS[option.topic]) }}
              ({{ option.count }})
            </button>
          </div>
        </div>

        <EmptyState v-if="listedEvents.length === 0" :text="t('views.intimacy.k1.empty')" />
        <IntimacyEventList
          v-else
          :events="listedEvents"
          :messages="results?.messages ?? {}"
          :members="members"
          :busy="actionLoading"
          @view="viewMessage"
          @review="handleReview"
        />

        <template v-if="excludedEvents.length > 0">
          <button
            type="button"
            class="flex w-full items-center gap-1 border-t border-gray-100 px-5 py-2 text-left text-[11px] text-gray-400 hover:text-gray-600 dark:border-gray-800 dark:hover:text-gray-300"
            @click="showExcluded = !showExcluded"
          >
            <UIcon :name="showExcluded ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right'" class="h-3 w-3" />
            {{ t('views.intimacy.event.excludedGroup', { count: excludedEvents.length }) }}
          </button>
          <IntimacyEventList
            v-if="showExcluded"
            :events="excludedEvents"
            :messages="results?.messages ?? {}"
            :members="members"
            :busy="actionLoading"
            @view="viewMessage"
            @review="handleReview"
          />
        </template>
      </SectionCard>

      <!-- 候选检索 -->
      <SectionCard :title="t('views.intimacy.candidates.title')" :capturable="false">
        <IntimacyCandidatePanel
          :session-id="props.sessionId"
          :semantic-available="results?.semanticSearchAvailable ?? false"
          :time-filter="props.timeFilter"
          @created="loadResults({ silent: true })"
        />
      </SectionCard>

      <!-- 方法与来源 -->
      <section class="rounded-xl border border-gray-200 dark:border-gray-700">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-gray-600 dark:text-gray-300"
          @click="showMethods = !showMethods"
        >
          <UIcon :name="showMethods ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right'" class="h-3.5 w-3.5" />
          {{ t('views.intimacy.methods.title') }}
        </button>
        <div v-if="showMethods" class="space-y-3 px-4 pb-4 text-[11px] leading-relaxed text-gray-500">
          <div>
            <p class="font-medium text-gray-600 dark:text-gray-300">
              {{ t('views.intimacy.methods.definitionTitle') }}
            </p>
            <p class="mt-0.5">{{ t('views.intimacy.methods.definitionBody') }}</p>
          </div>
          <div>
            <p class="font-medium text-gray-600 dark:text-gray-300">{{ t('views.intimacy.methods.includeTitle') }}</p>
            <p class="mt-0.5">{{ t('views.intimacy.methods.includeBody') }}</p>
          </div>
          <div>
            <p class="font-medium text-gray-600 dark:text-gray-300">{{ t('views.intimacy.methods.countingTitle') }}</p>
            <p class="mt-0.5">{{ t('views.intimacy.methods.countingBody') }}</p>
          </div>
          <div>
            <p class="font-medium text-gray-600 dark:text-gray-300">{{ t('views.intimacy.methods.sourceTitle') }}</p>
            <p class="mt-0.5">{{ t('views.intimacy.methods.sourceCitation') }}</p>
            <a
              href="https://doi.org/10.1037/0022-3514.74.5.1238"
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-flex items-center gap-1 text-blue-500 hover:text-blue-600 dark:text-blue-400"
            >
              <UIcon name="i-heroicons-arrow-top-right-on-square" class="h-3 w-3" />
              {{ t('views.intimacy.methods.sourceLink') }}
            </a>
          </div>
          <div>
            <p class="font-medium text-gray-600 dark:text-gray-300">
              {{ t('views.intimacy.methods.limitationTitle') }}
            </p>
            <p class="mt-0.5">{{ t('views.intimacy.methods.limitationBody') }}</p>
          </div>
        </div>
      </section>
    </div>
  </div>

  <UModal v-model:open="showPreflightModal" :ui="{ content: 'sm:max-w-lg' }">
    <template #content>
      <UCard>
        <template #header>
          <h3 class="text-base font-semibold">{{ t('views.intimacy.preflight.title') }}</h3>
          <p class="mt-0.5 text-xs text-gray-400">{{ t('views.intimacy.preflight.description') }}</p>
        </template>

        <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/50">
          <div v-if="preflightLoading" class="flex h-16 items-center justify-center">
            <UIcon name="i-heroicons-arrow-path" class="h-4 w-4 animate-spin text-gray-400" />
          </div>
          <div v-else-if="preflight">
            <p class="mb-2 text-center text-[11px] text-gray-400">
              {{
                t('views.intimacy.preflight.range', {
                  start: formatDay(preflight.targetStartTs),
                  end: formatDay(preflight.targetEndTs),
                })
              }}
            </p>
            <div class="grid grid-cols-3 gap-3 text-center">
              <div>
                <p class="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {{ preflight.messageCount }}
                </p>
                <p class="text-[11px] text-gray-400">{{ t('views.intimacy.preflight.messages') }}</p>
              </div>
              <div>
                <p class="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {{ preflight.estimatedWindows }}
                </p>
                <p class="text-[11px] text-gray-400">{{ t('views.intimacy.preflight.windows') }}</p>
              </div>
              <div>
                <p class="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {{ preflight.estimatedCalls }}
                </p>
                <p class="text-[11px] text-gray-400">{{ t('views.intimacy.preflight.calls') }}</p>
              </div>
            </div>
            <p class="mt-3 text-center text-[11px] text-gray-400">
              {{ t('views.intimacy.preflight.model') }}: {{ preflight.modelId ?? '—' }}
            </p>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="showPreflightModal = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="primary"
              :loading="actionLoading"
              :disabled="preflightLoading || !preflight || preflight.messageCount === 0 || !preflight.modelId"
              @click="startRun"
            >
              {{
                preflight?.messageCount === 0
                  ? t('views.intimacy.preflight.noMessages')
                  : t('views.intimacy.preflight.start')
              }}
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>

  <UModal v-model:open="showClearModal" :ui="{ content: 'sm:max-w-md' }">
    <template #content>
      <UCard>
        <template #header>
          <h3 class="text-base font-semibold">{{ t('views.intimacy.actions.clearTitle') }}</h3>
        </template>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('views.intimacy.actions.clearDescription') }}</p>
        <UCheckbox v-model="clearReviews" class="mt-3" :label="t('views.intimacy.actions.clearReviews')" size="sm" />
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="showClearModal = false">{{ t('common.cancel') }}</UButton>
            <UButton color="error" :loading="actionLoading" @click="clearAllResults">{{ t('common.delete') }}</UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
