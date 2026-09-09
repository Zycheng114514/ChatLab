import { getRegisteredAdapter } from '../registry'
import type { IntimacyAdapter } from './types'

export function useIntimacyService(): IntimacyAdapter {
  return getRegisteredAdapter<IntimacyAdapter>('intimacy')
}
