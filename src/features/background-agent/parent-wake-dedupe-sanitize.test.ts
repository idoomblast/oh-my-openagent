/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { sanitizeParentWakeModel, sanitizeParentWakeTools } from "./parent-wake-dedupe"

describe("#given sanitizeParentWakeModel", () => {
  test("#when given the canonical { providerID, modelID } shape #then returns the same shape", () => {
    const input = { providerID: "anthropic", modelID: "claude-opus-4-7" }
    expect(sanitizeParentWakeModel(input)).toEqual(input)
  })

  test("#when given undefined #then returns undefined", () => {
    expect(sanitizeParentWakeModel(undefined)).toBeUndefined()
  })

  test("#when given a plain string (bug-03 trigger) #then returns undefined instead of forwarding", () => {
    // Persisted legacy session messages occasionally store info.model as a
    // string. Forwarding that to OpenCode core's parseModel triggers the
    // model.trim crash chain. Sanitizer must drop it.
    const input = "anthropic/claude-opus-4-7" as unknown
    expect(sanitizeParentWakeModel(input as Parameters<typeof sanitizeParentWakeModel>[0])).toBeUndefined()
  })

  test("#when providerID is missing #then returns undefined", () => {
    const input = { modelID: "claude-opus-4-7" } as unknown
    expect(sanitizeParentWakeModel(input as Parameters<typeof sanitizeParentWakeModel>[0])).toBeUndefined()
  })

  test("#when modelID is missing #then returns undefined", () => {
    const input = { providerID: "anthropic" } as unknown
    expect(sanitizeParentWakeModel(input as Parameters<typeof sanitizeParentWakeModel>[0])).toBeUndefined()
  })

  test("#when providerID is an empty string #then returns undefined", () => {
    expect(sanitizeParentWakeModel({ providerID: "", modelID: "claude-opus-4-7" })).toBeUndefined()
  })

  test("#when modelID is a non-string #then returns undefined", () => {
    const input = { providerID: "anthropic", modelID: 123 } as unknown
    expect(sanitizeParentWakeModel(input as Parameters<typeof sanitizeParentWakeModel>[0])).toBeUndefined()
  })

  test("#when given extra fields #then drops them, returns only providerID/modelID", () => {
    const input = { providerID: "anthropic", modelID: "claude-opus-4-7", variant: "fast", extra: 1 } as unknown
    expect(sanitizeParentWakeModel(input as Parameters<typeof sanitizeParentWakeModel>[0])).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
    })
  })
})

describe("#given sanitizeParentWakeTools", () => {
  test("#when given a record of booleans #then returns it unchanged", () => {
    expect(sanitizeParentWakeTools({ read: true, write: false })).toEqual({ read: true, write: false })
  })

  test("#when given undefined #then returns undefined", () => {
    expect(sanitizeParentWakeTools(undefined)).toBeUndefined()
  })

  test("#when given non-boolean values #then drops them", () => {
    const input = { read: true, write: "yes", count: 1 } as unknown
    expect(sanitizeParentWakeTools(input as Parameters<typeof sanitizeParentWakeTools>[0])).toEqual({ read: true })
  })

  test("#when all values are non-boolean #then returns undefined", () => {
    const input = { read: "yes", write: 1 } as unknown
    expect(sanitizeParentWakeTools(input as Parameters<typeof sanitizeParentWakeTools>[0])).toBeUndefined()
  })

  test("#when given empty object #then returns undefined", () => {
    expect(sanitizeParentWakeTools({})).toBeUndefined()
  })
})
