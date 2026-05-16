import { log } from "../../shared/logger"
import type { BackgroundTask } from "./types"

type ParentWakePromptContext = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  tools?: Record<string, boolean>
}

export type PendingParentWake = {
  promptContext: ParentWakePromptContext
  notifications: string[]
  shouldReply: boolean
}

/**
 * Process-level shared task storage. Multiple `BackgroundManager` instances
 * for the same working directory (typical with `opencode serve` plus
 * multiple `opencode attach` clients) reference the same Maps so that
 * `task` and `background_output` always observe the same task set.
 *
 * Storage AND notification-coordination state is shared. Per-manager
 * lifecycle (polling intervals, in-flight session abort, per-instance
 * timers) stays per-instance.
 *
 * Shared additions over the original task-only store:
 * - `pendingParentWakes`: queued parent-wake payloads (any manager's flush
 *   timer can drain them).
 * - `notificationQueueByParent`: per-parent serialization chain so wakes for
 *   the same parent never interleave even across managers.
 * - `emittedTerminalTransitions`: dedup set so a "task X reached terminal
 *   status Y" event emits exactly one parent notification, regardless of
 *   how many managers observed the underlying signal.
 */
export class BackgroundTaskStore {
  readonly tasks = new Map<string, BackgroundTask>()
  readonly tasksByParentSession = new Map<string, Set<string>>()
  readonly completedTaskArchive = new Map<string, BackgroundTask>()
  readonly pendingParentWakes = new Map<string, PendingParentWake>()
  readonly notificationQueueByParent = new Map<string, Promise<void>>()
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

/** Test-only. Never call from production code: would orphan live tasks. */
export function _resetBackgroundTaskStoresForTesting(): void {
  stores.clear()
}
