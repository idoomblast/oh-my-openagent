import { log } from "../../shared/logger"

/**
 * Cross-manager dedup state shared per-directory across all
 * `BackgroundManager` instances in the same process (typical under
 * `opencode serve` + multiple `opencode attach` clients, where each
 * attach triggers a fresh `serverPlugin()` invocation and constructs
 * its own `BackgroundManager`).
 *
 * Task data itself is NOT stored here — that's handled per-instance plus
 * `task-registry.ts` (globalThis-backed registry of redacted clones).
 * The single responsibility of this store is the dedup primitive below:
 * when multiple managers observe the same session-idle event for a child
 * task, only one of them gets to emit the parent notification.
 */
export class BackgroundTaskStore {
  readonly emittedTerminalTransitions = new Set<string>()

  /**
   * Atomically claim the right to emit a parent notification for the given
   * (task, terminal transition) pair. Returns true exactly once across all
   * managers sharing this store. Subsequent callers for the same pair get
   * false and must skip notification.
   *
   * Each distinct terminal transition (completed, error, cancelled,
   * interrupt, retry) for the same task is its own claim, so a task that
   * errors, retries, then completes legitimately emits twice.
   */
  tryClaimTerminalTransition(taskId: string, transition: string): boolean {
    const key = `${taskId}:${transition}`
    if (this.emittedTerminalTransitions.has(key)) {
      return false
    }
    this.emittedTerminalTransitions.add(key)
    return true
  }
}

const stores = new Map<string, BackgroundTaskStore>()

export function getOrCreateBackgroundTaskStore(key: string): BackgroundTaskStore {
  const existing = stores.get(key)
  if (existing) {
    return existing
  }
  const store = new BackgroundTaskStore()
  stores.set(key, store)
  log("[background-task-store] created", { key })
  return store
}

/** Test-only. Production code must never call this. */
export function _resetBackgroundTaskStoresForTesting(): void {
  stores.clear()
}
