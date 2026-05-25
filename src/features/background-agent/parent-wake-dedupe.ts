import { resolveRegisteredAgentName } from "../claude-code-session-state"

export type ParentWakePromptContext = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  tools?: Record<string, boolean>
}

export type PendingParentWake = {
  promptContext: ParentWakePromptContext
  notifications: string[]
  shouldReply: boolean
  dispatchedAt?: number
  toolCallDeferralStartedAt?: number
}

/**
 * Guard the model field shape before forwarding it to OpenCode core.
 *
 * OpenCode core expects `body.model` to be `{ providerID: string, modelID: string }`.
 * A persisted session message with a legacy/corrupt `info.model` (e.g. a plain
 * string, undefined fields, or a non-object) can flow through
 * `compaction-aware-message-resolver` undetected. If we forwarded a bad shape,
 * OpenCode's internal `parseModel(model)` (or similar `model.trim()` paths)
 * would throw `model.trim is not a function`, surfacing as unhandledRejection.
 *
 * Bug-03 (model.trim crash, issue #4061) chain: OpenCode emits the rejection,
 * OMO's process-cleanup converts it to a fatal exit, the host dies. Tier 1
 * stops the fatal exit; this Tier 3 guard stops the rejection from being
 * emitted in the first place from the parent-wake code path.
 */
export function sanitizeParentWakeModel(
  model: ParentWakePromptContext["model"],
): ParentWakePromptContext["model"] | undefined {
  if (!model || typeof model !== "object") return undefined
  const candidate = model as { providerID?: unknown; modelID?: unknown }
  if (typeof candidate.providerID !== "string" || candidate.providerID.length === 0) return undefined
  if (typeof candidate.modelID !== "string" || candidate.modelID.length === 0) return undefined
  return { providerID: candidate.providerID, modelID: candidate.modelID }
}

/**
 * Drop non-boolean entries from the tools object. Persisted shapes can contain
 * stringified or numeric flags that would not be honored by OpenCode core.
 */
export function sanitizeParentWakeTools(
  tools: ParentWakePromptContext["tools"],
): Record<string, boolean> | undefined {
  if (!tools || typeof tools !== "object") return undefined
  const out: Record<string, boolean> = {}
  let any = false
  for (const [name, enabled] of Object.entries(tools)) {
    if (typeof enabled === "boolean") {
      out[name] = enabled
      any = true
    }
  }
  return any ? out : undefined
}

export function resolveParentWakePromptContext(promptContext: ParentWakePromptContext): ParentWakePromptContext {
  const resolvedAgent = resolveRegisteredAgentName(promptContext.agent)
  const safeAgent = typeof resolvedAgent === "string" && resolvedAgent.length > 0 ? resolvedAgent : undefined
  const safeModel = sanitizeParentWakeModel(promptContext.model)
  const safeVariant = typeof promptContext.variant === "string" ? promptContext.variant : undefined
  const safeTools = sanitizeParentWakeTools(promptContext.tools)
  return {
    ...(safeAgent !== undefined ? { agent: safeAgent } : {}),
    ...(safeModel !== undefined ? { model: safeModel } : {}),
    ...(safeVariant !== undefined ? { variant: safeVariant } : {}),
    ...(safeTools !== undefined ? { tools: safeTools } : {}),
  }
}

export function cloneParentWake(wake: PendingParentWake): PendingParentWake {
  const promptContext = resolveParentWakePromptContext(wake.promptContext)
  return {
    promptContext,
    notifications: [...wake.notifications],
    shouldReply: wake.shouldReply,
    ...(wake.dispatchedAt !== undefined ? { dispatchedAt: wake.dispatchedAt } : {}),
    ...(wake.toolCallDeferralStartedAt !== undefined
      ? { toolCallDeferralStartedAt: wake.toolCallDeferralStartedAt }
      : {}),
  }
}

export function isRedundantParentWake(latestWake: PendingParentWake, dispatchedWake: PendingParentWake): boolean {
  return parentWakePromptContextMatches(latestWake, dispatchedWake)
    && parentWakeReplyModeIsCovered(latestWake, dispatchedWake)
    && parentWakeNotificationsAreCovered(latestWake, dispatchedWake)
}

function parentWakePromptContextMatches(left: PendingParentWake, right: PendingParentWake): boolean {
  return JSON.stringify(left.promptContext) === JSON.stringify(right.promptContext)
}

function parentWakeReplyModeIsCovered(latestWake: PendingParentWake, dispatchedWake: PendingParentWake): boolean {
  return !latestWake.shouldReply || dispatchedWake.shouldReply
}

function parentWakeNotificationsAreCovered(latestWake: PendingParentWake, dispatchedWake: PendingParentWake): boolean {
  const dispatchedNotifications = new Set(dispatchedWake.notifications)
  return latestWake.notifications.every((notification) => dispatchedNotifications.has(notification))
}
