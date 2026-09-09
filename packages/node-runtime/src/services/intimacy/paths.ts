import path from 'node:path'
import { getChatTopicsDir } from '../topics/paths'

export const INTIMACY_DB_FILENAME = 'intimacy.db'

export function getIntimacyDbPath(userDataDir: string): string {
  return path.join(getChatTopicsDir(userDataDir), INTIMACY_DB_FILENAME)
}
