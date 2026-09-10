import { memo, type CSSProperties } from 'react'
import type { NodeProps } from '@xyflow/react'
import { actions } from '../state'

export type WebFrameData = {
  ownerId: string
  /** Which of the two webs this frame is drawn around, so the right one folds away. */
  web: 'context' | 'history'
  title: string
  count: number
  width: number
  height: number
}

/**
 * One border around an open web, rather than a scatter of loose cards.
 *
 * The two are named for where they sit and what they are: History above, holding what this card
 * did, and Roots below, holding everything it works from. Roots because they sit underneath and
 * because they are what the card grows out of: its instructions, its settings, the guards it runs
 * under, the skills and agents available to it, and its own accumulated notes.
 *
 * A session's files arrive as a block of twenty or more cards, and without a boundary they read
 * as twenty things that happen to be near each other rather than one thing belonging to one card.
 * The frame says where the group starts and stops, names it, counts it, and gives it a single
 * control that folds the whole lot away.
 *
 * It is drawn, not stored. The frame is derived from wherever the cards in that web actually are,
 * so dragging a file out of the block widens the border to follow it instead of leaving a lie on
 * screen. Nothing about the frame is persisted and nothing depends on it existing.
 */
export const WebFrame = memo(function WebFrame({ data }: NodeProps) {
  const { ownerId, web, title, count, width, height } = data as WebFrameData
  const close = () => (web === 'history' ? actions.closeHistoryWeb(ownerId) : actions.closeContextWeb(ownerId))

  return (
    <div className={`webframe webframe--${web}`} style={{ width, height } as CSSProperties}>
      <div className="webframe__head">
        <button
          className="webframe__fold nodrag"
          title={`Fold ${title.toLowerCase()} away`}
          onClick={close}
        >
          ▾
        </button>
        <span className="webframe__title">{title}</span>
        <span className="webframe__count">{count}</span>
      </div>
    </div>
  )
})
