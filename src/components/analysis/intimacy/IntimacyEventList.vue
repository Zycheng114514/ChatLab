<script setup lang="ts">
// 亲密关系事件列表：每行是一个事件的证据、标签和修订入口。
// 四种 kind 共用这一行：个人分享只有本人的原话；倾诉后的回应与好消息回应左边是本人原话、右边是另一方的回复；
// 事后追问上面是被问者更早的原话、下面是追问者的原话。
import { computed, ref } from 'vue'
import dayjs from 'dayjs'
import { useI18n } from 'vue-i18n'
import { getMessageTypeName } from '@/types/base'
import type {
  FollowUpDetails,
  GoodNewsResponseDetails,
  GoodNewsResponseLabel,
  IntimacyEvent,
  IntimacyMember,
  IntimacyMessageSnippet,
  IntimacyReviewDetails,
  SharingCategory,
  SharingDetails,
  SharingTopic,
  SupportResponseDetails,
  SupportResponseLabel,
} from '@/services'
import {
  FOLLOW_UP_INITIATION_LABEL_KEYS,
  GOOD_NEWS_RESPONSE_LABELS,
  GOOD_NEWS_RESPONSE_LABEL_KEYS,
  POSITIVE_FOR_SHARER_LABEL_KEYS,
  RESPONSE_OBSERVATION_LABEL_KEYS,
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPICS,
  SHARING_TOPIC_LABEL_KEYS,
  SUPPORT_RESPONSE_LABELS,
  SUPPORT_RESPONSE_LABEL_KEYS,
  formatIntimacyGap,
  resolveIntimacyStatusBadge,
} from './intimacy-summary'

const props = defineProps<{
  events: IntimacyEvent[]
  messages: Record<number, IntimacyMessageSnippet>
  members: IntimacyMember[]
  busy: boolean
}>()

const emit = defineEmits<{
  (event: 'view', messageId: number): void
  (
    event: 'review',
    payload: {
      event: IntimacyEvent
      decision: 'included' | 'excluded'
      details?: IntimacyReviewDetails
    }
  ): void
}>()

const { t } = useI18n()

const expandedReasonId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const editCategories = ref<SharingCategory[]>([])
const editTopic = ref<SharingTopic>('other')
const editSupportLabels = ref<SupportResponseLabel[]>([])
const editGoodNewsLabels = ref<GoodNewsResponseLabel[]>([])
const editPositiveForSharer = ref(false)
const editPriorIds = ref<number[]>([])

const topicOptions = computed(() =>
  SHARING_TOPICS.map((topic) => ({ value: topic, label: t(SHARING_TOPIC_LABEL_KEYS[topic]) }))
)

/** 一次结果里混着四种 kind，类别与话题只属于个人分享事件。 */
function sharingDetails(event: IntimacyEvent): SharingDetails | null {
  return event.details.kind === 'sharing' ? event.details : null
}

function supportDetails(event: IntimacyEvent): SupportResponseDetails | null {
  return event.details.kind === 'support_response' ? event.details : null
}

function goodNewsDetails(event: IntimacyEvent): GoodNewsResponseDetails | null {
  return event.details.kind === 'good_news_response' ? event.details : null
}

function responseDetails(event: IntimacyEvent): SupportResponseDetails | GoodNewsResponseDetails | null {
  return supportDetails(event) ?? goodNewsDetails(event)
}

function followUpDetails(event: IntimacyEvent): FollowUpDetails | null {
  return event.details.kind === 'follow_up' ? event.details : null
}

/** 标签只描述看得见的回复，所以没有可见回复的事件这里就是空的。 */
function responseLabelKeys(event: IntimacyEvent): string[] {
  const support = supportDetails(event)
  if (support) return support.responseLabels.map((label) => SUPPORT_RESPONSE_LABEL_KEYS[label])
  const goodNews = goodNewsDetails(event)
  return goodNews ? goodNews.responseLabels.map((label) => GOOD_NEWS_RESPONSE_LABEL_KEYS[label]) : []
}

function coreColumnKey(event: IntimacyEvent): string {
  return supportDetails(event) ? 'views.intimacy.k2.coreColumn' : 'views.intimacy.k4.coreColumn'
}

function observationLabelKey(event: IntimacyEvent): string {
  const details = responseDetails(event)
  return details
    ? RESPONSE_OBSERVATION_LABEL_KEYS[details.responseObservation]
    : RESPONSE_OBSERVATION_LABEL_KEYS.no_visible_response
}

function coreEvidence(event: IntimacyEvent) {
  return event.evidence.filter((evidence) => evidence.role !== 'response' && evidence.role !== 'prior')
}

function responseEvidence(event: IntimacyEvent) {
  return event.evidence.filter((evidence) => evidence.role === 'response')
}

/** K3 的「先前」证据：被问者更早提到那件事的消息；没找到配对时是空的。 */
function priorEvidence(event: IntimacyEvent) {
  return event.evidence.filter((evidence) => evidence.role === 'prior')
}

function gapText(event: IntimacyEvent) {
  const details = followUpDetails(event)
  return details ? formatIntimacyGap(details.gapSeconds) : null
}

/** 阶段 B 给模型看过的候选先前消息，用户可以从中指定；原文随结果一起返回。 */
function priorCandidates(event: IntimacyEvent): IntimacyMessageSnippet[] {
  const details = followUpDetails(event)
  if (!details) return []
  return details.candidateMessageIds.flatMap((messageId) => {
    const snippet = props.messages[messageId]
    return snippet ? [snippet] : []
  })
}

/** 没有可见回复的倾诉事件没有可改的标签；好消息事件还能改「对本人是否好消息」。 */
function canEditLabels(event: IntimacyEvent): boolean {
  const support = supportDetails(event)
  if (support) return support.responseObservation === 'visible_response'
  // 指定先前事件要有候选可选；没有候选的追问在行里写明本次回查没找到，只能用候选检索自己指定。
  if (followUpDetails(event)) return priorCandidates(event).length > 0
  return true
}

function editButtonKey(event: IntimacyEvent): string {
  if (sharingDetails(event)) return 'views.intimacy.event.editLabels'
  if (followUpDetails(event)) return 'views.intimacy.k3.pickPrior'
  return 'views.intimacy.event.editResponse'
}

function requiredHintKey(event: IntimacyEvent): string {
  if (sharingDetails(event)) return 'views.intimacy.event.categoriesRequired'
  if (followUpDetails(event)) return 'views.intimacy.k3.priorRequired'
  return 'views.intimacy.event.labelsRequired'
}

/** 没有先前消息的追问不是一个配对，所以这一行只提供「指定先前事件」，不提供直接确认。 */
function canConfirm(event: IntimacyEvent): boolean {
  return !followUpDetails(event) || priorEvidence(event).length > 0
}

function memberName(memberId: number): string {
  return props.members.find((member) => member.memberId === memberId)?.name ?? String(memberId)
}

function formatTime(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
}

function formatDay(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD')
}

function quoteText(messageId: number): string | null {
  const snippet = props.messages[messageId]
  if (!snippet) return null
  return snippet.content || `[${getMessageTypeName(snippet.type, t)}]`
}

function observationKey(event: IntimacyEvent): string | null {
  if (event.observation === 'boundary_limited') return 'views.intimacy.event.observationBoundaryLimited'
  if (event.observation === 'media_missing') return 'views.intimacy.event.observationMediaMissing'
  return null
}

function toggleReason(eventId: string) {
  expandedReasonId.value = expandedReasonId.value === eventId ? null : eventId
}

function startEditing(event: IntimacyEvent) {
  const sharing = sharingDetails(event)
  const support = supportDetails(event)
  const goodNews = goodNewsDetails(event)
  editingId.value = event.id
  editCategories.value = sharing ? [...sharing.categories] : []
  editTopic.value = sharing?.topic ?? 'other'
  editSupportLabels.value = support ? [...support.responseLabels] : []
  editGoodNewsLabels.value = goodNews ? [...goodNews.responseLabels] : []
  editPositiveForSharer.value = goodNews?.positiveForSharer === 'explicit_or_context_supported'
  editPriorIds.value = priorEvidence(event).map((evidence) => evidence.messageId)
}

function togglePrior(messageId: number) {
  const next = new Set(editPriorIds.value)
  if (next.has(messageId)) next.delete(messageId)
  else next.add(messageId)
  editPriorIds.value = [...next].sort((left, right) => left - right)
}

function toggleCategory(category: SharingCategory, checked: boolean) {
  const next = new Set(editCategories.value)
  if (checked) next.add(category)
  else next.delete(category)
  editCategories.value = SHARING_CATEGORIES.filter((item) => next.has(item))
}

function toggleSupportLabel(label: SupportResponseLabel, checked: boolean) {
  const next = new Set(editSupportLabels.value)
  if (checked) next.add(label)
  else next.delete(label)
  editSupportLabels.value = SUPPORT_RESPONSE_LABELS.filter((item) => next.has(item))
}

function toggleGoodNewsLabel(label: GoodNewsResponseLabel, checked: boolean) {
  const next = new Set(editGoodNewsLabels.value)
  if (checked) next.add(label)
  else next.delete(label)
  editGoodNewsLabels.value = GOOD_NEWS_RESPONSE_LABELS.filter((item) => next.has(item))
}

/** 有可见回复的事件至少要留一个回复标签；没有可见回复的好消息事件只改「对本人是否好消息」。 */
function canSubmitEdit(event: IntimacyEvent): boolean {
  if (sharingDetails(event)) return editCategories.value.length > 0
  if (followUpDetails(event)) return editPriorIds.value.length > 0
  if (supportDetails(event)) return editSupportLabels.value.length > 0
  const goodNews = goodNewsDetails(event)
  return goodNews?.responseObservation !== 'visible_response' || editGoodNewsLabels.value.length > 0
}

function submitEdit(event: IntimacyEvent) {
  if (!canSubmitEdit(event)) return
  const goodNews = goodNewsDetails(event)
  let details: IntimacyReviewDetails
  if (followUpDetails(event)) {
    // 服务端会按选中的消息重新算配对（先前事件、间隔、时机），前端只提交选择本身。
    details = { priorMessageIds: [...editPriorIds.value] }
  } else if (goodNews) {
    details = {
      positiveForSharer: editPositiveForSharer.value ? 'explicit_or_context_supported' : 'uncertain',
      // 后端拒绝给看不见的回复贴标签，所以这时只提交「对本人是否好消息」。
      responseLabels: goodNews.responseObservation === 'visible_response' ? [...editGoodNewsLabels.value] : [],
    }
  } else if (supportDetails(event)) {
    details = { responseLabels: [...editSupportLabels.value] }
  } else {
    details = { categories: [...editCategories.value], topic: editTopic.value }
  }
  emit('review', {
    event,
    // 改标签不改变纳入 / 排除的决定；没有决定过的事件按「确认」处理。
    decision: event.review?.decision ?? 'included',
    details,
  })
  editingId.value = null
}
</script>

<template>
  <ul class="divide-y divide-gray-100 dark:divide-gray-800">
    <li v-for="event in events" :key="event.id" class="px-5 py-3">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
          :class="resolveIntimacyStatusBadge(event.status).className"
        >
          {{ t(resolveIntimacyStatusBadge(event.status).labelKey) }}
        </span>
        <span class="text-sm font-medium text-gray-800 dark:text-gray-100">
          {{ followUpDetails(event)?.matter ?? memberName(event.subjectMemberId) }}
        </span>
        <span class="text-xs tabular-nums text-gray-400">{{ formatTime(event.anchorTs) }}</span>
        <span
          v-for="category in sharingDetails(event)?.categories ?? []"
          :key="category"
          class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ t(SHARING_CATEGORY_LABEL_KEYS[category]) }}
        </span>
        <span v-if="sharingDetails(event)" class="text-[10px] text-gray-400">
          {{ t(SHARING_TOPIC_LABEL_KEYS[sharingDetails(event)!.topic]) }}
        </span>
        <span
          v-if="goodNewsDetails(event)"
          class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ t(POSITIVE_FOR_SHARER_LABEL_KEYS[goodNewsDetails(event)!.positiveForSharer]) }}
        </span>
        <span
          v-for="labelKey in responseLabelKeys(event)"
          :key="labelKey"
          class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ t(labelKey) }}
        </span>
      </div>

      <p v-if="observationKey(event)" class="mt-1.5 text-[11px] text-gray-400">
        {{ t(observationKey(event)!) }}
      </p>

      <div v-if="event.modelReason" class="mt-1.5">
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="toggleReason(event.id)"
        >
          <UIcon
            :name="expandedReasonId === event.id ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right'"
            class="h-3 w-3"
          />
          {{ t('views.intimacy.event.reason') }}
        </button>
        <p v-if="expandedReasonId === event.id" class="mt-1 text-[11px] leading-relaxed text-gray-500">
          {{ event.modelReason }}
        </p>
      </div>

      <!-- 个人分享：只有本人的原话 -->
      <div v-if="!responseDetails(event) && !followUpDetails(event)" class="mt-2 space-y-1">
        <p
          v-for="evidence in event.evidence"
          :key="evidence.messageId"
          class="text-xs leading-relaxed"
          :class="
            quoteText(evidence.messageId) === null
              ? 'text-gray-400 italic'
              : evidence.role === 'core'
                ? 'font-semibold text-gray-800 dark:text-gray-100'
                : 'text-gray-500 dark:text-gray-400'
          "
        >
          <span class="mr-1.5 text-[10px] tabular-nums text-gray-400">{{ formatTime(evidence.timestamp) }}</span>
          {{ quoteText(evidence.messageId) ?? t('views.intimacy.event.missingMessage') }}
        </p>
      </div>

      <!-- 事后追问：上面是被问者更早提到那件事的原话，下面是追问者的追问 -->
      <div v-else-if="followUpDetails(event)" class="mt-2 space-y-1.5">
        <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
          <p class="text-[10px] text-gray-400">
            {{ t('views.intimacy.k3.priorColumn') }} · {{ memberName(event.subjectMemberId) }}
          </p>
          <p
            v-for="evidence in priorEvidence(event)"
            :key="evidence.messageId"
            class="mt-1 text-xs leading-relaxed"
            :class="
              quoteText(evidence.messageId) === null ? 'text-gray-400 italic' : 'text-gray-700 dark:text-gray-200'
            "
          >
            <span class="mr-1.5 text-[10px] tabular-nums text-gray-400">{{ formatTime(evidence.timestamp) }}</span>
            {{ quoteText(evidence.messageId) ?? t('views.intimacy.event.missingMessage') }}
          </p>
          <p v-if="priorEvidence(event).length === 0" class="mt-1 text-xs text-gray-400">
            {{ t('views.intimacy.k3.priorNotFound') }}
          </p>
        </div>

        <p
          v-if="priorEvidence(event).length > 0"
          class="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500 dark:text-gray-400"
        >
          <span v-if="gapText(event)">{{ t(gapText(event)!.labelKey, { count: gapText(event)!.count }) }}</span>
          <span>{{ t(FOLLOW_UP_INITIATION_LABEL_KEYS[followUpDetails(event)!.initiationInObservedRecord]) }}</span>
        </p>
        <p v-if="followUpDetails(event)!.lookbackStartTs > 0" class="text-[11px] text-gray-400">
          {{ t('views.intimacy.k3.lookback', { date: formatDay(followUpDetails(event)!.lookbackStartTs) }) }}
          <span v-if="priorEvidence(event).length === 0 && priorCandidates(event).length === 0">
            {{ t('views.intimacy.k3.noCandidates') }}
          </span>
        </p>

        <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
          <p class="text-[10px] text-gray-400">
            {{ t('views.intimacy.k3.questionColumn') }} · {{ memberName(event.otherMemberId) }}
          </p>
          <p
            v-for="evidence in coreEvidence(event)"
            :key="evidence.messageId"
            class="mt-1 text-xs leading-relaxed"
            :class="
              quoteText(evidence.messageId) === null
                ? 'text-gray-400 italic'
                : 'font-semibold text-gray-800 dark:text-gray-100'
            "
          >
            <span class="mr-1.5 text-[10px] tabular-nums text-gray-400">{{ formatTime(evidence.timestamp) }}</span>
            {{ quoteText(evidence.messageId) ?? t('views.intimacy.event.missingMessage') }}
          </p>
        </div>
      </div>

      <!-- 回应类事件：左边是本人的倾诉 / 好消息，右边是另一方的回复 -->
      <div v-else class="mt-2 grid gap-3 sm:grid-cols-2">
        <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
          <p class="text-[10px] text-gray-400">
            {{ t(coreColumnKey(event)) }} · {{ memberName(event.subjectMemberId) }}
          </p>
          <p
            v-for="evidence in coreEvidence(event)"
            :key="evidence.messageId"
            class="mt-1 text-xs leading-relaxed"
            :class="
              quoteText(evidence.messageId) === null
                ? 'text-gray-400 italic'
                : 'font-semibold text-gray-800 dark:text-gray-100'
            "
          >
            <span class="mr-1.5 text-[10px] tabular-nums text-gray-400">{{ formatTime(evidence.timestamp) }}</span>
            {{ quoteText(evidence.messageId) ?? t('views.intimacy.event.missingMessage') }}
          </p>
        </div>
        <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
          <p class="text-[10px] text-gray-400">
            {{ t('views.intimacy.response.replyColumn') }} · {{ memberName(event.otherMemberId) }}
          </p>
          <p
            v-for="evidence in responseEvidence(event)"
            :key="evidence.messageId"
            class="mt-1 text-xs leading-relaxed"
            :class="
              quoteText(evidence.messageId) === null ? 'text-gray-400 italic' : 'text-gray-700 dark:text-gray-200'
            "
          >
            <span class="mr-1.5 text-[10px] tabular-nums text-gray-400">{{ formatTime(evidence.timestamp) }}</span>
            {{ quoteText(evidence.messageId) ?? t('views.intimacy.event.missingMessage') }}
          </p>
          <p v-if="responseEvidence(event).length === 0" class="mt-1 text-xs text-gray-400">
            {{ t(observationLabelKey(event)) }}
          </p>
        </div>
      </div>

      <div v-if="editingId === event.id" class="mt-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
        <div v-if="followUpDetails(event)">
          <p class="text-[11px] text-gray-400">{{ t('views.intimacy.k3.pickPriorHint') }}</p>
          <ul class="mt-1.5 space-y-1">
            <li v-for="candidate in priorCandidates(event)" :key="candidate.messageId">
              <button
                type="button"
                class="w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors"
                :class="
                  editPriorIds.includes(candidate.messageId)
                    ? 'border-pink-400 bg-pink-50/60 dark:border-pink-700 dark:bg-pink-950/20'
                    : 'border-gray-200 hover:bg-white dark:border-gray-700 dark:hover:bg-gray-800'
                "
                @click="togglePrior(candidate.messageId)"
              >
                <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                  <span class="truncate">{{ candidate.senderName }}</span>
                  <span class="tabular-nums">{{ formatTime(candidate.timestamp) }}</span>
                </span>
                <span class="mt-0.5 block text-xs leading-relaxed text-gray-700 dark:text-gray-200">
                  {{ quoteText(candidate.messageId) }}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div v-if="sharingDetails(event)" class="flex flex-wrap items-center gap-3">
          <UCheckbox
            v-for="category in SHARING_CATEGORIES"
            :key="category"
            :model-value="editCategories.includes(category)"
            :label="t(SHARING_CATEGORY_LABEL_KEYS[category])"
            size="xs"
            @update:model-value="toggleCategory(category, $event === true)"
          />
          <USelect v-model="editTopic" :items="topicOptions" value-key="value" size="xs" class="w-32" />
        </div>

        <UCheckbox
          v-if="goodNewsDetails(event)"
          :model-value="editPositiveForSharer"
          :label="t('views.intimacy.k4.positiveToggle')"
          size="xs"
          @update:model-value="editPositiveForSharer = $event === true"
        />

        <div
          v-if="responseDetails(event)?.responseObservation === 'visible_response'"
          class="mt-2 flex flex-wrap items-center gap-3"
        >
          <UCheckbox
            v-for="label in supportDetails(event) ? SUPPORT_RESPONSE_LABELS : []"
            :key="label"
            :model-value="editSupportLabels.includes(label)"
            :label="t(SUPPORT_RESPONSE_LABEL_KEYS[label])"
            size="xs"
            @update:model-value="toggleSupportLabel(label, $event === true)"
          />
          <UCheckbox
            v-for="label in goodNewsDetails(event) ? GOOD_NEWS_RESPONSE_LABELS : []"
            :key="label"
            :model-value="editGoodNewsLabels.includes(label)"
            :label="t(GOOD_NEWS_RESPONSE_LABEL_KEYS[label])"
            size="xs"
            @update:model-value="toggleGoodNewsLabel(label, $event === true)"
          />
        </div>

        <p v-if="!canSubmitEdit(event)" class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          {{ t(requiredHintKey(event)) }}
        </p>
        <div class="mt-2 flex gap-1.5">
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            :disabled="busy || !canSubmitEdit(event)"
            @click="submitEdit(event)"
          >
            {{ t('common.save') }}
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" @click="editingId = null">
            {{ t('common.cancel') }}
          </UButton>
        </div>
      </div>

      <div class="mt-2 flex flex-wrap gap-1.5">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-heroicons-chat-bubble-left-right"
          @click="emit('view', event.anchorMessageId)"
        >
          {{ t('common.viewChatRecords') }}
        </UButton>
        <UButton
          v-if="(event.status === 'auto' || event.status === 'uncertain') && canConfirm(event)"
          size="xs"
          color="primary"
          variant="ghost"
          :disabled="busy"
          @click="emit('review', { event, decision: 'included' })"
        >
          {{ t('views.intimacy.event.confirm') }}
        </UButton>
        <UButton
          v-if="event.status !== 'excluded'"
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="emit('review', { event, decision: 'excluded' })"
        >
          {{ t('views.intimacy.event.exclude') }}
        </UButton>
        <UButton
          v-else
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="emit('review', { event, decision: 'included' })"
        >
          {{ t('views.intimacy.event.restore') }}
        </UButton>
        <UButton
          v-if="event.status !== 'excluded' && editingId !== event.id && canEditLabels(event)"
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="startEditing(event)"
        >
          {{ t(editButtonKey(event)) }}
        </UButton>
      </div>
    </li>
  </ul>
</template>
