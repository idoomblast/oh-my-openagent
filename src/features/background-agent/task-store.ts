import { BackgroundTask } from "./types"

const stores = new Map<string, BackgroundTaskStore>()

export class BackgroundTaskStore {
  readonly tasks = new Map<string, BackgroundTask>()
  readonly tasksByParentSession = new Map<string, Set<string>>()
  readonly completedTaskArchive = new Map<string, BackgroundTask>()
}

export function getOrCreateBackgroundTaskStore(key: string): BackgroundTaskStore {
  const existing = stores.get(key)
  if (existing) return existing
  const store = new BackgroundTaskStore()
  stores.set(key, store)
  return store
}

/** Test-only: reset all stores between tests to prevent state bleeding */
export function _resetBackgroundTaskStoresForTesting(): void {
  stores.clear()
}
