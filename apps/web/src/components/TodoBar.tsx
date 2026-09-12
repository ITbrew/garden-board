import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { TodoItem } from '../todo'

export type TodoBarData = {
  /** The whole list's progress on the To Do card, or one card's own above that card. */
  done: number
  total: number
  /** The open items, already narrowed to whoever this bar belongs to. */
  open: TodoItem[]
  width: number
  /** Ticking an item writes it back into TODO.md. */
  onToggle: (line: number) => void
  /**
   * Present on a card that has items and no loop yet. Pressing it makes an ordinary loop row, so it
   * appears in the rail's Loops section like any other and is stopped or deleted there.
   */
  onLoop?: () => void
  looping?: boolean
  /** The main bar sits on the To Do card and carries no items of its own. */
  main?: boolean
}

/**
 * The to-do bar, drawn above a card rather than inside it.
 *
 * The owner asked for this placement in the same breath as the feature: "make the task bar outside
 * above the card instead of in the text section. similar to how context bar exists but horizontally
 * above for to-do list." So it is in the same family as the context web's column headers: derived
 * from where the card is, never draggable, never wireable, not a card.
 *
 * Everything it draws comes from `TODO.md`, and ticking a chip writes back to that same file. It is
 * a control on the main list rather than a display of a second one, which is what keeps a card's
 * list and the project's from ever disagreeing. Canon 26.
 */
export const TodoBar = memo(function TodoBar({ data }: NodeProps) {
  const d = data as TodoBarData
  const pct = d.total === 0 ? 0 : Math.round((d.done / d.total) * 100)
  const all = d.total > 0 && d.done === d.total

  return (
    <div className={`todobar ${d.main ? 'todobar--main' : ''}`} style={{ width: d.width }}>
      {/*
        The progress track, which is the whole point of the bar on the To Do card and a summary on
        a card's own. It is drawn even at zero, because a bar that appears only once something is
        done cannot be told apart from a list nobody has started.
      */}
      <div className="todobar__track" title={`${d.done} of ${d.total} done`}>
        <div className={`todobar__fill ${all ? 'is-all' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {/*
        The fraction is done out of total, and the chips beside it are what is LEFT. A blind reader
        given only this bar could not reconcile the two: "the strip above Worker one shows 1/2 but
        only one task tag is visible, not two." The word is what closes that, and it costs four
        characters on a bar the width of a card.
      */}
      <span className="todobar__count">
        {d.done}/{d.total}
      </span>
      <span className="todobar__word">done</span>
      {/*
        One item, not four, and the rest as a number.
        
        Four fitted only as stumps. Two blind readers were shown this bar and between them could not
        read a single label in full: "Replace the h...", "Write can...", "Sweep t...", "Deci...". A
        bar is the width of a card, and a card is 340 pixels, so four chips means four ellipses and a
        row that says nothing. One item with room to be read, plus how many are behind it, is the
        same information in a form that survives the width.
      */}
      {d.open.slice(0, 1).map((item) => (
        <button
          key={item.line}
          className="todobar__item nodrag"
          title={`${item.text}\n\nClick to tick this off in TODO.md`}
          onClick={(e) => {
            e.stopPropagation()
            d.onToggle(item.line)
          }}
        >
          {item.text}
        </button>
      ))}
      {/*
        What is left, said as a number rather than as "+3 more".
        
        Three blind readers in a row did the same sum and could not make it work: "1/5 done ... shows
        one visible item plus '+3 more,' which only totals 4, not 5." They were counting chips
        against a total, and the chips are the OPEN items, so the missing one is always the done one.
        "4 left" beside "1/5 done" adds up in the reader's head without anybody explaining the rule.
      */}
      {d.open.length > 0 && <span className="todobar__more">{d.open.length} left</span>}
      {all && <span className="todobar__done">all done</span>}
      {d.onLoop && (
        <button
          className="todobar__loop nodrag"
          title="Give this card a loop pointed at its own items. It reads the list now, then every 15 minutes, and switches itself off when nothing of its is left."
          onClick={(e) => {
            e.stopPropagation()
            d.onLoop?.()
          }}
        >
          Loop
        </button>
      )}
      {d.looping && (
        <span className="todobar__looping" title="This card has a loop on its list. The rail's Loops section is where it stops.">
          looping
        </span>
      )}
    </div>
  )
})
