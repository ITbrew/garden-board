/**
 * What the board knows about task ownership, and where it hears it.
 *
 * Its own module with its own socket listener rather than another arm of `state.ts`, for the same
 * reason the work history and the pipeline are kept out of `AppState`: a refusal arriving against
 * one card should redraw the card it happened to, not the canvas. The card's own face and the pill
 * above it are the only readers now, and neither is on the hot path a terminal's bytes take.
 *
 * There was a Tasks panel that read all of this, and the owner asked for it to go: a board-wide list
 * of task rows was "a giant unstructured meaningless list of data ill never read". So this module is
 * down to what a card needs to say what it is holding and what has been refused against it. The
 * record itself is untouched: it lives on the server, and cards and the orchestrator read it through
 * `task.state` over the socket and `garden-task.mjs show`.
 */

import type { AgentEvent, ServerMessage, TaskContract } from '@garden/shared'
import { conn } from './connection'
import { isRefusal } from './task-types'

/**
 * Who the server says this connection is.
 *
 * `null` means it has not answered yet, which is neither owner nor guest and must not be drawn as
 * either: a page that said "reading only" for the half second before the handshake completes would
 * be telling the owner he cannot do something he can.
 */
export type Identity = { kind: 'owner' | 'guest' | 'card'; cardId: string | null } | null

let identity: Identity = null

/*
 * Per project, because the board is per project and everything else in this app that is
 * (`layouts`, `boardLimits`) learned the same lesson: one shared slot flashes the previous
 * project's rows for a moment on a tab switch, or shows nothing while a fresh answer round-trips.
 */
const tasksByProject = new Map<string, TaskContract[]>()
/*
 * The reassignment rows are not kept at all any more. They were kept for one reader, the Tasks
 * panel's "How it got here" list, and holding a growing list in every tab that nothing draws is a
 * leak with no upside. The rows themselves are the server's and are not touched: they arrive in
 * `task.state`, they are in the completion report the orchestrator reads, and `garden-task.mjs show`
 * prints them.
 */

/**
 * Refusals, kept in one flat list rather than per project.
 *
 * A refusal is recorded against the card that sent the message, and the card knows its project, but
 * the event itself carries only `sessionId`. Grouping by project here would mean looking a card up
 * at the moment a message arrives, and a card that has not loaded yet would put its refusals in the
 * wrong bucket permanently. Both readers filter it themselves, one by `sessionId` and one by the
 * task id in the payload, so nothing needs the grouping.
 */
let refusals: AgentEvent[] = []

/*
 * There was a flag here saying whether the server had ever reported refusals at all, so a panel
 * could draw "nothing reported" differently from "reported, and there are none". Only that panel
 * read it. The pill above a card has no such problem to solve: with no refusals there is no pill,
 * which asserts nothing either way.
 */

/**
 * The last sentence the server refused with, keyed by the message that caused it.
 *
 * `fail()` on the server sends `{ t: 'error', message, forT }` with `forT` set to the client
 * message's own `t` (`server/src/index.ts:123`), which is what makes it possible to put a refusal
 * where the click happened instead of only in the banner across the top. A refusal with no `forT`
 * is claimed by nothing here and stays in the banner, which is where it already went.
 */
const refusalFor = new Map<string, { message: string; at: number }>()

const subs = new Set<() => void>()

function changed() {
  for (const fn of subs) fn()
}

/**
 * Told that something about tasks changed, not what.
 *
 * The readers below that filter a list build a new array when they have something to return, so
 * none of them may be used as a `useSyncExternalStore` snapshot: that compares by identity and a
 * fresh array every render is the "Maximum update depth exceeded" freeze this app has already had
 * once. Subscribe here to bump a counter and compute in a `useMemo` keyed on it, which is what
 * `Canvas.tsx` already does with `historyTick`.
 */
export function onTasks(fn: () => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/**
 * One shared empty array, never a fresh one, for the same reason `NO_LAYOUTS` exists in `state.ts`:
 * `useSyncExternalStore` compares snapshots by identity and a new `[]` each render re-renders for
 * ever. That mistake cost the board once already and is four characters wide.
 */
const NO_REFUSALS: AgentEvent[] = []

/** The refusals recorded against one card, newest first, whatever task they were about. */
export function refusalsForCard(sessionId: string): AgentEvent[] {
  const mine = refusals.filter((r) => r.sessionId === sessionId)
  return mine.length ? mine : NO_REFUSALS
}

export function getIdentity(): Identity {
  return identity
}

/** The sentence the server refused one kind of message with, if it refused the last one. */
export function refusalSentence(forT: string): string | null {
  return refusalFor.get(forT)?.message ?? null
}

/**
 * The states in which a card is actually holding a task, so its face should say so.
 *
 * The three the order names, and they are the right three: `assigned` is a task that has an owner
 * and has not been sent yet, and `done` is one the owner has already reported finished. Neither is
 * work in hand, and a card wearing a task id for either would say it is busy with something it is
 * not.
 */
const HELD_STATES = new Set<string>(['working', 'remediating', 'in_review'])

/**
 * The task this card is holding right now, or null.
 *
 * Safe to use directly as a `useSyncExternalStore` snapshot, unlike the list readers above: it
 * returns a row out of the stored array rather than building anything, so between two `task.state`
 * messages it is the same object and React sees no change. When a card holds more than one, the one
 * most recently moved wins, because that is the one it is working on.
 */
export function heldTask(sessionId: string): TaskContract | null {
  let best: TaskContract | null = null
  for (const list of tasksByProject.values()) {
    for (const task of list) {
      if (task.ownerId !== sessionId) continue
      if (!HELD_STATES.has(task.state)) continue
      if (!best || task.updatedAt > best.updatedAt) best = task
    }
  }
  return best
}

/**
 * Read `identity` off `hello.ok`, which is `'owner' | 'guest' | { cardId }`.
 *
 * Written as a check rather than a cast because the whole point of this value is that the server
 * decides it: being wrong here would either tell the owner he is read-only when he is not, or say
 * nothing when he is. Anything that is none of the three leaves the identity unanswered, which is
 * drawn as "waiting" and never as guest.
 */
function readIdentity(value: 'owner' | 'guest' | { cardId: string }): Identity {
  if (value === 'owner') return { kind: 'owner', cardId: null }
  if (value === 'guest') return { kind: 'guest', cardId: null }
  if (value && typeof value === 'object' && typeof value.cardId === 'string') {
    return { kind: 'card', cardId: value.cardId }
  }
  return null
}

/**
 * Newest first, and capped at what the board sends.
 *
 * The server caps its snapshot at 200, so holding the same number of live ones keeps a long-running
 * tab from growing without bound while never being shorter than what a reload would give back.
 */
const REFUSAL_CAP = 200

function takeRefusals(rows: AgentEvent[]) {
  refusals = rows.filter(isRefusal).sort((a, b) => b.ts - a.ts).slice(0, REFUSAL_CAP)
}

conn.on((msg: ServerMessage) => {
  switch (msg.t) {
    /*
     * The full board snapshot carries the task rows, so a reload has them without a round trip.
     *
     * `state.ts` handles the rest of this same message and this reads only the three fields it does
     * not. Both listeners see it; neither knows about the other, which is the point of the socket
     * being a plain set of callbacks.
     */
    case 'state': {
      /*
       * Filed under each task's own `projectId` rather than under whichever tab is active, because
       * this snapshot is every project at once. Filing it under the active one would put a second
       * board's tasks on the first board permanently.
       */
      const byProject = new Map<string, TaskContract[]>()
      for (const task of msg.tasks ?? []) {
        const list = byProject.get(task.projectId) ?? []
        list.push(task)
        byProject.set(task.projectId, list)
      }
      /*
       * A project with no tasks still has to be recorded as answered, or its panel says "asking"
       * for ever. Every project in the snapshot gets an entry, empty or not, which is exactly the
       * set this message is authoritative about.
       */
      for (const p of msg.projects ?? []) if (!byProject.has(p.id)) byProject.set(p.id, [])
      for (const [projectId, list] of byProject) tasksByProject.set(projectId, list)

      /*
       * Guarded even though the type says it is always there.
       *
       * The shared types landed before the server that fills them, so a running server today sends
       * a `state` with none of these three fields. Reading `msg.refusals` straight would set the
       * "the server reported refusals" flag off an undefined, and every card would then say the
       * board has recorded none when the truth is that nobody has been asked.
       */
      if (Array.isArray(msg.refusals)) takeRefusals(msg.refusals)
      changed()
      return
    }

    /*
     * A refusal the server attributed to one kind of message, put where that message was sent from.
     *
     * `state.ts` also reads this and puts it in the banner across the top, and both are wanted: the
     * banner is how the owner notices at all, and this is how the sentence appears under the control
     * he pressed. Neither replaces the other and nothing here suppresses the banner.
     */
    case 'error': {
      const forT = msg.forT
      if (typeof forT === 'string' && (forT.startsWith('task.') || forT === 'limits.set' || forT === 'hello')) {
        refusalFor.set(forT, { message: msg.message, at: Date.now() })
        changed()
      }
      return
    }

    case 'hello.ok': {
      identity = readIdentity(msg.identity)
      /*
       * A fresh handshake is a fresh answer to everything the previous one was refused for. The
       * owner pastes his key precisely because something was refused, and leaving that sentence
       * under the control afterwards would say the refusal still stands when it may not.
       */
      refusalFor.clear()
      changed()
      return
    }

    case 'task.state': {
      tasksByProject.set(msg.projectId, msg.tasks)
      if (Array.isArray(msg.refusals)) takeRefusals(msg.refusals)
      changed()
      return
    }

    case 'task.updated': {
      const list = tasksByProject.get(msg.task.projectId)
      /*
       * A task for a project that has never answered is dropped rather than filed, because filing it
       * would create a one-row list that reads as "this project has one task" when the truth is that
       * nothing has been asked. The `state` snapshot answers for every project on connect, so the
       * row arrives with the rest a moment later.
       */
      if (!list) return
      const at = list.findIndex((task) => task.id === msg.task.id)
      tasksByProject.set(
        msg.task.projectId,
        at === -1 ? [...list, msg.task] : list.map((task) => (task.id === msg.task.id ? msg.task : task)),
      )
      changed()
      return
    }

    /*
     * `task.reassigned` is deliberately not handled. It carried one row for a list this app no
     * longer draws, and the task itself arrives on `task.updated` in the same breath, so the card
     * face is current without it. Ignoring a message is not the same as the board forgetting it: the
     * row is stored on the server either way.
     */

    /*
     * The live half of the refusal list, and the only kind of event this client reads.
     *
     * Every other event type on this message is still dropped exactly as it was before: the board
     * records dozens of kinds and nothing in the app has ever drawn one. What changed is that three
     * of them now have somewhere to go. An event that arrives here and is also in the snapshot is
     * one row, deduped on the id the server gave it.
     */
    case 'event': {
      if (!isRefusal(msg.event)) return
      if (refusals.some((r) => r.id === msg.event.id)) return
      refusals = [msg.event, ...refusals].slice(0, REFUSAL_CAP)
      changed()
      return
    }
  }
})

/*
 * There were four actions here: `list`, `bind`, `reassign` and `verifier`, and they existed for the
 * Tasks panel's controls. They went with the panel. Nothing in the app declares or moves an
 * ownership now, which is the point: canon says the record is for cards and the orchestrator, who
 * bind and reassign through `garden-task.mjs` and are checked by the same rules either way. The
 * rows still arrive here unasked, in the `state` snapshot and in `task.state`, which is what keeps a
 * card's face current without anything on this page asking for them.
 */
