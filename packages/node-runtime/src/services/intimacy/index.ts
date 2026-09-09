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
  SHARED_PLAN_STAGES,
  buildIntimacyWindowPrompt,
  checkSharedPlanStageSenders,
  parseIntimacyResponse,
  resolveIntimacyPreprocess,
} from './model-protocol'
export type {
  IntimacyPreprocessOptions,
  ParsedFollowUpEvent,
  ParsedGoodNewsEvent,
  ParsedIntimacyEvent,
  ParsedResponseGroup,
  ParsedSharedPlanEvent,
  ParsedSharedPlanStage,
  ParsedSharingEvent,
} from './model-protocol'
export {
  INTIMACY_FOLLOW_UP_LOOKBACK_SECONDS,
  INTIMACY_FOLLOW_UP_MERGE_GAP_SECONDS,
  applyFollowUpPairing,
  applyReviewDetails,
  buildIntimacyEvents,
  buildSharedPlanDetails,
  clampSharedPlanDetails,
  findSharingEventCovering,
  mergeSharedPlanEvents,
  resolveEventStatus,
  summarizeFollowUps,
  summarizeResponses,
  summarizeSharedPlans,
  summarizeSharing,
} from './events'
export type { FollowUpPairing, SharedPlanRange } from './events'
export {
  INTIMACY_FOLLOW_UP_MAX_CANDIDATES,
  buildFollowUpMatchPrompt,
  collectFollowUpCandidates,
  parseFollowUpMatch,
  resolveFollowUpInitiation,
} from './follow-up-matcher'
export type {
  FollowUpAnchor,
  FollowUpCandidate,
  FollowUpCandidateInput,
  FollowUpMatch,
  FollowUpMatchPromptInput,
  FollowUpMatchScope,
} from './follow-up-matcher'
export { buildAssociationPrompt, parseAssociationMatch, toIntimacySourceMessages } from './association'
export type { AssociationPromptInput } from './association'
export {
  INTIMACY_SHARED_PLAN_LOOKBACK_SECONDS,
  INTIMACY_SHARED_PLAN_MAX_CANDIDATES,
  buildSharedPlanMatchPrompt,
  collectSharedPlanCandidates,
  parseSharedPlanMatch,
} from './shared-plan-matcher'
export type {
  SharedPlanCandidate,
  SharedPlanCandidateInput,
  SharedPlanMatch,
  SharedPlanMatchPromptInput,
} from './shared-plan-matcher'
export { createIntimacyService } from './service'
export type { IntimacyResultRange, IntimacyService, IntimacyServiceDeps } from './service'
