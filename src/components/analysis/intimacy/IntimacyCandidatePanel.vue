<script setup lang="ts">
// 候选检索：没有模型时的手动入口，也可用来补自动分析漏掉的事件。
// 这里检索出来的都是候选消息，只有用户确认过的才会成为事件并计入。
import { computed, ref } from 'vue'
import dayjs from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { getMessageTypeName } from '@/types/base'
import {
  useIntimacyService,
  useMessageService,
  type CreateIntimacyEventRequest,
  type GoodNewsResponseLabel,
  type IntimacyCandidates,
  type IntimacyKind,
  type IntimacyMessageSnippet,
  type MessageRecord,
  type SharedPlanStage,
  type SharingCategory,
  type SharingTopic,
  type SupportResponseLabel,
} from '@/services'
import type { TimeFilter } from '@openchatlab/shared-types'
import {
  GOOD_NEWS_RESPONSE_LABELS,
  GOOD_NEWS_RESPONSE_LABEL_KEYS,
  SHARED_PLAN_STAGES,
  SHARED_PLAN_STAGE_LABEL_KEYS,
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPICS,
  SHARING_TOPIC_LABEL_KEYS,
  SUPPORT_RESPONSE_LABELS,
  SUPPORT_RESPONSE_LABEL_KEYS,
  resolveSharedPlanStages,
  type SharedPlanStageDraft,
} from './intimacy-summary'

const props = defineProps<{
  sessionId: string
  semanticAvailable: boolean
  timeFilter?: TimeFilter
}>()

const emit = defineEmits<{ (event: 'created'): void }>()

const { t } = useI18n()
const toast = useToast()

const KIND_OPTIONS: Array<{ kind: IntimacyKind; labelKey: string; submitKey: string }> = [
  { kind: 'sharing', labelKey: 'views.intimacy.k1.title', submitKey: 'views.intimacy.candidates.submit' },
  {
    kind: 'support_response',
    labelKey: 'views.intimacy.k2.title',
    submitKey: 'views.intimacy.candidates.submitSupport',
  },
  { kind: 'follow_up', labelKey: 'views.intimacy.k3.title', submitKey: 'views.intimacy.candidates.submitFollowUp' },
  {
    kind: 'good_news_response',
    labelKey: 'views.intimacy.k4.title',
    submitKey: 'views.intimacy.candidates.submitGoodNews',
  },
  { kind: 'shared_plan', labelKey: 'views.intimacy.k5.title', submitKey: 'views.intimacy.candidates.submitSharedPlan' },
]

const kind = ref<IntimacyKind>('sharing')
const query = ref('')
const candidates = ref<IntimacyCandidates | null>(null)
const searching = ref(false)
const submitting = ref(false)
/**
 * 关键词命中周围的消息，按命中消息的 id 存。回复、先前的提及和安排的后续阶段往往不含关键词，
 * 展开后它们和命中那条同属一条检索结果，才能被选进同一个事件。
 */
const NEARBY_MESSAGE_COUNT = 8
const nearby = ref(new Map<number, IntimacyMessageSnippet[]>())
const nearbyLoading = ref<number | null>(null)

/**
 * 选中的核心消息必须来自同一个人、同一条检索结果；回复是另一方在同一条结果里、锚点之后的消息，
 * 事后追问的先前消息则是另一方在锚点之前的消息，共同安排的核心消息则是那条提议。
 */
const selection = ref<{
  group: string
  senderId: number
  messageIds: number[]
  responseMessageIds: number[]
  priorMessageIds: number[]
} | null>(null)
const categories = ref<SharingCategory[]>([])
const topic = ref<SharingTopic>('daily_life')
const supportLabels = ref<SupportResponseLabel[]>([])
const goodNewsLabels = ref<GoodNewsResponseLabel[]>([])
const positiveForSharer = ref(false)
const matter = ref('')
const activitySummary = ref('')
/** 共同安排的时间线：第一步是提议（就是选中的核心消息），后面每点一条消息就多一步。 */
const planSteps = ref<SharedPlanStageDraft[]>([])

const isSharing = computed(() => kind.value === 'sharing')
const isFollowUp = computed(() => kind.value === 'follow_up')
const isSharedPlan = computed(() => kind.value === 'shared_plan')
const submitKey = computed(() => KIND_OPTIONS.find((option) => option.kind === kind.value)!.submitKey)
const responseLabelCount = computed(() =>
  kind.value === 'support_response' ? supportLabels.value.length : goodNewsLabels.value.length
)
const topicOptions = computed(() =>
  SHARING_TOPICS.map((value) => ({ value, label: t(SHARING_TOPIC_LABEL_KEYS[value]) }))
)
const stageOptions = computed(() =>
  SHARED_PLAN_STAGES.map((value) => ({ value, label: t(SHARED_PLAN_STAGE_LABEL_KEYS[value]) }))
)
/** 检索结果里的消息，按 id 取回原文与发送者：拼时间线和查发送者都用它。 */
const snippetById = computed(() => {
  const map = new Map<number, IntimacyMessageSnippet>()
  for (const message of candidates.value?.keyword ?? []) map.set(message.messageId, message)
  for (const chunk of candidates.value?.semantic ?? []) {
    for (const message of chunk.messages) map.set(message.messageId, message)
  }
  for (const rows of nearby.value.values()) {
    for (const message of rows) map.set(message.messageId, message)
  }
  return map
})
/** 提交前按后端同一套规则算出每一步的行为者；有问题时 errorKey 就是要显示的提示。 */
const planStages = computed(() =>
  resolveSharedPlanStages(planSteps.value, (messageId) => snippetById.value.get(messageId)?.senderId)
)
const selectHintKey = computed(() => {
  if (isSharing.value) return 'views.intimacy.candidates.selectHint'
  if (isSharedPlan.value) return 'views.intimacy.candidates.planSelectHint'
  return isFollowUp.value
    ? 'views.intimacy.candidates.followUpSelectHint'
    : 'views.intimacy.candidates.responseSelectHint'
})
/** 第二步选中的消息在两种事件里含义不同：回应类是回复，事后追问是更早的先前消息。 */
const secondaryLabelKey = computed(() =>
  isFollowUp.value ? 'views.intimacy.k3.priorColumn' : 'views.intimacy.response.replyColumn'
)
const canSubmit = computed(() => {
  const current = selection.value
  if (!current || current.messageIds.length === 0) return false
  if (isSharing.value) return categories.value.length > 0
  // 安排要有一句活动描述，时间线也要过发送者那一关，否则后端会原样拒绝。
  if (isSharedPlan.value) return activitySummary.value.trim() !== '' && planStages.value.errorKey === null
  // 追问必须配上被问者更早的消息和一句事情描述，否则它不是一个配对。
  if (isFollowUp.value) return current.priorMessageIds.length > 0 && matter.value.trim() !== ''
  // 后端只接受「有回复且有标签」或「两者都没有」，后者记为未见回复。
  return current.responseMessageIds.length > 0 === responseLabelCount.value > 0
})

function selectKind(next: IntimacyKind) {
  if (kind.value === next) return
  kind.value = next
  resetSelection()
}

function resetSelection() {
  selection.value = null
  categories.value = []
  supportLabels.value = []
  goodNewsLabels.value = []
  positiveForSharer.value = false
  matter.value = ''
  activitySummary.value = ''
  planSteps.value = []
}

async function search() {
  const text = query.value.trim()
  if (text === '') return
  searching.value = true
  try {
    candidates.value = await useIntimacyService().searchCandidates(props.sessionId, {
      kind: kind.value,
      query: text,
      startTs: props.timeFilter?.startTs,
      endTs: props.timeFilter?.endTs,
    })
    nearby.value = new Map()
    resetSelection()
  } catch (error) {
    toast.fail(t('views.intimacy.candidates.searchFailed'), { description: errorMessage(error) })
  } finally {
    searching.value = false
  }
}

/** A keyword hit on its own, or the hit inside the messages around it once they have been loaded. */
function keywordRows(message: IntimacyMessageSnippet): IntimacyMessageSnippet[] {
  const rows = nearby.value.get(message.messageId)
  if (!rows) return [message]
  return [...rows, message].sort((left, right) => left.messageId - right.messageId)
}

async function toggleNearby(message: IntimacyMessageSnippet) {
  if (nearby.value.has(message.messageId)) {
    const next = new Map(nearby.value)
    next.delete(message.messageId)
    nearby.value = next
    return
  }
  nearbyLoading.value = message.messageId
  try {
    const records = await useMessageService().getMessageContext(
      props.sessionId,
      message.messageId,
      NEARBY_MESSAGE_COUNT
    )
    const next = new Map(nearby.value)
    next.set(message.messageId, records.filter((record) => record.id !== message.messageId).map(toSnippet))
    nearby.value = next
  } catch (error) {
    toast.fail(t('views.intimacy.candidates.searchFailed'), { description: errorMessage(error) })
  } finally {
    nearbyLoading.value = null
  }
}

function toSnippet(record: MessageRecord): IntimacyMessageSnippet {
  return {
    messageId: record.id,
    senderId: record.senderId,
    senderName: record.senderName,
    timestamp: record.timestamp,
    type: record.type,
    content: record.type === 0 ? record.content : '',
  }
}

function isCoreSelected(group: string, messageId: number): boolean {
  return selection.value?.group === group && selection.value.messageIds.includes(messageId)
}

function isSecondarySelected(group: string, messageId: number): boolean {
  const current = selection.value
  if (current?.group !== group) return false
  // 安排的第一步就是提议本身，它在核心那一栏里高亮，所以这里只看后面的步骤。
  if (isSharedPlan.value) {
    return planSteps.value.some((step, index) => index > 0 && step.messageIds.includes(messageId))
  }
  return current.responseMessageIds.includes(messageId) || current.priorMessageIds.includes(messageId)
}

/** 被选进时间线的消息标出它属于哪一步；其它 kind 只有「回复」或「先前」一种说法。 */
function secondaryTag(messageId: number): string {
  if (!isSharedPlan.value) return t(secondaryLabelKey.value)
  const step = planSteps.value.find((item) => item.messageIds.includes(messageId))
  return step ? t(SHARED_PLAN_STAGE_LABEL_KEYS[step.stage]) : ''
}

/** 回复必须在倾诉 / 好消息之后；追问问的那件事必须在追问之前，所以两种方向刚好相反。 */
function canPick(group: string, message: IntimacyMessageSnippet): boolean {
  const current = selection.value
  if (!current || current.group !== group) return true
  // 安排的每一步都要在提议之后；提议本身仍可点，用来重新开始。
  if (isSharedPlan.value) return message.messageId >= Math.min(...current.messageIds)
  if (isSharing.value || current.senderId === message.senderId) return true
  return isFollowUp.value
    ? message.messageId < Math.min(...current.messageIds)
    : message.messageId > Math.min(...current.messageIds)
}

function toggleMessage(group: string, message: IntimacyMessageSnippet) {
  const current = selection.value
  if (!current || current.group !== group) {
    selection.value = startSelection(group, message)
    // 共同安排先点的是提议，它自己就是时间线的第一步。
    if (isSharedPlan.value) planSteps.value = [{ stage: 'proposed', messageIds: [message.messageId] }]
    return
  }
  if (isSharedPlan.value) {
    togglePlanMessage(current, message)
    return
  }
  if (current.senderId === message.senderId) {
    const messageIds = toggleId(current.messageIds, message.messageId)
    selection.value = messageIds.length === 0 ? null : { ...current, messageIds }
    return
  }
  if (isSharing.value) {
    selection.value = startSelection(group, message)
    return
  }
  if (!canPick(group, message)) return
  selection.value = isFollowUp.value
    ? { ...current, priorMessageIds: toggleId(current.priorMessageIds, message.messageId) }
    : { ...current, responseMessageIds: toggleId(current.responseMessageIds, message.messageId) }
}

/**
 * 后面的每一条消息各成一步，谁发的就由谁行动；只有「双方确认」需要两条，
 * 所以那一步还缺一条时，下一次点击补进同一步而不是新开一步。
 */
function togglePlanMessage(current: NonNullable<typeof selection.value>, message: IntimacyMessageSnippet) {
  const messageId = message.messageId
  // 取消提议等于重新开始：后面的步骤都是挂在这条提议上的。
  if (current.messageIds.includes(messageId)) {
    resetSelection()
    return
  }
  const picked = planSteps.value.findIndex((step) => step.messageIds.includes(messageId))
  if (picked >= 0) {
    const messageIds = planSteps.value[picked]!.messageIds.filter((item) => item !== messageId)
    planSteps.value =
      messageIds.length === 0
        ? planSteps.value.filter((_, index) => index !== picked)
        : planSteps.value.map((step, index) => (index === picked ? { ...step, messageIds } : step))
    return
  }
  const open = planSteps.value.findIndex((step) => step.stage === 'mutually_confirmed' && step.messageIds.length < 2)
  planSteps.value =
    open >= 0
      ? planSteps.value.map((step, index) =>
          index === open ? { ...step, messageIds: toggleId(step.messageIds, messageId) } : step
        )
      : [...planSteps.value, { stage: 'discussed', messageIds: [messageId] }]
}

function setStepStage(index: number, stage: SharedPlanStage) {
  planSteps.value = planSteps.value.map((step, position) => (position === index ? { ...step, stage } : step))
}

function startSelection(group: string, message: IntimacyMessageSnippet): NonNullable<typeof selection.value> {
  return {
    group,
    senderId: message.senderId,
    messageIds: [message.messageId],
    responseMessageIds: [],
    priorMessageIds: [],
  }
}

function toggleId(ids: number[], messageId: number): number[] {
  return ids.includes(messageId)
    ? ids.filter((id) => id !== messageId)
    : [...ids, messageId].sort((left, right) => left - right)
}

function toggleCategory(category: SharingCategory, checked: boolean) {
  const next = new Set(categories.value)
  if (checked) next.add(category)
  else next.delete(category)
  categories.value = SHARING_CATEGORIES.filter((item) => next.has(item))
}

function toggleSupportLabel(label: SupportResponseLabel, checked: boolean) {
  const next = new Set(supportLabels.value)
  if (checked) next.add(label)
  else next.delete(label)
  supportLabels.value = SUPPORT_RESPONSE_LABELS.filter((item) => next.has(item))
}

function toggleGoodNewsLabel(label: GoodNewsResponseLabel, checked: boolean) {
  const next = new Set(goodNewsLabels.value)
  if (checked) next.add(label)
  else next.delete(label)
  goodNewsLabels.value = GOOD_NEWS_RESPONSE_LABELS.filter((item) => next.has(item))
}

function buildRequest(current: NonNullable<typeof selection.value>): CreateIntimacyEventRequest {
  const core = { subjectMemberId: current.senderId, coreMessageIds: [...current.messageIds] }
  if (kind.value === 'support_response') {
    return {
      kind: 'support_response',
      ...core,
      responseMessageIds: [...current.responseMessageIds],
      details: { responseLabels: [...supportLabels.value] },
    }
  }
  if (kind.value === 'follow_up') {
    // K3 的核心消息是追问，所以 subjectMemberId 是追问者；事件主体（被问者）由服务端定。
    return {
      kind: 'follow_up',
      ...core,
      priorMessageIds: [...current.priorMessageIds],
      details: { matter: matter.value.trim() },
    }
  }
  if (kind.value === 'shared_plan') {
    // 核心消息是提议，所以 subjectMemberId 是提议者；每一步的行为者由发送者决定。
    return {
      kind: 'shared_plan',
      ...core,
      details: { activitySummary: activitySummary.value.trim(), stages: planStages.value.stages },
    }
  }
  if (kind.value === 'good_news_response') {
    return {
      kind: 'good_news_response',
      ...core,
      responseMessageIds: [...current.responseMessageIds],
      details: {
        positiveForSharer: positiveForSharer.value ? 'explicit_or_context_supported' : 'uncertain',
        responseLabels: [...goodNewsLabels.value],
      },
    }
  }
  return {
    kind: 'sharing',
    ...core,
    // 用户没有被问「这是不是倾诉」，所以如实记为未定，不替他做判断。
    details: { categories: [...categories.value], topic: topic.value, isDistressDisclosure: 'uncertain' },
  }
}

async function submit() {
  const current = selection.value
  if (!current || !canSubmit.value) return
  submitting.value = true
  try {
    await useIntimacyService().createUserEvent(props.sessionId, buildRequest(current))
    resetSelection()
    toast.success(t('views.intimacy.candidates.submitted'))
    emit('created')
  } catch (error) {
    toast.fail(t('views.intimacy.candidates.submitFailed'), { description: errorMessage(error) })
  } finally {
    submitting.value = false
  }
}

function messageText(message: IntimacyMessageSnippet): string {
  return message.content || `[${getMessageTypeName(message.type, t)}]`
}

function formatTime(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <div class="px-5 py-4">
    <p class="rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-500 dark:bg-gray-800/50">
      {{ t('views.intimacy.candidates.notice') }}
    </p>

    <div class="mt-3 flex flex-wrap items-center gap-1.5">
      <span class="mr-1 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.kind') }}</span>
      <button
        v-for="option in KIND_OPTIONS"
        :key="option.kind"
        type="button"
        class="rounded-full px-2 py-0.5 text-[11px] transition-colors"
        :class="
          kind === option.kind
            ? 'bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300'
            : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400'
        "
        @click="selectKind(option.kind)"
      >
        {{ t(option.labelKey) }}
      </button>
    </div>

    <div class="mt-3 flex gap-2">
      <UInput
        v-model="query"
        :placeholder="t('views.intimacy.candidates.placeholder')"
        class="flex-1"
        size="sm"
        @keydown.enter="search"
      />
      <UButton size="sm" color="primary" :loading="searching" :disabled="query.trim() === ''" @click="search">
        {{ t('views.intimacy.candidates.search') }}
      </UButton>
    </div>

    <p v-if="!semanticAvailable" class="mt-2 text-[11px] text-gray-400">
      {{ t('views.intimacy.candidates.semanticUnavailable') }}
    </p>

    <template v-if="candidates">
      <p class="mt-3 text-[11px] text-gray-400">{{ t(selectHintKey) }}</p>
      <p v-if="isSharing" class="text-[11px] text-gray-400">
        {{ t('views.intimacy.candidates.sameGroupOnly') }}
      </p>

      <div class="mt-3 grid gap-4 md:grid-cols-2">
        <section>
          <h4 class="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            {{ t('views.intimacy.candidates.keyword') }}
          </h4>
          <p v-if="candidates.keyword.length === 0" class="text-xs text-gray-400">
            {{ t('views.intimacy.candidates.empty') }}
          </p>
          <ul v-else class="space-y-1">
            <li
              v-for="message in candidates.keyword"
              :key="message.messageId"
              :class="
                nearby.has(message.messageId) ? 'rounded-lg border border-gray-200 p-1.5 dark:border-gray-700' : ''
              "
            >
              <ul class="space-y-1">
                <li v-for="row in keywordRows(message)" :key="row.messageId">
                  <button
                    type="button"
                    class="w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors"
                    :disabled="!canPick('keyword', row)"
                    :class="[
                      isCoreSelected('keyword', row.messageId)
                        ? 'border-pink-400 bg-pink-50/60 dark:border-pink-700 dark:bg-pink-950/20'
                        : isSecondarySelected('keyword', row.messageId)
                          ? 'border-blue-400 bg-blue-50/60 dark:border-blue-700 dark:bg-blue-950/20'
                          : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50',
                      canPick('keyword', row) ? '' : 'cursor-not-allowed opacity-50',
                    ]"
                    @click="toggleMessage('keyword', row)"
                  >
                    <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                      <span class="truncate">{{ row.senderName }}</span>
                      <span class="tabular-nums">{{ formatTime(row.timestamp) }}</span>
                      <span v-if="isSecondarySelected('keyword', row.messageId)" class="text-blue-500">
                        {{ secondaryTag(row.messageId) }}
                      </span>
                    </span>
                    <span class="mt-0.5 block text-xs leading-relaxed text-gray-700 dark:text-gray-200">
                      {{ messageText(row) }}
                    </span>
                  </button>
                </li>
              </ul>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                class="mt-0.5"
                :loading="nearbyLoading === message.messageId"
                @click="toggleNearby(message)"
              >
                {{
                  t(
                    nearby.has(message.messageId)
                      ? 'views.intimacy.candidates.hideNearby'
                      : 'views.intimacy.candidates.showNearby'
                  )
                }}
              </UButton>
            </li>
          </ul>
        </section>

        <section>
          <h4 class="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            {{ t('views.intimacy.candidates.semantic') }}
          </h4>
          <p v-if="candidates.semantic.length === 0" class="text-xs text-gray-400">
            {{ candidates.semanticAvailable ? t('views.intimacy.candidates.empty') : '—' }}
          </p>
          <div v-else class="space-y-2">
            <div
              v-for="(chunk, index) in candidates.semantic"
              :key="index"
              class="rounded-lg border border-gray-200 p-1.5 dark:border-gray-700"
            >
              <ul class="space-y-1">
                <li v-for="message in chunk.messages" :key="message.messageId">
                  <button
                    type="button"
                    class="w-full rounded px-2 py-1 text-left transition-colors"
                    :disabled="!canPick(`semantic:${index}`, message)"
                    :class="[
                      isCoreSelected(`semantic:${index}`, message.messageId)
                        ? 'bg-pink-50 dark:bg-pink-950/20'
                        : isSecondarySelected(`semantic:${index}`, message.messageId)
                          ? 'bg-blue-50 dark:bg-blue-950/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50',
                      canPick(`semantic:${index}`, message) ? '' : 'cursor-not-allowed opacity-50',
                    ]"
                    @click="toggleMessage(`semantic:${index}`, message)"
                  >
                    <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                      <span class="truncate">{{ message.senderName }}</span>
                      <span class="tabular-nums">{{ formatTime(message.timestamp) }}</span>
                      <span v-if="isSecondarySelected(`semantic:${index}`, message.messageId)" class="text-blue-500">
                        {{ secondaryTag(message.messageId) }}
                      </span>
                    </span>
                    <span class="mt-0.5 block text-xs leading-relaxed text-gray-700 dark:text-gray-200">
                      {{ messageText(message) }}
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      <div v-if="selection" class="mt-4 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ t('views.intimacy.candidates.selected', { count: selection.messageIds.length }) }}
            <template v-if="isFollowUp">
              ·
              {{ t('views.intimacy.candidates.selectedPriors', { count: selection.priorMessageIds.length }) }}
            </template>
            <template v-else-if="isSharedPlan">
              ·
              {{ t('views.intimacy.candidates.selectedPlanSteps', { count: planSteps.length }) }}
            </template>
            <template v-else-if="!isSharing">
              ·
              {{ t('views.intimacy.candidates.selectedResponses', { count: selection.responseMessageIds.length }) }}
            </template>
          </span>
          <UButton size="xs" color="neutral" variant="ghost" @click="resetSelection">
            {{ t('views.intimacy.candidates.clearSelection') }}
          </UButton>
        </div>

        <template v-if="isSharing">
          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.categories') }}</p>
          <div class="mt-1 flex flex-wrap items-center gap-3">
            <UCheckbox
              v-for="category in SHARING_CATEGORIES"
              :key="category"
              :model-value="categories.includes(category)"
              :label="t(SHARING_CATEGORY_LABEL_KEYS[category])"
              size="xs"
              @update:model-value="toggleCategory(category, $event === true)"
            />
          </div>

          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.topic') }}</p>
          <USelect v-model="topic" :items="topicOptions" value-key="value" size="xs" class="mt-1 w-36" />
        </template>

        <template v-else-if="isFollowUp">
          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.matter') }}</p>
          <UInput
            v-model="matter"
            class="mt-1 w-full"
            size="xs"
            :placeholder="t('views.intimacy.candidates.matterPlaceholder')"
          />
        </template>

        <template v-else-if="isSharedPlan">
          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.planActivity') }}</p>
          <UInput
            v-model="activitySummary"
            class="mt-1 w-full"
            size="xs"
            :maxlength="40"
            :placeholder="t('views.intimacy.candidates.planActivityPlaceholder')"
          />

          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.planSteps') }}</p>
          <ul class="mt-1 space-y-1.5">
            <li
              v-for="(step, index) in planSteps"
              :key="index"
              class="rounded-lg border border-gray-200 px-2.5 py-1.5 dark:border-gray-700"
            >
              <USelect
                :model-value="step.stage"
                :items="stageOptions"
                value-key="value"
                size="xs"
                class="w-32"
                :disabled="index === 0"
                @update:model-value="setStepStage(index, $event as SharedPlanStage)"
              />
              <p v-for="messageId in step.messageIds" :key="messageId" class="mt-1 text-xs leading-relaxed">
                <span class="mr-1.5 text-[10px] text-gray-400">
                  {{ snippetById.get(messageId)?.senderName }}
                  <span class="tabular-nums">{{ formatTime(snippetById.get(messageId)?.timestamp ?? 0) }}</span>
                </span>
                <span class="text-gray-700 dark:text-gray-200">
                  {{ snippetById.get(messageId) ? messageText(snippetById.get(messageId)!) : '' }}
                </span>
              </p>
              <p
                v-if="step.stage === 'mutually_confirmed' && step.messageIds.length < 2"
                class="mt-1 text-[11px] text-amber-600 dark:text-amber-400"
              >
                {{ t('views.intimacy.candidates.planConfirmNeedsSecond') }}
              </p>
            </li>
          </ul>
          <p v-if="planStages.errorKey" class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {{ t(planStages.errorKey) }}
          </p>
          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.planStepHint') }}</p>
        </template>

        <template v-else>
          <UCheckbox
            v-if="kind === 'good_news_response'"
            :model-value="positiveForSharer"
            class="mt-2"
            :label="t('views.intimacy.k4.positiveToggle')"
            size="xs"
            @update:model-value="positiveForSharer = $event === true"
          />

          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.responseLabels') }}</p>
          <div class="mt-1 flex flex-wrap items-center gap-3">
            <UCheckbox
              v-for="label in kind === 'support_response' ? SUPPORT_RESPONSE_LABELS : []"
              :key="label"
              :model-value="supportLabels.includes(label)"
              :label="t(SUPPORT_RESPONSE_LABEL_KEYS[label])"
              size="xs"
              @update:model-value="toggleSupportLabel(label, $event === true)"
            />
            <UCheckbox
              v-for="label in kind === 'good_news_response' ? GOOD_NEWS_RESPONSE_LABELS : []"
              :key="label"
              :model-value="goodNewsLabels.includes(label)"
              :label="t(GOOD_NEWS_RESPONSE_LABEL_KEYS[label])"
              size="xs"
              @update:model-value="toggleGoodNewsLabel(label, $event === true)"
            />
          </div>
          <p class="mt-2 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.responseNoneHint') }}</p>
        </template>

        <UButton class="mt-3" size="xs" color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
          {{ t(submitKey) }}
        </UButton>
      </div>
    </template>
  </div>
</template>
