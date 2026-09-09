import { fetchWithAuth } from '../utils/http'
import {
  IntimacyRequestError,
  type IntimacyAdapter,
  type IntimacyCandidates,
  type IntimacyPreflight,
  type IntimacyResultRange,
  type IntimacyResults,
  type IntimacyRun,
} from './types'

export class FetchIntimacyAdapter implements IntimacyAdapter {
  preflight(sessionId: string, request: Parameters<IntimacyAdapter['preflight']>[1]) {
    return requestJson<IntimacyPreflight>(`${base(sessionId)}/preflight`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  start(sessionId: string, request: Parameters<IntimacyAdapter['start']>[1]) {
    return requestJson<IntimacyRun>(`${base(sessionId)}/runs`, { method: 'POST', body: JSON.stringify(request) })
  }

  getLatestRun(sessionId: string) {
    return requestJson<IntimacyRun | null>(`${base(sessionId)}/runs/latest`)
  }

  getRun(sessionId: string, runId: string) {
    return requestJson<IntimacyRun>(`${base(sessionId)}/runs/${encodeURIComponent(runId)}`)
  }

  pause(sessionId: string, runId: string) {
    return this.runAction(sessionId, runId, 'pause')
  }

  resume(sessionId: string, runId: string) {
    return this.runAction(sessionId, runId, 'resume')
  }

  cancel(sessionId: string, runId: string) {
    return this.runAction(sessionId, runId, 'cancel')
  }

  getResults(sessionId: string, range?: IntimacyResultRange) {
    const query = new URLSearchParams()
    if (range?.startTs !== undefined) query.set('startTs', String(range.startTs))
    if (range?.endTs !== undefined) query.set('endTs', String(range.endTs))
    const search = query.toString()
    return requestJson<IntimacyResults>(`${base(sessionId)}/results${search === '' ? '' : `?${search}`}`)
  }

  searchCandidates(sessionId: string, request: Parameters<IntimacyAdapter['searchCandidates']>[1]) {
    return requestJson<IntimacyCandidates>(`${base(sessionId)}/candidates`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  createUserEvent(sessionId: string, request: Parameters<IntimacyAdapter['createUserEvent']>[1]) {
    return requestJson<IntimacyResults>(`${base(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  reviewEvent(sessionId: string, eventId: string, request: Parameters<IntimacyAdapter['reviewEvent']>[2]) {
    return requestJson<IntimacyResults>(`${base(sessionId)}/events/${encodeURIComponent(eventId)}/review`, {
      method: 'PUT',
      body: JSON.stringify(request),
    })
  }

  async clearResults(sessionId: string, options: { includeReviews: boolean }): Promise<boolean> {
    const result = await requestJson<{ success: boolean }>(
      `${base(sessionId)}/results${options.includeReviews ? '?reviews=1' : ''}`,
      { method: 'DELETE' }
    )
    return result.success
  }

  private runAction(sessionId: string, runId: string, action: 'pause' | 'resume' | 'cancel') {
    return requestJson<IntimacyRun>(`${base(sessionId)}/runs/${encodeURIComponent(runId)}/${action}`, {
      method: 'POST',
    })
  }
}

function base(sessionId: string): string {
  return `/_web/sessions/${encodeURIComponent(sessionId)}/intimacy`
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetchWithAuth(url, { ...init, headers })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string } | string
      message?: string
    } | null
    const detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message
    throw new IntimacyRequestError(detail || payload?.message || `HTTP ${response.status}`, response.status)
  }
  return response.json() as Promise<T>
}
