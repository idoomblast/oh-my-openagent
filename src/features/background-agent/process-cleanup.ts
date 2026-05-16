import { log } from "../../shared"

type ProcessCleanupSignal = NodeJS.Signals | "beforeExit" | "exit"
type ProcessCleanupErrorEvent = "uncaughtException" | "unhandledRejection"

/**
 * When set to a truthy value (1/true/yes/on), suppresses BOTH global
 * uncaughtException AND unhandledRejection handlers entirely (legacy
 * opt-out from issue #3856). Signal handlers stay registered.
 */
const PROCESS_CLEANUP_DISABLE_ENV = "OMO_DISABLE_PROCESS_CLEANUP"

/**
 * When set to a truthy value, OPTS IN to the legacy behavior where an
 * unhandledRejection from anywhere in the host (including OpenCode core
 * or unrelated plugins) force-exits the process. Default is now log-only
 * for rejections to prevent OMO from killing the sidecar/server on
 * transient or third-party rejections (see issue #4061 + the model.trim
 * crash chain observed 2026-05-16).
 *
 * uncaughtException ALWAYS force-exits regardless of this flag — a
 * synchronously-thrown unhandled exception means the process state is
 * already corrupt.
 */
const FORCE_EXIT_ON_REJECTION_ENV = "OMO_FORCE_EXIT_ON_REJECTION"
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"])

function isTruthyEnv(name: string): boolean {
  const raw = process.env[name]
  if (!raw) return false
  return TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase())
}

function isProcessCleanupErrorHandlersDisabled(): boolean {
  return isTruthyEnv(PROCESS_CLEANUP_DISABLE_ENV)
}

function isForceExitOnRejectionEnabled(): boolean {
  return isTruthyEnv(FORCE_EXIT_ON_REJECTION_ENV)
}

/** @internal test-only seam: prevents process.exitCode from contaminating bun test runner */
let _scheduleForcedExitEnabled = true

/** @internal test-only */
export function __disableScheduledForcedExitForTesting(): void {
  _scheduleForcedExitEnabled = false
}

/** @internal test-only */
export function __enableScheduledForcedExitForTesting(): void {
  _scheduleForcedExitEnabled = true
}

function scheduleForcedExit(
  cleanupResult: void | Promise<void>,
  exitCode: number,
  exitAfterCleanup = false,
): void {
  if (!_scheduleForcedExitEnabled) return
  process.exitCode = exitCode
  const exitTimeout = setTimeout(() => process.exit(), 6000)
  void Promise.resolve(cleanupResult).finally(() => {
    clearTimeout(exitTimeout)
    if (exitAfterCleanup) {
      process.exit(exitCode)
    }
  })
}

function registerProcessSignal(
  signal: ProcessCleanupSignal,
  handler: () => void | Promise<void>,
  exitAfter: boolean
): () => void {
  const listener = () => {
    const cleanupResult = handler()
    if (exitAfter) {
      scheduleForcedExit(cleanupResult, 0)
    }
  }
  process.on(signal, listener)
  return listener
}

function registerErrorEvent(
  signal: ProcessCleanupErrorEvent,
  handler: (error: unknown) => void | Promise<void>
): (error: unknown) => void {
  const listener = (error: unknown) => {
    // Detach before running the body so a re-emit from inside log()/handler()
    // (e.g. EPIPE while closing a broken pipe during shutdown) cannot recurse.
    // Prior behavior: the listener re-entered itself, re-logged, re-ran cleanup,
    // and threw EPIPE again — an unbounded loop that filled disks with 100+ GB
    // of log lines in minutes before the 6 s forced-exit timer could fire.
    process.off(signal, listener)
    log(`[background-agent] ${signal} received during shutdown cleanup:`, error)
    scheduleForcedExit(handler(error), 1, true)
  }
  process.on(signal, listener)
  return listener
}

/**
 * Log the rejection but do NOT shut down or exit. Used for unhandledRejection
 * by default, so OMO no longer kills the OpenCode host (CLI/Desktop sidecar)
 * on rejections that originated outside OMO code paths.
 *
 * Re-attaches itself after each invocation so subsequent rejections keep
 * being observed (Node's default would otherwise be silent).
 */
function registerLoggingErrorEvent(
  signal: ProcessCleanupErrorEvent,
): (error: unknown) => void {
  const listener = (error: unknown) => {
    process.off(signal, listener)
    log(
      `[background-agent] ${signal} observed (non-fatal: OMO does not exit on this; `
        + `set ${FORCE_EXIT_ON_REJECTION_ENV}=1 to restore legacy force-exit):`,
      error,
    )
    process.on(signal, listener)
  }
  process.on(signal, listener)
  return listener
}

interface CleanupTarget {
  shutdown(): void | Promise<void>
}

const cleanupManagers = new Set<CleanupTarget>()
let cleanupRegistered = false
const cleanupSignalHandlers = new Map<ProcessCleanupSignal, () => void>()
const cleanupErrorHandlers = new Map<ProcessCleanupErrorEvent, (error: unknown) => void>()

export function registerManagerForCleanup(manager: CleanupTarget): void {
  cleanupManagers.add(manager)

  if (cleanupRegistered) return
  cleanupRegistered = true

  let cleanupPromise: Promise<void> | undefined

  const cleanupAll = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    const promises: Promise<void>[] = []
    for (const m of cleanupManagers) {
      try {
        promises.push(
          Promise.resolve(m.shutdown()).catch((error) => {
            log("[background-agent] Error during async shutdown cleanup:", error)
          })
        )
      } catch (error) {
        log("[background-agent] Error during shutdown cleanup:", error)
      }
    }
    cleanupPromise = Promise.allSettled(promises).then(() => {})
    cleanupPromise.then(() => {
      log("[background-agent] All shutdown cleanup completed")
    })

    return cleanupPromise
  }

  const registerSignal = (signal: ProcessCleanupSignal, exitAfter: boolean): void => {
    const listener = registerProcessSignal(signal, cleanupAll, exitAfter)
    cleanupSignalHandlers.set(signal, listener)
  }

  registerSignal("SIGINT", true)
  registerSignal("SIGTERM", true)
  if (process.platform === "win32") {
    registerSignal("SIGBREAK", true)
  }
  registerSignal("beforeExit", false)
  registerSignal("exit", false)

  if (isProcessCleanupErrorHandlersDisabled()) {
    log(
      `[background-agent] ${PROCESS_CLEANUP_DISABLE_ENV} is set; skipping global uncaughtException/unhandledRejection handler registration. `
        + "Signal handlers (SIGINT/SIGTERM/beforeExit/exit) remain active.",
    )
    return
  }

  // uncaughtException still force-exits: a synchronously-thrown unhandled
  // exception means the process state is already corrupt.
  cleanupErrorHandlers.set("uncaughtException", registerErrorEvent("uncaughtException", cleanupAll))

  // unhandledRejection defaults to log-only. The legacy force-exit behavior
  // killed the OpenCode host on rejections from OpenCode core (e.g. the
  // model.trim crash) or unrelated plugins (e.g. ctx.$ from notification
  // code, see issue #4061). Opt back in with OMO_FORCE_EXIT_ON_REJECTION=1.
  if (isForceExitOnRejectionEnabled()) {
    log(
      `[background-agent] ${FORCE_EXIT_ON_REJECTION_ENV} is set; restoring legacy `
        + "force-exit-on-unhandledRejection behavior.",
    )
    cleanupErrorHandlers.set(
      "unhandledRejection",
      registerErrorEvent("unhandledRejection", cleanupAll),
    )
  } else {
    cleanupErrorHandlers.set("unhandledRejection", registerLoggingErrorEvent("unhandledRejection"))
  }
}

export function unregisterManagerForCleanup(manager: CleanupTarget): void {
  cleanupManagers.delete(manager)

  if (cleanupManagers.size > 0) return

  for (const [signal, listener] of cleanupSignalHandlers.entries()) {
    process.off(signal, listener)
  }
  for (const [signal, listener] of cleanupErrorHandlers.entries()) {
    process.off(signal, listener)
  }
  cleanupSignalHandlers.clear()
  cleanupErrorHandlers.clear()
  cleanupRegistered = false
}

/** @internal - test-only reset for module-level singleton state */
export function _resetForTesting(): void {
  for (const manager of [...cleanupManagers]) {
    cleanupManagers.delete(manager)
  }
  for (const [signal, listener] of cleanupSignalHandlers.entries()) {
    process.off(signal, listener)
  }
  for (const [signal, listener] of cleanupErrorHandlers.entries()) {
    process.off(signal, listener)
  }
  cleanupSignalHandlers.clear()
  cleanupErrorHandlers.clear()
  cleanupRegistered = false
}
