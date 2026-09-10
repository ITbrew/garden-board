import type { AgentEvent, TerminalSession } from '@garden/shared'
import { refusalFacts, type RefusalFacts } from '../task-types'

/**
 * One refusal, in sentences, wherever the board draws one.
 *
 * This lived in the Tasks panel until the owner asked that panel to go: he could not read a
 * board-wide list of task rows and said so ("a giant unstructured meaningless list of data ill never
 * read"). What survives the panel is this, because it is contextual rather than a ledger: a card
 * that has been refused, or would have been, carries a pill above it that opens the refusals against
 * that card and nothing else. The file is named for what it holds now, so nothing imports a panel
 * that no longer exists in order to draw a pill.
 *
 * Nothing here reads the board's state. Everything it needs arrives as props, so the pill can draw
 * from the events the canvas already holds.
 */

/**
 * What to call each of the three refusal types.
 *
 * The difference between "refused" and "would refuse" is the whole of canon's rollout, so it is a
 * function rather than a literal at each call site. `SenderUnverified` is not about a task at all:
 * it is a body claiming to be a card the token does not match, which is why it is named for what it
 * is rather than folded in with the other two.
 */
export function REFUSAL_LABEL(type: string): string {
  if (type === 'TaskWouldRefuse') return 'would refuse'
  if (type === 'TaskRefused') return 'refused'
  if (type === 'SenderUnverified') return 'unverified sender'
  return type
}

/** How many of each kind a list of refusals holds, counted once for the pill's own labels. */
export function refusalCounts(events: AgentEvent[]): { refused: number; would: number; unverified: number } {
  let refused = 0
  let would = 0
  let unverified = 0
  for (const e of events) {
    if (e.type === 'TaskRefused') refused += 1
    else if (e.type === 'TaskWouldRefuse') would += 1
    else if (e.type === 'SenderUnverified') unverified += 1
  }
  return { refused, would, unverified }
}

/**
 * Which door the thing came through, in words.
 *
 * The payload carries a bare `kind`: `write` for the territory check, `hello` for the socket
 * handshake, `task` for an operation on the record, and the mail kind for everything else. Printed
 * raw it was "· on write" and "· on work", which a blind reader could not read at all. Printed as a
 * phrase it is also the thing that tells two otherwise identical records apart: an unverified sender
 * on a piece of work mail and an unverified sender on a write are two true records of two different
 * events, and two readers took them for the software contradicting itself.
 */
export function refusalDoor(kind: string | null): string | null {
  if (!kind) return null
  if (kind === 'write') return 'a write to a file'
  if (kind === 'hello') return 'a connection saying hello to the server'
  if (kind === 'task') return 'a change to the task record itself'
  return `a piece of ${kind} mail`
}

/** What went ahead anyway, for a refusal that was recorded and not enforced. */
function wentAhead(kind: string | null): string {
  if (kind === 'write') return 'the write happened'
  if (kind === 'hello') return 'the connection was allowed'
  if (kind === 'task') return 'the change was made'
  return kind ? 'the message was delivered' : 'it went ahead'
}

/**
 * A card's title from its id, and a real phrase when there is no id.
 *
 * The id rather than "unknown" for a card the board is not drawing: a card that has been deleted
 * still did the thing, and printing its id keeps that traceable instead of erasing it.
 */
function titleFor(sessions: TerminalSession[], id: string, absent: string): string {
  const card = sessions.find((s) => s.id === id)
  return card ? card.title : (id || absent)
}

function when(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * One sentence saying what the record is about: the door, who it was aimed at, and the rule.
 *
 * `to` is the recipient on a piece of mail and the card a body claimed to be under `from-mismatch`,
 * which are opposite meanings for the same field, so it is read by the rule rather than printed the
 * same way twice.
 */
export function refusalWhat(type: string, facts: RefusalFacts, sessions: TerminalSession[]): string {
  const door = refusalDoor(facts.kind)
  const named = facts.to ? titleFor(sessions, facts.to, 'a card this board does not know') : null
  const target = !named ? '' : facts.rule === 'from-mismatch' ? `, which said it came from ${named}` : `, sent to ${named}`
  const what = door
    ? `${door}${target}`
    : `something the server recorded without naming the door it came through${target}`
  const verb =
    type === 'SenderUnverified'
      ? 'The rule that caught it is'
      : type === 'TaskRefused'
        ? 'The rule it broke is'
        : 'The rule it would have broken is'
  return `This was ${what}. ${verb} ${facts.rule ?? 'not named on the record'}.`
}

/**
 * The body of one refusal: what it was, why, and whether anything was actually stopped.
 *
 * Read through `refusalFacts`, because `AgentEvent.payload` is `unknown` for the whole board and
 * this is one of many kinds recorded against a card. A field that did not arrive is drawn as unknown
 * rather than as blank: a refusal that carried no rule is a different thing from one whose rule is
 * an empty string, and only the first is worth chasing.
 */
export function RefusalBody({
  event,
  sessions,
  withTask = false,
}: {
  event: AgentEvent
  sessions: TerminalSession[]
  withTask?: boolean
}) {
  const facts = refusalFacts(event)
  return (
    <>
      <div>
        <span className={`task-refusal-type task-refusal-type--${event.type}`}>{REFUSAL_LABEL(event.type)}</span>{' '}
        <span className="task-reason">{facts.rule ?? 'rule not named'}</span>
      </div>
      <div className="task-why">{refusalWhat(event.type, facts, sessions)}</div>
      <div className="task-why">{facts.reason ?? 'no reason recorded'}</div>
      {/*
        Which setting it was evaluated under, on the entry rather than in a panel the reader may
        never have opened, and there is no such panel any more. `TaskWouldRefuse` is only ever
        written at `shadow`, so this is a fact about the record and not a reading of the board as it
        is now, which may since have moved.
      */}
      {event.type === 'TaskWouldRefuse' && (
        <div className="task-armed">
          The board was at shadow when this was checked, which checks every rule and stops nothing, so{' '}
          {wentAhead(facts.kind)} anyway.
        </div>
      )}
      <div className="task-meta">
        {withTask && facts.taskId ? `${facts.taskId} · ` : ''}
        {when(event.ts)}
      </div>
    </>
  )
}
