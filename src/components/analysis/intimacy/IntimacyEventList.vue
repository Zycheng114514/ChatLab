<script setup lang="ts">
// 亲密关系事件列表：每行是一个事件的证据、标签和修订入口。
import { computed, ref } from 'vue'
import dayjs from 'dayjs'
import { useI18n } from 'vue-i18n'
import { getMessageTypeName } from '@/types/base'
import type { IntimacyEvent, IntimacyMember, IntimacyMessageSnippet, SharingCategory, SharingTopic } from '@/services'
import {
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPICS,
  SHARING_TOPIC_LABEL_KEYS,
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
      details?: { categories: SharingCategory[]; topic: SharingTopic }
    }
  ): void
}>()

const { t } = useI18n()

const expandedReasonId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const editCategories = ref<SharingCategory[]>([])
const editTopic = ref<SharingTopic>('other')

const topicOptions = computed(() =>
  SHARING_TOPICS.map((topic) => ({ value: topic, label: t(SHARING_TOPIC_LABEL_KEYS[topic]) }))
)

function memberName(memberId: number): string {
  return props.members.find((member) => member.memberId === memberId)?.name ?? String(memberId)
}

function formatTime(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
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
  editingId.value = event.id
  editCategories.value = [...event.details.categories]
  editTopic.value = event.details.topic
}

function toggleCategory(category: SharingCategory, checked: boolean) {
  const next = new Set(editCategories.value)
  if (checked) next.add(category)
  else next.delete(category)
  editCategories.value = SHARING_CATEGORIES.filter((item) => next.has(item))
}

function submitEdit(event: IntimacyEvent) {
  if (editCategories.value.length === 0) return
  emit('review', {
    event,
    // 改标签不改变纳入 / 排除的决定；没有决定过的事件按「确认」处理。
    decision: event.review?.decision ?? 'included',
    details: { categories: [...editCategories.value], topic: editTopic.value },
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
          {{ memberName(event.subjectMemberId) }}
        </span>
        <span class="text-xs tabular-nums text-gray-400">{{ formatTime(event.anchorTs) }}</span>
        <span
          v-for="category in event.details.categories"
          :key="category"
          class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ t(SHARING_CATEGORY_LABEL_KEYS[category]) }}
        </span>
        <span class="text-[10px] text-gray-400">{{ t(SHARING_TOPIC_LABEL_KEYS[event.details.topic]) }}</span>
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

      <div class="mt-2 space-y-1">
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

      <div v-if="editingId === event.id" class="mt-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
        <div class="flex flex-wrap items-center gap-3">
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
        <p v-if="editCategories.length === 0" class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          {{ t('views.intimacy.event.categoriesRequired') }}
        </p>
        <div class="mt-2 flex gap-1.5">
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            :disabled="busy || editCategories.length === 0"
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
          v-if="event.status === 'auto' || event.status === 'uncertain'"
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
          v-if="event.status !== 'excluded' && editingId !== event.id"
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="startEditing(event)"
        >
          {{ t('views.intimacy.event.editLabels') }}
        </UButton>
      </div>
    </li>
  </ul>
</template>
