/**
 * What this app adds on top of the task ownership types, now that they are shared.
 *
 * There was a copy of every shape in here while the Worker was landing them in
 * `packages/shared/src/index.ts`, with one cast in each direction so the socket could carry
 * messages `ClientMessage` and `ServerMessage` did not have yet. All of that is gone: the types are
 * real, the messages are in the protocol, and this file is down to the three things that are
 * genuinely the UI's own business.
 *
 * It is smaller again since the sidebar lost its task surfaces: the reason list and the three
 * authority choices were the words those controls read by, and they went with them. What is left is
 * the reader for a refusal's payload, because `AgentEvent.payload` is `unknown` and somebody has to
 * be careful with it exactly once, and one guard for a limits field an older server may not send.
 */

import type { AgentEvent, BoardLimits } from '@garden/shared'

/** The event types this UI draws as refusals. Everything else on the `event` message is ignored. */
export const TASK_EVENT_TYPES = ['TaskRefused', 'TaskWouldRefuse', 'SenderUnverified'] as const
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number]

/** Whether an event is one of the three, narrowed so callers do not each decide for themselves. */
export function isRefusal(event: AgentEvent): boolean {
  return (TASK_EVENT_TYPES as readonly string[]).includes(event.type)
}

/**
 * What a refusal says, read off a payload that is typed `unknown`.
 *
 * `AgentEvent.payload` is `unknown` for the whole board and that is right: events come from hooks
 * and from a dozen places in the server, and pretending one shape fits them would be a lie in the
 * type system. So the carefulness happens once, here. Every field comes back `null` when it is
 * absent or the wrong type, and the components draw a null as "not named" rather than as an empty
 * string, because a refusal that arrived without a rule is a different thing from a refusal whose
 * rule is blank, and only one of them is worth chasing.
 */
export interface RefusalFacts {
  taskId: string | null
  kind: string | null
  rule: string | null
  reason: string | null
  to: string | null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function refusalFacts(event: AgentEvent): RefusalFacts {
  const p = (event.payload ?? {}) as Record<string, unknown>
  if (typeof p !== 'object') return { taskId: null, kind: null, rule: null, reason: null, to: null }
  return {
    taskId: str(p.taskId),
    kind: str(p.kind),
    rule: str(p.rule),
    reason: str(p.reason),
    to: str(p.to),
  }
}

// ---------------------------------------------------------------------------
// One field the running server may not have caught up to yet
// ---------------------------------------------------------------------------

/*
 * `BoardLimits` requires `silenceMinutes`, so TypeScript will happily let this app read it and be
 * sure of an answer. The running server is a separate question: the shared types landed before the
 * server half that fills them, so a `limits` message on the wire may carry neither. A panel that
 * trusted the type would draw an empty number box with nothing to say for itself.
 *
 * So it is read through a check rather than straight off the object, and an absent one is drawn as
 * "not reported by this server", which is the honest reading now and the right reading later
 * against an older server. There was a matching `authorityOf` beside this, read by the task
 * ownership radios in the Ceiling panel; those went at the owner's request and the setting is made
 * from `garden-task.mjs authority` now, so nothing in the app reads the field.
 */

/** The silence window this server actually reported, or undefined when it reported none. */
export function silenceOf(limits: BoardLimits): number | undefined {
  const v = (limits as Partial<BoardLimits>).silenceMinutes
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
