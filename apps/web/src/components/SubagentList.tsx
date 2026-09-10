import { memo, useEffect, useRef, useState } from 'react'
import type { TerminalSession } from '@garden/shared'

/*
 * The Subagents / Tools list: a collapsible card pinned beside an agent card, holding everything
 * that card can call.
 *
 * Written as its own file so the wiring into SessionNode is a few lines rather than a rewrite, and
 * because the rules below are easier to keep true in one place than scattered through a node
 * component that is already doing a lot.
 *
 * The specification is docs/canonical/13-card-orientation.md. The parts that are not obvious from
 * looking at it:
 *
 *   - It is pinned, not merely nearby. It sits within 5-10px of the card's right edge and moves
 *     with the card, because a group that has to be re-found after a drag is not attached to
 *     anything.
 *   - It carries no wire. Both spawn points belong to the card itself. A wire means a channel a
 *     message may travel down, and the mail spine refuses a message between cards with no wire
 *     between them, so a wire drawn from this list would promise a connection that would then be
 *     refused.
 *   - Collapsed is the resting state, and a collapsed list must never look like a card with
 *     nothing in it. That is what the count is for.
 *   - A child waiting on a permission prompt shows through while collapsed. A needs-input card
 *     hidden inside a shut list is the exact silent state this project exists to prevent.
 *   - Collapsing hides and never removes. Nothing here deletes anything.
 */

/** What the list can hold. A tool is not a session, so it is described rather than passed whole. */
export interface ToolEntry {
  id: string
  title: string
  /** What kind of thing this is, shown as the dot's colour and read by the title attribute. */
  kind: 'tool'
  /** Free text: what it is wired to, e.g. "docs mcp". */
  detail?: string
}

export interface AgentEntry {
  id: string
  title: string
  kind: 'agent'
  status: TerminalSession['status']
  /** Set when the session is waiting on something, and the reason it is waiting. */
  waitingFor?: string | null
  roleClass?: string | null
  /**
   * The agent's own transcript, once the CLI has named one. Null means not yet, never a guess.
   *
   * This is the row's whole reason for existing now that a dispatched agent is not drawn on the
   * board. Every route to a throwaway's conversation used to start by finding its card and
   * clicking it; with the card off the canvas, this row is the only way in. A row that cannot
   * open what its agent said would be the clutter removed and the record removed with it.
   */
  transcriptPath?: string | null
}

export type ListEntry = AgentEntry | ToolEntry

export interface SubagentListProps {
  /** The card this list is pinned to. Only its id and title are used. */
  ownerId: string
  ownerTitle: string
  /** In dispatch order, oldest first. The list never sorts: order is meaning. */
  entries: ListEntry[]
  /** Open the card for an entry, the same as clicking the card itself. */
  onOpen?: (id: string) => void
  /** Open an agent's transcript. Offered per row, and only where there is a path to open. */
  onTranscript?: (id: string) => void
  /** Starts collapsed. Passed in so the board can remember the state per card if it wants to. */
  defaultOpen?: boolean
}

const WAITING = (e: ListEntry): boolean => e.kind === 'agent' && e.status === 'needs-input'
const LIVE = (e: ListEntry): boolean =>
  e.kind === 'agent' && (e.status === 'working' || e.status === 'idle' || e.status === 'needs-input')

/**
 * Two cycles of `alert-pulse` (styles.css), the same keyframe the card's own "needs you" banner
 * uses. Matched to that animation's own 1.6s rather than picked separately, so the class comes off
 * exactly as the second cycle finishes instead of cutting the glow short mid-animation.
 */
const DISPATCH_PULSE_MS = 3200

/**
 * The dot beside each row, coloured by what the entry is and what it is doing.
 *
 * An agent that has finished keeps its row rather than disappearing, because a card is durable and
 * the process behind it is not. It draws grey: still there, no longer live.
 */
function entryClass(e: ListEntry): string {
  if (e.kind === 'tool') return 'salist-dot salist-dot--tool'
  if (e.status === 'needs-input') return 'salist-dot salist-dot--waiting'
  if (e.status === 'working') return 'salist-dot salist-dot--working'
  if (e.status === 'idle') return 'salist-dot salist-dot--idle'
  return 'salist-dot salist-dot--done'
}

function entryTitle(e: ListEntry): string {
  if (e.kind === 'tool') return e.detail ? `${e.title} — ${e.detail}` : e.title
  if (e.status === 'needs-input') return `${e.title} is waiting${e.waitingFor ? `: ${e.waitingFor}` : ''}`
  return `${e.title} — ${e.status}`
}

export const SubagentList = memo(function SubagentList({
  ownerId,
  ownerTitle,
  entries,
  onOpen,
  onTranscript,
  defaultOpen = false,
}: SubagentListProps) {
  const [open, setOpen] = useState(defaultOpen)

  /*
   * A dispatch just fired, shown even while shut.
   *
   * The evidence is structural rather than guessed: an agent card is created on `SubagentStart`
   * and never on anything else, so an id in `entries` that was not there last time this list saw
   * `entries` is a dispatch that just happened, watched the same way `entries` itself is already
   * built (see the comment on `reachable` in SessionNode.tsx). `seenIds` starts at `null` rather
   * than an empty set specifically to tell those two cases apart: a card opened with three agents
   * already reporting to it was not just dispatched three agents, it was hired with them in place,
   * and the first render establishes that baseline without pulsing for it. Only entries that show
   * up after that baseline count.
   *
   * Restricted to `kind === 'agent'`: a tool being wired in is not a dispatch, and while nothing
   * populates a tool entry yet (see SessionNode.tsx), the check should still say what it means
   * rather than accidentally being right by omission.
   */
  const seenIds = useRef<Set<string> | null>(null)
  const [pulsing, setPulsing] = useState(false)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const ids = new Set(entries.map((e) => e.id))
    const prev = seenIds.current
    seenIds.current = ids
    if (prev === null) return
    const dispatched = entries.some((e) => e.kind === 'agent' && !prev.has(e.id))
    if (!dispatched) return
    setPulsing(true)
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    pulseTimer.current = setTimeout(() => setPulsing(false), DISPATCH_PULSE_MS)
  }, [entries])

  useEffect(
    () => () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
    },
    [],
  )

  /*
   * An empty list draws nothing at all.
   *
   * A card that has hired nobody and holds no tools should look like a card that has hired nobody.
   * An empty rectangle beside every card on the board would be the same clutter this replaces,
   * just tidier.
   */
  if (entries.length === 0) return null

  const waiting = entries.filter(WAITING).length
  const live = entries.filter(LIVE).length

  return (
    <div
      className={`salist nodrag ${open ? 'is-open' : 'is-shut'} ${waiting ? 'has-waiting' : ''} ${
        pulsing ? 'is-pulsing' : ''
      }`}
      data-owner={ownerId}
    >
      <button
        className="salist-head"
        onClick={() => setOpen((v) => !v)}
        title={
          waiting
            ? `${waiting} of these is waiting on you`
            : open
              ? `Fold away what ${ownerTitle} can call`
              : `What ${ownerTitle} can call: ${entries.length} of them`
        }
      >
        <span className={`salist-caret ${open ? 'is-open' : ''}`} aria-hidden="true">
          ▾
        </span>
        <span className="salist-title">Subagents / Tools</span>

        {/*
          The count is what stops a shut list reading as a card with nothing in it, so it is never
          hidden and never replaced by an icon alone.

          Waiting is shown separately and in its own colour, because "three of these are running"
          and "one of these is stopped waiting for you" are different facts and only one of them
          needs the owner now.
        */}
        {waiting > 0 && (
          <span className="salist-count salist-count--waiting" title={`${waiting} waiting on you`}>
            {waiting} waiting
          </span>
        )}
        <span className="salist-count" title={`${live} running of ${entries.length}`}>
          {entries.length}
        </span>
      </button>

      {open && (
        <ul className="salist-body">
          {entries.map((e) => {
            const transcript = e.kind === 'agent' ? e.transcriptPath : null
            return (
              <li key={e.id}>
                <button
                  className="salist-row"
                  onClick={() => onOpen?.(e.id)}
                  title={entryTitle(e)}
                  disabled={!onOpen}
                >
                  <span className={entryClass(e)} aria-hidden="true" />
                  <span className="salist-row-title">{e.title}</span>
                  {/*
                    Status, not role. Every dispatched agent is created with `roleClass: 'worker'`
                    hardcoded (`ingest.ts:450`), so this column printed the same word on every row
                    on every card and told the reader nothing. A blind reviewer read four rows and
                    reported "worker" four times without ever asking what it meant, which is what a
                    column carrying no information looks like from outside. Status varies, is the
                    thing actually worth knowing about a throwaway, and doubles as the legend for
                    the dot beside it, which the same reviewer could see changing colour and could
                    not interpret.
                  */}
                  <span className="salist-row-meta">{e.kind === 'tool' ? 'tool' : e.status}</span>
                </button>

                {/*
                  A sibling of the row rather than inside it: a button within a button is invalid
                  and the inner one stops receiving clicks in some browsers, which would have made
                  this look present and do nothing.

                  Drawn only where there is a path. An agent whose CLI has not named a transcript
                  yet gets no control at all, rather than a dead one that says nothing about why:
                  unknown drawn as unknown, per the project rule, instead of an affordance that
                  fails on click.
                */}
                {transcript && onTranscript ? (
                  <button
                    className="salist-row-transcript"
                    onClick={() => onTranscript(e.id)}
                    title={`Open what ${e.title} said: ${transcript}`}
                    aria-label={`Open transcript for ${e.title}`}
                  >
                    transcript
                  </button>
                ) : (
                  e.kind === 'agent' && (
                    /*
                      Said rather than left blank.
                      "Unknown is drawn as unknown" means drawing something that says so, and the
                      first version of this drew nothing at all on the reasoning that a control
                      which cannot work should not be offered. A blind reviewer shown four rows,
                      three with a button and one with a gap, reported that the odd one out gave no
                      idea why and simply looked inconsistent. It was right: an absence is not a
                      statement, and the reader cannot tell a deliberate omission from a bug.
                    */
                    <span
                      className="salist-row-notranscript"
                      title={`${e.title} has not been given a transcript path yet, so there is nothing to open`}
                    >
                      no transcript
                    </span>
                  )
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
