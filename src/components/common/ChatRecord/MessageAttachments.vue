<script setup lang="ts">
/**
 * 消息附件展示
 *
 * 桌面端与 CLI Web 能拿到附件 URL：图片内联显示、可播放音频给出播放器；
 * 芯片在桌面端「在文件夹中显示」，在 CLI Web 下载，其余平台只显示文件名。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isRemoteAttachmentPath, type MessageAttachment } from '@openchatlab/core'
import { usePlatformService } from '@/services'

const { t } = useI18n()

const props = defineProps<{
  sessionId: string
  attachments: MessageAttachment[]
}>()

const platform = usePlatformService()
/** 只有桌面端有文件管理器；其它平台的芯片走下载或纯展示。 */
const canReveal = typeof platform.revealAttachment === 'function'
/** 内联预览加载失败的附件：退回芯片，不再重复请求。 */
const failedPreviewIds = ref<number[]>([])
/** 定位失败（文件已被移动或删除）的附件。 */
const missingFileIds = ref<number[]>([])

/** audio 元素能直接播放的类型；其它音频（如微信 SILK）只给芯片。 */
const PLAYABLE_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']

interface AttachmentView {
  id: number
  name: string
  size: string | null
  icon: string
  url: string | null
  chipMode: 'reveal' | 'download' | 'link' | 'plain'
  showImage: boolean
  showAudio: boolean
  missing: boolean
}

const views = computed<AttachmentView[]>(() =>
  props.attachments.map((attachment) => {
    // 远程附件（如未下载媒体的 Discord 导出）不自动加载：自动请求会把用户 IP 暴露给该服务器。
    const remote = isRemoteAttachmentPath(attachment.path)
    const url = remote ? attachment.path : platform.getAttachmentUrl(props.sessionId, attachment.id)
    const previewable = !remote && url !== null && !failedPreviewIds.value.includes(attachment.id)
    return {
      id: attachment.id,
      name: attachment.name || lastPathSegment(attachment.path),
      size: attachment.size ? formatSize(attachment.size) : null,
      icon: iconForKind(attachment.kind),
      url,
      chipMode: remote ? 'link' : url === null ? 'plain' : canReveal ? 'reveal' : 'download',
      showImage: previewable && attachment.kind === 'image',
      showAudio: previewable && attachment.kind === 'audio' && isPlayableAudio(attachment.mimeType),
      missing: missingFileIds.value.includes(attachment.id),
    }
  })
)

function lastPathSegment(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

function isPlayableAudio(mimeType: string | null): boolean {
  return !!mimeType && PLAYABLE_AUDIO_TYPES.includes(mimeType)
}

function iconForKind(kind: string): string {
  switch (kind) {
    case 'image':
      return 'i-heroicons-photo'
    case 'video':
      return 'i-heroicons-film'
    case 'audio':
      return 'i-heroicons-musical-note'
    case 'sticker':
      return 'i-heroicons-face-smile'
    default:
      return 'i-heroicons-document'
  }
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const size = (bytes / Math.pow(1024, unitIndex)).toFixed(unitIndex > 0 ? 1 : 0)
  return `${size} ${units[unitIndex]}`
}

function markPreviewFailed(attachmentId: number): void {
  if (!failedPreviewIds.value.includes(attachmentId)) {
    failedPreviewIds.value = [...failedPreviewIds.value, attachmentId]
  }
}

async function reveal(attachmentId: number): Promise<void> {
  const revealed = await platform.revealAttachment?.(props.sessionId, attachmentId)
  if (revealed) return
  if (!missingFileIds.value.includes(attachmentId)) {
    missingFileIds.value = [...missingFileIds.value, attachmentId]
  }
}
</script>

<template>
  <div class="mt-2 space-y-2">
    <div v-for="view in views" :key="view.id" class="space-y-1">
      <img
        v-if="view.showImage && view.url"
        :src="view.url"
        :alt="view.name"
        class="max-h-64 max-w-full rounded-lg object-contain"
        loading="lazy"
        @error="markPreviewFailed(view.id)"
      />
      <audio
        v-else-if="view.showAudio && view.url"
        :src="view.url"
        controls
        preload="none"
        class="w-full max-w-xs"
        @error="markPreviewFailed(view.id)"
      />

      <a
        v-if="(view.chipMode === 'download' || view.chipMode === 'link') && view.url"
        :href="view.url"
        :download="view.chipMode === 'download' ? view.name : undefined"
        :target="view.chipMode === 'link' ? '_blank' : undefined"
        :rel="view.chipMode === 'link' ? 'noopener noreferrer' : undefined"
        class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-white/60 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:text-gray-100"
        :title="view.chipMode === 'link' ? view.url : t('records.attachments.download')"
        @click.stop
      >
        <UIcon :name="view.icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ view.name }}</span>
        <span v-if="view.size" class="shrink-0 text-gray-400 dark:text-gray-500">{{ view.size }}</span>
      </a>
      <button
        v-else-if="view.chipMode === 'reveal'"
        type="button"
        class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-white/60 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:text-gray-100"
        :title="view.missing ? t('records.attachments.missing') : t('records.attachments.reveal')"
        @click.stop="reveal(view.id)"
      >
        <UIcon :name="view.icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate" :class="view.missing ? 'line-through' : ''">{{ view.name }}</span>
        <span v-if="view.size" class="shrink-0 text-gray-400 dark:text-gray-500">{{ view.size }}</span>
      </button>
      <span
        v-else
        class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
        :title="t('records.attachments.unavailable')"
      >
        <UIcon :name="view.icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ view.name }}</span>
        <span v-if="view.size" class="shrink-0 text-gray-400 dark:text-gray-500">{{ view.size }}</span>
      </span>
    </div>
  </div>
</template>
