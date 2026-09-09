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
  type IntimacyCandidates,
  type IntimacyMessageSnippet,
  type SharingCategory,
  type SharingTopic,
} from '@/services'
import type { TimeFilter } from '@openchatlab/shared-types'
import {
  SHARING_CATEGORIES,
  SHARING_CATEGORY_LABEL_KEYS,
  SHARING_TOPICS,
  SHARING_TOPIC_LABEL_KEYS,
} from './intimacy-summary'

const props = defineProps<{
  sessionId: string
  semanticAvailable: boolean
  timeFilter?: TimeFilter
}>()

const emit = defineEmits<{ (event: 'created'): void }>()

const { t } = useI18n()
const toast = useToast()

const query = ref('')
const candidates = ref<IntimacyCandidates | null>(null)
const searching = ref(false)
const submitting = ref(false)

/** 选中的消息必须来自同一个人、同一条检索结果，换人或换结果就重新开始选。 */
const selection = ref<{ group: string; senderId: number; messageIds: number[] } | null>(null)
const categories = ref<SharingCategory[]>([])
const topic = ref<SharingTopic>('daily_life')

const topicOptions = computed(() =>
  SHARING_TOPICS.map((value) => ({ value, label: t(SHARING_TOPIC_LABEL_KEYS[value]) }))
)
const canSubmit = computed(
  () => selection.value !== null && selection.value.messageIds.length > 0 && categories.value.length > 0
)

async function search() {
  const text = query.value.trim()
  if (text === '') return
  searching.value = true
  try {
    candidates.value = await useIntimacyService().searchCandidates(props.sessionId, {
      kind: 'sharing',
      query: text,
      startTs: props.timeFilter?.startTs,
      endTs: props.timeFilter?.endTs,
    })
    selection.value = null
  } catch (error) {
    toast.fail(t('views.intimacy.candidates.searchFailed'), { description: errorMessage(error) })
  } finally {
    searching.value = false
  }
}

function isSelected(group: string, messageId: number): boolean {
  return selection.value?.group === group && selection.value.messageIds.includes(messageId)
}

function toggleMessage(group: string, message: IntimacyMessageSnippet) {
  const current = selection.value
  if (!current || current.group !== group || current.senderId !== message.senderId) {
    selection.value = { group, senderId: message.senderId, messageIds: [message.messageId] }
    return
  }
  const messageIds = current.messageIds.includes(message.messageId)
    ? current.messageIds.filter((id) => id !== message.messageId)
    : [...current.messageIds, message.messageId].sort((left, right) => left - right)
  selection.value = messageIds.length === 0 ? null : { ...current, messageIds }
}

function toggleCategory(category: SharingCategory, checked: boolean) {
  const next = new Set(categories.value)
  if (checked) next.add(category)
  else next.delete(category)
  categories.value = SHARING_CATEGORIES.filter((item) => next.has(item))
}

async function submit() {
  const current = selection.value
  if (!current || !canSubmit.value) return
  submitting.value = true
  try {
    await useIntimacyService().createUserEvent(props.sessionId, {
      kind: 'sharing',
      subjectMemberId: current.senderId,
      coreMessageIds: [...current.messageIds],
      // 用户没有被问「这是不是倾诉」，所以如实记为未定，不替他做判断。
      details: { categories: [...categories.value], topic: topic.value, isDistressDisclosure: 'uncertain' },
    })
    selection.value = null
    categories.value = []
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
      <p class="mt-3 text-[11px] text-gray-400">{{ t('views.intimacy.candidates.selectHint') }}</p>
      <p class="text-[11px] text-gray-400">{{ t('views.intimacy.candidates.sameGroupOnly') }}</p>

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
                :class="
                  isSelected('keyword', message.messageId)
                    ? 'border-pink-400 bg-pink-50/60 dark:border-pink-700 dark:bg-pink-950/20'
                    : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50'
                "
                @click="toggleMessage('keyword', message)"
              >
                <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                  <span class="truncate">{{ message.senderName }}</span>
                  <span class="tabular-nums">{{ formatTime(message.timestamp) }}</span>
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
                    :class="
                      isSelected(`semantic:${index}`, message.messageId)
                        ? 'bg-pink-50 dark:bg-pink-950/20'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                    "
                    @click="toggleMessage(`semantic:${index}`, message)"
                  >
                    <span class="flex items-center gap-1.5 text-[10px] text-gray-400">
                      <span class="truncate">{{ message.senderName }}</span>
                      <span class="tabular-nums">{{ formatTime(message.timestamp) }}</span>
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
          </span>
          <UButton size="xs" color="neutral" variant="ghost" @click="selection = null">
            {{ t('views.intimacy.candidates.clearSelection') }}
          </UButton>
        </div>

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

        <UButton class="mt-3" size="xs" color="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
          {{ t('views.intimacy.candidates.submit') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
