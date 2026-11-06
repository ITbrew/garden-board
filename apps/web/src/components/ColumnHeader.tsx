import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

export type ColumnHeaderData = {
  label: string
  count: number
  /** How often files in this column are actually in play. */
  usage: 'always' | 'mixed'
  /**
   * Present only on a column that has not been opened yet, and clicking it opens that column.
   *
   * The bottom dot used to put every file on the board at once, which on a real card is well over a
   * hundred of them and, in the owner's words, "makes it too laggy the way it is right now". So the
   * dot unfolds these instead and the files come one column at a time. A header derived from cards
   * that are already open has nothing to offer and stays exactly what it was: a label.
   */
  onOpen?: () => void
  /**
   * Present on a column whose files are open, and pressing it folds that column back to its pill.
   *
   * Opening a column and having no way to shut it again is half a control, which is what the owner
   * found: "i cant collapse them after they are opened". The dot still folds everything away.
   */
  onClose?: () => void
  /**
   * Draw at the full width of a column rather than sized to the label.
   *
   * The pills are a table's header row, and a header row of blocks each sized to its own text reads
   * as a scattering rather than as columns. "all roots pills should be same size."
   */
  wide?: boolean
}

/**
 * A floating label above a column of the context web.
 *
 * Not a card: it cannot be dragged, selected or wired, because it describes the column rather
 * than being part of it. It is derived from where the cards actually are, so it stays with them.
 */
export const ColumnHeader = memo(function ColumnHeader({ data }: NodeProps) {
  const { label, count, usage, onOpen, onClose, wide } = data as ColumnHeaderData
  if (onClose) {
    return (
      <button
        className={`colhead colhead--pick is-open nodrag nopan ${wide ? 'colhead--wide' : ''} ${usage === 'always' ? 'is-always' : ''}`}
        title={`Fold these ${count} back into the column`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <span className="colhead-label">{label}</span>
        <span className="colhead-count">{count}</span>
        <span className="colhead-fold" aria-hidden="true">▲</span>
      </button>
    )
  }
  if (!onOpen) {
    return (
      <div className={`colhead ${usage === 'always' ? 'is-always' : ''}`}>
        <span className="colhead-label">{label}</span>
        <span className="colhead-count">{count}</span>
      </div>
    )
  }
  return (
    <>
      {/*
        The wire has to land somewhere, and a blind reviewer shown these without one could not tell
        which card they belonged to: "If a second card existed on this board, I would not be able to
        tell which card this row belongs to." Invisible, because the pill is the thing being looked
        at and a visible dot on it would read as somewhere to drag a connection from, which it is not.
      */}
      <Handle type="target" position={Position.Top} id="owner" style={{ opacity: 0 }} isConnectable={false} />
      <button
        className={`colhead colhead--pick nodrag nopan ${wide ? 'colhead--wide' : ''} ${usage === 'always' ? 'is-always' : ''}`}
        title={
          usage === 'always'
            ? `Open these ${count} ${count === 1 ? 'file' : 'files'}. This column is in play every session.`
            : `Open these ${count} ${count === 1 ? 'file' : 'files'}. This column is only used when something invokes it.`
        }
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <span className="colhead-label">{label}</span>
        <span className="colhead-count">{count}</span>
      </button>
    </>
  )
})
