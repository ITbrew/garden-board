import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardLimits } from '@garden/shared'
import { actions } from '../state'
import { getIdentity, onTasks, refusalSentence } from '../tasks'
import { silenceOf } from '../task-types'

/**
 * One editable ceiling, with what already counts against it shown beside the number that governs
 * it, so the owner reads "4 of 12" rather than counting cards himself.
 *
 * Committed on blur or Enter rather than live as he types, since a half-typed number mid-edit is
 * not a value he meant to send yet. Reverts to the last known-good value on an invalid entry
 * rather than sending it and letting the server's own refusal explain why.
 */
function LimitRow({
  label,
  hint,
  value,
  counted,
  locked,
  onCommit,
}: {
  label: string
  hint: string
  value: number
  /** What already counts against this ceiling, or null when nothing does (children per card). */
  counted: number | null
  /** True on a tab the server has answered as a guest. See the note on the panel below. */
  locked: boolean
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))

  // The server's own value wins once it answers, the same rule every other setting in this app
  // follows, so two tabs adjusting the same project's ceiling never fight silently.
  useEffect(() => setText(String(value)), [value])

  const commit = () => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      setText(String(value))
      return
    }
    if (n !== value) onCommit(n)
  }

  return (
    <label className={`rail-limit-row ${locked ? 'is-locked' : ''}`} title={hint}>
      <span className="rail-limit-row__label">
        {label}
        {counted !== null && <em>{counted} of {value}</em>}
      </span>
      <input
        type="number"
        min={1}
        max={200}
        disabled={locked}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Enter commits through the same path as blur, rather than duplicating the check here.
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

/**
 * A figure that is watched rather than capped, drawn deliberately unlike the rows above it.
 *
 * No input and no "of", because there is no ceiling to be of. The owner's reading is that subagents
 * are background tools a session reaches for rather than agent work holding a window open, so the
 * board shows how many there are and limits none of them. Drawn as a row all the same so the number
 * sits with the ceilings it used to be silently folded into.
 *
 * A dash rather than a number when the server has not sent one. A server older than this panel
 * sends no figure at all, and drawing that as "0" would be the app asserting an emptiness it has
 * not been told about, which is the one thing it may never do.
 */
function WatchedRow({
  label,
  hint,
  count,
  locked,
}: {
  label: string
  hint: string
  count: number | undefined
  /** True on a guest tab. This row has nothing to disable, so the lock is only a look here. */
  locked: boolean
}) {
  return (
    <div className={`rail-limit-row ${locked ? 'is-locked' : ''}`} title={hint}>
      <span className="rail-limit-row__label">
        {label}
        <em>no limit</em>
      </span>
      <span className="rail-limit-row__watched">{count === undefined ? '—' : count}</span>
    </div>
  )
}

/**
 * How long an owner may be quiet before `owner_silent` is a reason that can be used.
 *
 * Its own row rather than a fourth `LimitRow`, because a `LimitRow` is a ceiling with a count
 * against it and this is neither: nothing is counted against it, and it is minutes rather than a
 * number of things. Its range is wider for the same reason, since a working day is well past the
 * 200 a card count is capped at.
 */
function SilenceRow({
  value,
  locked,
  onCommit,
}: {
  value: number | undefined
  locked: boolean
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])

  const commit = () => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n) || n < 1 || n > 10080) {
      setText(value === undefined ? '' : String(value))
      return
    }
    if (n !== value) onCommit(n)
  }

  return (
    <label
      className={`rail-limit-row ${locked ? 'is-locked' : ''}`}
      title="How long an owner's last recorded activity may be before a reassignment for owner_silent will be accepted. Minutes."
    >
      <span className="rail-limit-row__label">
        Silence before silent
        <em>{value === undefined ? 'not reported by this server' : 'minutes'}</em>
      </span>
      <input
        type="number"
        min={1}
        max={10080}
        disabled={locked}
        placeholder="—"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

/**
 * The three numbers that decide when `session.create` refuses, adjustable at any moment rather
 * than only at setup: the owner asked for this specifically, since a ceiling picked before a task
 * starts is a guess and the right number is usually clear only once the task is under way.
 *
 * `counted` is a snapshot from whenever this panel last asked (see the effect that requests it in
 * Sidebar.tsx), not a live figure, because the server only pushes it unprompted after `limits.set`
 * changes the ceiling itself. A stale "4 of 12" reads as "4 of 12", never as "the board just
 * changed under you", so it is worth being honest that it can lag by however long a round trip
 * takes rather than presenting it as more current than it is.
 */
export function LimitsPanel({
  projectId,
  limits,
  counted,
}: {
  projectId: string
  limits: BoardLimits
  /*
   * `subagents` is optional here on purpose, and it is the only optional field. The one line that
   * widens this type where it is stored lives in a file another card is holding, so this panel has
   * to typecheck against both the old shape and the new one until that lands. The row draws a dash
   * when it is missing, which is what it should draw against an older server anyway.
   */
  counted: { cards: number; running: number; subagents?: number }
}) {
  /*
   * Only the ceilings are sent back. `counted` is never spread into this, subagents included: what
   * the board is currently holding is the server's observation, and sending an observation back as
   * a setting is how a figure that is merely watched turns into a limit nobody chose.
   */
  const commit = (patch: Partial<BoardLimits>) => {
    actions.setLimits(projectId, { ...limits, ...patch })
  }

  /*
   * Whatever the server last refused a `limits.set` with. Subscribed as a plain string, which is
   * safe as a `useSyncExternalStore` snapshot in a way the list readers in `tasks.ts` are not:
   * strings compare by value, so an unchanged sentence is an unchanged snapshot.
   */
  const limitsRefusal = useSyncExternalStore(
    onTasks,
    () => refusalSentence('limits.set'),
    () => null,
  )

  /*
   * A guest's number boxes are locked, and this is the one place in the app where a control is
   * disabled rather than left to the server's refusal.
   *
   * The rule everywhere else is that a control sends and the server answers, because a disabled
   * button only says this page decided something. A text box is different in kind: it invites
   * typing, accepts it, and shows a number that is not the board's, so a guest reading the rail
   * sees a figure he typed and has no way to tell it was never set. A blind reader found exactly
   * this and put it plainly: the one section that looks pressable is the one the banner says he
   * cannot use. So these are locked to match the buttons beside them, and the server still refuses
   * a `limits.set` regardless, which is what actually enforces it.
   *
   * Safe as a snapshot for the same reason `App.tsx` reads it this way: `identity` is one
   * module-level value replaced only when `hello.ok` arrives.
   */
  const identity = useSyncExternalStore(onTasks, getIdentity, getIdentity)
  const locked = identity?.kind === 'guest'

  return (
    <div className="rail-limits">
      {/*
        "Agent cards", not "cards", because that is what the server counts.

        This said "Cards on this board" and its hint said every open card counts whatever it is
        doing, and both were false: a document card lives in a different table entirely and is never
        counted. A board showing five card-shaped things beside the words "4 of 12" is the app
        asserting a number it cannot back up, which is the one thing it is not allowed to do. Caught
        by a reviewer who counted the cards on screen and got a different answer.

        It happened a second time and worse, which is why subagents now have their own row below.
        They were counted here while the canvas had stopped drawing them, so a board showing three
        cards refused a fourth saying it held 22, and 19 of those were spent subagents from work that
        had finished. What is counted here is now what he can see: sessions and teammates.

        Documents are excluded on purpose rather than by oversight. This limit exists to bound
        processes and context windows, and a document card costs neither.
      */}
      <LimitRow
        label="Agent cards"
        hint="Cards drawn on this board that hold an agent or a process, running or not. Subagents have their own figure below and are not counted here. Document cards are not counted either, because this limit is about context windows and a document does not use one. Close or delete one to make room, or raise this."
        value={limits.cardsPerProject}
        counted={counted.cards}
        locked={locked}
        onCommit={(n) => commit({ cardsPerProject: n })}
      />
      <WatchedRow
        label="Subagents"
        hint="Spawned agents belonging to the cards above, kept as records rather than drawn on the board. Nothing limits how many there may be: they are background tools a session uses, not agent work holding a context window open."
        count={counted.subagents}
        locked={locked}
      />
      <LimitRow
        label="Running at once"
        hint="Cards with a live process, on this project's board. A card made switched off does not count until it is turned on."
        value={limits.running}
        counted={counted.running}
        locked={locked}
        onCommit={(n) => commit({ running: n })}
      />
      <LimitRow
        label="Children per card"
        hint="How many a single card may have reporting to it, when that card has not set a figure of its own."
        value={limits.childrenPerCard}
        counted={null}
        locked={locked}
        onCommit={(n) => commit({ childrenPerCard: n })}
      />
      <SilenceRow value={silenceOf(limits)} locked={locked} onCommit={(silenceMinutes) => commit({ silenceMinutes })} />
      {/*
        The server's sentence, under the rows that caused it.

        This used to hang off the task-ownership radios, which have gone: the setting is made from
        `garden-task.mjs authority` now, because the owner could not say what those three words
        meant. The sentence itself stays, because every row above still sends `limits.set` and a
        refused number that only appeared in the banner across the top would leave this panel
        showing a value the server never took. Attributed by `forT`, which `fail()` on the server
        sets to the client message's own `t`, so this is the refusal for a `limits.set` and not
        merely the most recent error on the board.
      */}
      {limitsRefusal && <p className="rail-refusal">{limitsRefusal}</p>}
    </div>
  )
}
