/**
 * Resolve an attachment path recorded at import time against the directory the
 * export file came from (`meta.source_dir`).
 *
 * Pure string logic on purpose: core also runs in the browser, so it cannot
 * depend on `node:path`. Segment-wise resolution keeps a relative path inside
 * the source directory even when it contains `..` or mixed separators.
 */

const REMOTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

/** Attachment paths that point at a remote resource and are never read from disk. */
export function isRemoteAttachmentPath(value: string): boolean {
  return REMOTE_URL.test(value)
}

export function isAbsoluteAttachmentPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || WINDOWS_DRIVE.test(value)
}

/**
 * @returns the remote URL unchanged, an absolute path unchanged, the absolute
 *   path of a relative attachment inside `sourceDir`, or `null` when the path
 *   cannot be resolved or would escape `sourceDir`.
 */
export function resolveAttachmentPath(
  sourceDir: string | null | undefined,
  relativePath: string | null | undefined
): string | null {
  if (!relativePath) return null
  if (isRemoteAttachmentPath(relativePath)) return relativePath
  if (isAbsoluteAttachmentPath(relativePath)) return relativePath
  if (!sourceDir) return null

  const baseSegments = splitPathSegments(sourceDir)
  if (baseSegments.length === 0) return null

  const segments = [...baseSegments]
  for (const segment of splitPathSegments(relativePath)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length <= 1) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (segments.length < baseSegments.length) return null
  if (baseSegments.some((segment, index) => segments[index] !== segment)) return null

  const separator = sourceDir.includes('\\') && !sourceDir.includes('/') ? '\\' : '/'
  const resolved = segments.join(separator)
  return resolved === '' ? separator : resolved
}

/**
 * Split on both separators, keeping a leading empty segment as the POSIX root
 * marker and dropping trailing empties left by a trailing separator.
 */
function splitPathSegments(value: string): string[] {
  const segments = value.split(/[\\/]+/)
  while (segments.length > 1 && segments[segments.length - 1] === '') {
    segments.pop()
  }
  return segments
}
