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
  type CreateIntimacyEventRequest,
  type GoodNewsResponseLabel,
  type IntimacyCandidates,
  type IntimacyKind,
  type IntimacyMessageSnippet,
  type SharingCategory,
  type SharingTopic,
  type SupportResponseLabel,
} from '@/services'
import type { TimeFilter } from '@openchatlab/shared-types'
import {
  GOOD_NEWS_RESPONSE_LABELS,
  GOOD_NEWS_RESPONSE_LABEL_KEYS,
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPICS,
  SHARING_TOPIC_LABEL_KEYS,
  SUPPORT_RESPONSE_LABELS,
  SUPPORT_RESPONSE_LABEL_KEYS,
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
  {
    kind: 'good_news_response',
    labelKey: 'views.intimacy.k4.title',
    submitKey: 'views.intimacy.candidates.submitGoodNews',
  },
]

const kind = ref<IntimacyKind>('sharing')
const query = ref('')
const candidates = ref<IntimacyCandidates | null>(null)
const searching = ref(false)
const submitting = ref(false)

/** 选中的核心消息必须来自同一个人、同一条检索结果；回复是另一方在同一条结果里、锚点之后的消息。 */
const selection = ref<{ group: string; senderId: number; messageIds: number[]; responseMessageIds: number[] } | null>(
  null
)
const categories = ref<SharingCategory[]>([])
const topic = ref<SharingTopic>('daily_life')
const supportLabels = ref<SupportResponseLabel[]>([])
const goodNewsLabels = ref<GoodNewsResponseLabel[]>([])
const positiveForSharer = ref(false)

const isSharing = computed(() => kind.value === 'sharing')
const submitKey = computed(() => KIND_OPTIONS.find((option) => option.kind === kind.value)!.submitKey)
const responseLabelCount = computed(() =>
  kind.value === 'support_response' ? supportLabels.value.length : goodNewsLabels.value.length
)
const topicOptions = computed(() =>
  SHARING_TOPICS.map((value) => ({ value, label: t(SHARING_TOPIC_LABEL_KEYS[value]) }))
)
const canSubmit = computed(() => {
  const current = selection.value
  if (!current || current.messageIds.length === 0) return false
  if (isSharing.value) return categories.value.length > 0
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
    resetSelection()
  } catch (error) {
    toast.fail(t('views.intimacy.candidates.searchFailed'), { description: errorMessage(error) })
  } finally {
    searching.value = false
  }
}

function isCoreSelected(group: string, messageId: number): boolean {
  return selection.value?.group === group && selection.value.messageIds.includes(messageId)
}

function isResponseSelected(group: string, messageId: number): boolean {
  return selection.value?.group === group && selection.value.responseMessageIds.includes(messageId)
}

/** 回复必须在倾诉 / 好消息之后，早于锚点的消息不能勾成回复。 */
function canPick(group: string, message: IntimacyMessageSnippet): boolean {
  const current = selection.value
  if (isSharing.value || !current || current.group !== group || current.senderId === message.senderId) return true
  return message.messageId > Math.min(...current.messageIds)
}

function toggleMessage(group: string, message: IntimacyMessageSnippet) {
  const current = selection.value
  if (!current || current.group !== group) {
    selection.value = { group, senderId: message.senderId, messageIds: [message.messageId], responseMessageIds: [] }
    return
  }
  if (current.senderId === message.senderId) {
    const messageIds = toggleId(current.messageIds, message.messageId)
    selection.value = messageIds.length === 0 ? null : { ...current, messageIds }
    return
  }
  if (isSharing.value) {
    selection.value = { group, senderId: message.senderId, messageIds: [message.messageId], responseMessageIds: [] }
    return
  }
  if (!canPick(group, message)) return
  selection.value = { ...current, responseMessageIds: toggleId(current.responseMessageIds, message.messageId) }
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
      <p class="mt-3 text-[11px] text-gray-400">
        {{ isSharing ? t('views.intimacy.candidates.selectHint') : t('views.intimacy.candidates.responseSelectHint') }}
      </p>
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
            <li v-for="message in candidates.keyword" :key="message.messageId">
              <button
                type="button"
                class="w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors"
                :disabled="!canPick('keyword', message)"
                :class="[
                  isCoreSelected('keyword', message.messageId)
                    ? 'border-pink-400 bg-pink-50/60 dark:border-pink-700 dark:bg-pink-950/20'
                    : isResponseSelected('keyword', message.messageId)
                      ? 'border-blue-400 bg-blue-50/60 dark:border-blue-700 dark:bg-blue-950/20'
                      : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50',
                  canPick('keyword', message) ? '' : 'cursor-not-allowed opacity-50',
                ]"
                @click="toggleMessage('keyword', message)"
              >
                <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                  <span class="truncate">{{ message.senderName }}</span>
                  <span class="tabular-nums">{{ formatTime(message.timestamp) }}</span>
                  <span v-if="isResponseSelected('keyword', message.messageId)" class="text-blue-500">
                    {{ t('views.intimacy.response.replyColumn') }}
                  </span>
                </span>
                <span class="mt-0.5 block text-xs leading-relaxed text-gray-700 dark:text-gray-200">
                  {{ messageText(message) }}
                </span>
              </button>
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
                        : isResponseSelected(`semantic:${index}`, message.messageId)
                          ? 'bg-blue-50 dark:bg-blue-950/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50',
                      canPick(`semantic:${index}`, message) ? '' : 'cursor-not-allowed opacity-50',
                    ]"
                    @click="toggleMessage(`semantic:${index}`, message)"
                  >
                    <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                      <span class="truncate">{{ message.senderName }}</span>
                      <span class="tabular-nums">{{ formatTime(message.timestamp) }}</span>
                      <span v-if="isResponseSelected(`semantic:${index}`, message.messageId)" class="text-blue-500">
                        {{ t('views.intimacy.response.replyColumn') }}
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
            <template v-if="!isSharing">
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
