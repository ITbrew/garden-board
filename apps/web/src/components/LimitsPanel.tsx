import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardLimits } from '@garden/shared'
import { actions } from '../state'
import { getIdentity, onTasks, refusalSentence } from '../tasks'


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
  unit,
  locked,
  moot,
  onCommit,
}: {
  label: string
  hint: string
  value: number
  /** What already counts against this ceiling, or null when nothing does (children per card). */
  counted: number | null
  /**
   * What the figure is counted over, for the rows that have no board-wide count to show.
   *
   * Not a number and never derived from one. Two blind readers given only this panel said the same
   * two things: that they could not tell whether the boxes on the uncounted rows were limits or
   * current readings, and that the spawn limit carried no units at all, so "4" might be four
   * parents, four spawns each, or four at a time. Both are answered by saying what the figure is
   * per, which is a fact about the field rather than a measurement of the board, so nothing here
   * can be stale or invented.
   *
   * It sits in the same slot as "3 of 12" deliberately. The alternative was to borrow the board's
   * subagent total to fill the gap, which would read as "12 of 5" and would be the panel asserting
   * a relationship between two numbers that have none.
   */
  unit?: string
  /** True on a tab the server has answered as a guest. See the note on the panel below. */
  locked: boolean
  /**
   * True when this row governs something the board has switched off, which greys it and says why.
   *
   * A separate prop from `locked` although both end up grey, because they are different facts and
   * the row has to be able to say which one it is. Locked is "this tab may not change anything";
   * this is "the board is not doing this at all, so there is nothing for this number to govern".
   */
  moot?: string
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
    <label className={`rail-limit-row ${locked || moot ? 'is-locked' : ''}`} title={moot || hint}>
      <span className="rail-limit-row__label">
        {label}
        {/*
          The reason replaces the unit rather than sitting beside it. A row that governs nothing
          right now has no useful unit to state, and two small lines under one label is how the
          panel stopped being readable the last time.
        */}
        {moot ? <em>{moot}</em> : counted !== null ? <em>{counted} of {value}</em> : unit ? <em>{unit}</em> : null}
      </span>
      <input
        type="number"
        min={1}
        max={200}
        disabled={locked || !!moot}
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
 * The one row on this panel that is not a number.
 *
 * A select rather than a checkbox, and rather than the number box beside it, because the answer is
 * two words and both of them should be readable without interacting with the control. A checkbox
 * says yes by being filled in and no by being empty, which is a thing the reader has to already
 * know; "Yes" and "No" are the answer written down. It sits in the same 52px column as the number
 * boxes so the five rows still line up as one panel.
 *
 * Committed on change rather than on blur, unlike `LimitRow`. There is no half-typed state to wait
 * out: a select has only ever been at one of its two answers.
 */
function LimitChoice({
  label,
  hint,
  value,
  unit,
  locked,
  onCommit,
}: {
  label: string
  hint: string
  /** Undefined where the server has not sent one, which reads as yes rather than as no. */
  value: boolean | undefined
  unit?: string
  locked: boolean
  onCommit: (v: boolean) => void
}) {
  return (
    <label className={`rail-limit-row ${locked ? 'is-locked' : ''}`} title={hint}>
      <span className="rail-limit-row__label">
        {label}
        {unit ? <em>{unit}</em> : null}
      </span>
      <select
        className="rail-limit-row__choice"
        disabled={locked}
        /*
         * Only an explicit false reads as No, so a server that has not been rebuilt since this
         * field arrived sends nothing and the row shows Yes.
         *
         * `value ? 'yes' : 'no'` was the obvious line and it fails in the one direction that
         * matters: against an older server the row sat on No, refused to move off it, and looked
         * like a broken control rather than like a field the server had never heard of. The owner
         * hit exactly that: "i cant change sub agents allowed from no to yes".
         */
        value={value === false ? 'no' : 'yes'}
        onChange={(e) => onCommit(e.target.value === 'yes')}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
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
   * `subagents` is carried but not drawn. It is a per-project count of records and the row above is
   * a per-card ceiling, so putting them together would assert a ratio neither number supports. It
   * stays in the type because the server sends it and dropping it here would only hide that.
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
        Every row carries a line under its label, and only two of those lines are counts.

        A blind reader called the old section uneven, and the first answer to that was to leave it
        uneven and say why: only two of the five have a count that is a board figure, and the
        board's subagent total beside a per-card allowance would read as "12 of 5", which is this
        panel asserting a relationship between two numbers that have none.

        Two more blind readers, given only the panel, showed that leaving it there cost more than
        the tidiness. Neither could tell whether the boxes on the three uncounted rows were limits
        or current readings, and both independently named the spawn limit as the row they would be
        least willing to change, because "4" with no unit might be four parents, four spawns each,
        or four at a time. That is not a layout complaint. That is three rows the owner cannot
        safely edit.

        So the line is now a count where a count exists and a unit where one does not. A unit is a
        fact about the field rather than a measurement of the board, so it cannot be stale, cannot
        be invented, and cannot imply a ratio. The column reads evenly because every row now says
        something true, not because a number was borrowed to fill a gap.
      */}
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
      <LimitRow
        label="Agent cards running at once"
        hint="Cards with a live process, on this project's board. A card made switched off does not count until it is turned on."
        value={limits.running}
        counted={counted.running}
        locked={locked}
        onCommit={(n) => commit({ running: n })}
      />
      {/*
        The five rows are five different mechanisms and only this one is refused by Garden itself.

        Canon 15 says that out loud because a panel of near-identical controls implies one authority
        behind all of them, and there are three: the server refuses cards and starts, the CLI holds
        the concurrency figure below, and this row is held by Garden's own hook, which denies the
        dispatch tool before the subagent exists. The hint has to carry that difference, since the
        controls cannot.

        Yes or no rather than a figure, since 2026-09-09: "change 'subagents allowed' to be yes or
        no since subagents are disposable i dontw ant to create a cap for how many iit can create
        its whole life". It shipped for about an hour as a lifetime count. The shape was the fault
        rather than the number, and being the odd control on a panel of number boxes is the point:
        this row asks a different kind of question from the four around it.
      */}
      <LimitChoice
        label="Subagents allowed"
        hint="Whether cards on this board may dispatch subagents at all. This is the one subagent decision Garden holds itself: its hook refuses the dispatch before the subagent exists, and says which card was refused and where to change this. Set to No it takes effect on the very next dispatch, including on a card that is already running, which is what makes it different from a card's own permission to spawn agents. Nothing already running is stopped and no record is removed."
        value={limits.subagentsAllowed}
        unit="everywhere on this board"
        locked={locked}
        onCommit={(v) => commit({ subagentsAllowed: v })}
      />
      {/*
        A figure that can be changed, since 2026-09-09: "make sub agents field modifiable, its
        currently static and limits cant be changed". It was drawn as a watched number with the words
        "no limit" beside it, which was accurate and read as broken.

        Garden does not hold it. The CLI does, from the settings file Garden writes for a card when
        it launches, so the hint says at launch rather than letting the row imply that typing here
        reaches a card already running.

        Its label moved from "Subagents allowed" to "Subagents at once" on 2026-09-09 and its
        meaning did not move with it. The row above took the old name because the owner gave that
        name to the permission, and leaving two rows both called "allowed" would have made the panel
        unreadable in the one place it now has two subagent settings.

        No "n of m" beside the label, unlike the rows around it. The board's subagent count is per
        project and this figure is per card, so the two do not divide, and a row reading "12 of 5"
        would be the panel inventing a relationship between two numbers that have none.
      */}
      <LimitRow
        label="Subagents at once"
        moot={limits.subagentsAllowed === false ? 'nothing to cap, subagents are off' : undefined}
        hint="How many subagents one card may run at the same moment. Garden does not enforce this: it writes the number into the card's settings file when the card launches and the CLI holds it, which is why it reaches cards turned on after the change rather than one already running. It caps how many run at the same moment; whether a card may dispatch one at all is the row above. A card given its own team size is held to that instead of this."
        value={limits.subagents}
        counted={null}
        unit="per card, at any one moment"
        locked={locked}
        onCommit={(n) => commit({ subagents: n })}
      />
      {/*
        The owner's name for `childrenPerCard`, and a hint that does not repeat the name back as a
        claim.

        He asked for "Orchestrator Spawn Limit ... which refers to how many cards orchestrator can
        spawn", and the orchestrator is the card that does nearly all the spawning here, so the name
        is his and it is a fair name. The field is wider than the name: it governs any parent that
        set no team size of its own. Canon 15 revision 7 settles the two against each other by
        saying a label is a name and a hint is a claim, so the name stays his and the hint says what
        the field actually does. The behaviour is not narrowed to match the label.
      */}
      <LimitRow
        label="Orchestrator spawn limit"
        hint="How many cards one card may have reporting to it, when that card has not set a team size of its own. Named for the orchestrator because that is the card that does the spawning on this board, but it holds any parent that set no figure of its own."
        value={limits.childrenPerCard}
        counted={null}
        unit="per parent card, at any one moment"
        locked={locked}
        onCommit={(n) => commit({ childrenPerCard: n })}
      />
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
