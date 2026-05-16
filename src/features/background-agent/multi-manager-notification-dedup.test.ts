import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { _resetBackgroundTaskStoresForTesting, getOrCreateBackgroundTaskStore } from "./task-store"

function castUnknown<T>(value: unknown): T {
  return value as T
}

function createPluginInput(directory: string): PluginInput {
  const client = {
    session: {
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      messages: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory } }),
    },
  }
  return castUnknown<PluginInput>({ client, directory })
}

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: `bg_${Math.random().toString(36).slice(2, 10)}`,
    parentSessionId: "parent-session",
    parentMessageId: "msg-1",
    description: "test task",
    prompt: "test prompt",
    agent: "test-agent",
    status: "running",
    startedAt: new Date(),
    ...overrides,
  }
}

type EmitFn = (task: BackgroundTask, transition: string) => Promise<boolean>

function getEmit(manager: BackgroundManager): EmitFn {
  return castUnknown<{ emitTerminalNotification: EmitFn }>(manager).emitTerminalNotification.bind(manager)
}

describe("multi-manager notification dedup", () => {
  test("same (task, transition) pair claimed by exactly one manager", () => {
    _resetBackgroundTaskStoresForTesting()
    const directory = join(tmpdir(), `omo-dedup-${Date.now()}`)
    const store = getOrCreateBackgroundTaskStore(directory)

    // when: two managers race on the same terminal transition
    const firstClaim = store.tryClaimTerminalTransition("bg_x", "completed")
    const secondClaim = store.tryClaimTerminalTransition("bg_x", "completed")

    // then: only the first wins
    expect(firstClaim).toBe(true)
    expect(secondClaim).toBe(false)
  })

  test("distinct transitions for same task each get their own claim", () => {
    _resetBackgroundTaskStoresForTesting()
    const directory = join(tmpdir(), `omo-dedup-${Date.now()}-2`)
    const store = getOrCreateBackgroundTaskStore(directory)

    const errored = store.tryClaimTerminalTransition("bg_y", "session-error")
    const completed = store.tryClaimTerminalTransition("bg_y", "completed")

    // task that errors then later completes (after retry) emits both
    expect(errored).toBe(true)
    expect(completed).toBe(true)
  })

  test("two managers sharing a directory share the dedup store", async () => {
    _resetBackgroundTaskStoresForTesting()
    const directory = join(tmpdir(), `omo-dedup-${Date.now()}-3`)

    const managerA = new BackgroundManager({ pluginContext: createPluginInput(directory) })
    const managerB = new BackgroundManager({ pluginContext: createPluginInput(directory) })

    const task = createTask({ id: "bg_shared", parentSessionId: "p1" })
    // both managers see the same shared task map
    managerA["tasks"].set(task.id, task)

    let notifyCallsA = 0
    let notifyCallsB = 0
    castUnknown<{ notifyParentSession: (t: BackgroundTask) => Promise<void> }>(managerA).notifyParentSession = async () => {
      notifyCallsA++
    }
    castUnknown<{ notifyParentSession: (t: BackgroundTask) => Promise<void> }>(managerB).notifyParentSession = async () => {
      notifyCallsB++
    }

    // when: both managers attempt to emit the same terminal transition
    const emitA = getEmit(managerA)
    const emitB = getEmit(managerB)
    const [resultA, resultB] = await Promise.all([
      emitA(task, "completed"),
      emitB(task, "completed"),
    ])

    // then: exactly one emit succeeded, the other was deduped
    expect([resultA, resultB].sort()).toEqual([false, true])
    expect(notifyCallsA + notifyCallsB).toBe(1)

    await managerA.shutdown()
    await managerB.shutdown()
  })

  test("managers in different directories do not share dedup state", async () => {
    _resetBackgroundTaskStoresForTesting()
    const dirA = join(tmpdir(), `omo-dedup-${Date.now()}-A`)
    const dirB = join(tmpdir(), `omo-dedup-${Date.now()}-B`)

    const managerA = new BackgroundManager({ pluginContext: createPluginInput(dirA) })
    const managerB = new BackgroundManager({ pluginContext: createPluginInput(dirB) })

    const taskA = createTask({ id: "bg_dirA" })
    const taskB = createTask({ id: "bg_dirB" })

    let emittedA = 0
    let emittedB = 0
    castUnknown<{ notifyParentSession: (t: BackgroundTask) => Promise<void> }>(managerA).notifyParentSession = async () => {
      emittedA++
    }
    castUnknown<{ notifyParentSession: (t: BackgroundTask) => Promise<void> }>(managerB).notifyParentSession = async () => {
      emittedB++
    }

    const emitA = getEmit(managerA)
    const emitB = getEmit(managerB)
    await emitA(taskA, "completed")
    await emitB(taskB, "completed")

    expect(emittedA).toBe(1)
    expect(emittedB).toBe(1)

    await managerA.shutdown()
    await managerB.shutdown()
  })

  test("shutdown of one manager does not clear shared store state", async () => {
    _resetBackgroundTaskStoresForTesting()
    const directory = join(tmpdir(), `omo-dedup-${Date.now()}-survive`)

    const managerA = new BackgroundManager({ pluginContext: createPluginInput(directory) })
    const managerB = new BackgroundManager({ pluginContext: createPluginInput(directory) })

    const task = createTask({ id: "bg_persist" })
    managerA["tasks"].set(task.id, task)

    await managerA.shutdown()

    expect(managerB["tasks"].get(task.id)).toBe(task)
    const store = getOrCreateBackgroundTaskStore(directory)
    expect(store.tasks.get(task.id)).toBe(task)

    await managerB.shutdown()
  })

  test("_resetBackgroundTaskStoresForTesting clears emittedTerminalTransitions", () => {
    const directory = join(tmpdir(), `omo-dedup-${Date.now()}-reset`)
    const store = getOrCreateBackgroundTaskStore(directory)
    expect(store.tryClaimTerminalTransition("bg_z", "completed")).toBe(true)

    _resetBackgroundTaskStoresForTesting()

    const freshStore = getOrCreateBackgroundTaskStore(directory)
    expect(freshStore.tryClaimTerminalTransition("bg_z", "completed")).toBe(true)
  })
})
