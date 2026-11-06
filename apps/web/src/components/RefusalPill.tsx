import { memo, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AgentEvent } from '@garden/shared'
import { useApp } from '../state'
import { RefusalBody, refusalCounts } from './RefusalBody'

export type RefusalPillData = {
  /** Newest first, already filtered to this card's refusals. */
  refusals: AgentEvent[]
}

/**
 * What this card tried to do that the ownership rules stopped, or would have stopped.
 *
 * It sits in the row of day pills above the card, because that row is the card's history and a
 * refusal is a thing that happened to this card at a time, which is what the rest of that row holds.
 * Nothing rendered `MailRefused` before this, so there was no existing style to match: this is the
 * same `colhead` shape the day pills use, so the row reads as one control rather than as two
 * designs, with its own colour because a refusal is not a day.
 *
 * The two types are counted together on the face and told apart inside, and that distinction is the
 * whole of canon's rollout: in `shadow` every rule is evaluated and every refusal recorded as
 * `TaskWouldRefuse` while the message is delivered exactly as before, so the owner can watch what
 * would have been stopped before anything is stopped. A pill that showed one number for both would
 * hide the difference between a board that is watching and a board that is refusing.
 */
export const RefusalPill = memo(function RefusalPill({ data }: NodeProps) {
  const { refusals } = data as RefusalPillData
  const [open, setOpen] = useState(false)
  // The cards on the board, so an entry can name the card a piece of mail was aimed at rather than
  // print its id. The store's own array, so this is a stable reference between updates.
  const sessions = useApp((s) => s.sessions)

  /*
   * A count under the label that names what it counts.
   *
   * The pill read `WOULD REFUSE 2` over one thing that would have been refused and one unverified
   * sender, which is a number that covers a kind its own label does not mention. Each kind gets its
   * own word and its own number, and a kind with nothing in it is not drawn at all.
   */
  const counts = refusalCounts(refusals)
  const segments = [
    { label: 'refused', n: counts.refused },
    { label: 'would refuse', n: counts.would },
    { label: 'unverified', n: counts.unverified },
  ].filter((s) => s.n > 0)
  const said = [
    counts.refused ? `${counts.refused} refused outright` : null,
    counts.would
      ? `${counts.would} that the board checked and let through, because it is at shadow rather than enforce`
      : null,
    counts.unverified ? `${counts.unverified} where Garden could not tell which card sent it` : null,
  ].filter(Boolean)

  return (
    <>
      {/*
        A landing point for a wire, invisible, and nothing draws one today.

        The roots pills below a card are wired back to it because a blind reviewer could not
        otherwise tell which card a floating row belonged to. The day pills above a card have never
        had that wire, and this sits in their row, so it does not get one either: adding it here
        alone would make this one pill look like it belongs to something the pills beside it do not.
        The handle exists so that whenever that row does get its wire, this is already able to
        receive it. Invisible because a visible dot on a pill reads as somewhere to drag from.
      */}
      <Handle type="target" position={Position.Top} id="owner" style={{ opacity: 0 }} isConnectable={false} />
      <button
        className={`colhead colhead--pick colhead--wide colhead--refusal nodrag nopan ${open ? 'is-open' : ''}`}
        title={`${said.join('; ')}. Open to read them.`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {segments.map((s) => (
          <span key={s.label} className="colhead-seg">
            <span className="colhead-label">{s.label}</span>
            <span className="colhead-count">{s.n}</span>
          </span>
        ))}
      </button>
      {open && (
        <div className="refusal-open nodrag nopan">
          {/*
            The refusals against this card, in sentences. This is the only place the board draws
            one now: the panel that listed them for the whole project has gone at the owner's
            request, and a refusal belongs to the card it happened to anyway.
          */}
          {refusals.map((r) => (
            <div key={r.id} className="refusal-open__row">
              <RefusalBody event={r} sessions={sessions} withTask />
            </div>
          ))}
        </div>
      )}
    </>
  )
})
