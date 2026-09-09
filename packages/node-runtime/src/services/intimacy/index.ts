export { INTIMACY_DB_FILENAME, getIntimacyDbPath } from './paths'
export { INTIMACY_USER_RUN_ID, IntimacyStore, assertSessionIntimacyIdle, deleteSessionIntimacy } from './store'
export type {
  IntimacyEventRecord,
  IntimacyExecutionLeaseGuard,
  StoredIntimacyEvent,
  StoredIntimacyReview,
} from './store'
export {
  INTIMACY_WINDOW_CONTEXT_MESSAGES,
  INTIMACY_WINDOW_MAX_CHARS,
  INTIMACY_WINDOW_MAX_MESSAGES,
  chunkIntimacyMessages,
  createIntimacySourceSignature,
  estimateIntimacyWindows,
  loadIntimacySource,
  readIntimacySourceFingerprint,
  resolveIntimacyMembers,
  resolveIntimacyRange,
} from './source'
export type { IntimacySource, IntimacySourceEstimate, IntimacySourceMessage, IntimacyWindow } from './source'
export {
  INTIMACY_ALGORITHM_VERSION,
  INTIMACY_PROMPT_VERSION,
  buildIntimacyWindowPrompt,
  parseIntimacyResponse,
  resolveIntimacyPreprocess,
} from './model-protocol'
export type {
  IntimacyPreprocessOptions,
  ParsedGoodNewsEvent,
  ParsedIntimacyEvent,
  ParsedResponseGroup,
  ParsedSharingEvent,
} from './model-protocol'
export {
  applyReviewDetails,
  buildIntimacyEvents,
  resolveEventStatus,
  summarizeResponses,
  summarizeSharing,
} from './events'
export { createIntimacyService } from './service'
export type { IntimacyResultRange, IntimacyService, IntimacyServiceDeps } from './service'
