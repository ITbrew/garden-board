import { useEffect, useRef, useState } from 'react'
import { getPreviewWindow, onPreviewChange } from '../preview'

/**
 * Row height must match the CSS exactly or partial rows creep back in. The CSS derives it from
 * the card's own font size, which ctrl and the wheel change, so this reads the same value from
 * the element rather than assuming a constant.
 */
const DEFAULT_FONT = 11
const LINE_EXTRA = 4
const PAD_PX = 12

/**
 * A real miniature of the terminal, drawn from the session's own screen buffer with its own
 * colours. Not an xterm instance: those are not scale-aware and cost roughly 34MB each, so a
 * board of twenty would be unusable. These are plain styled spans, which scale with the canvas
 * like any other card content and cost almost nothing.
 *
 * The pane clips rather than wraps. A terminal is 100+ columns wide and a small card is not, so
 * this shows a window onto the left of the terminal; widen the card to see more.
 *
 * It scrolls, and the scrolling reads further back into the same headless terminal rather than
 * into a text copy of it. See `getPreviewWindow`: treating the stream as text is what produced
 * duplicated, garbled lines the first time this pane existed.
 */
export function TerminalMini({
  sessionId,
  everRan,
}: {
  sessionId: string
  /**
   * True when this card has run at least once, from its own `exitedAt`, so an empty pane can say
   * which of two very different things it means.
   */
  everRan?: boolean
}) {
  const [, bump] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const [maxRows, setMaxRows] = useState(12)
  /**
   * Where the owner has scrolled to, as the absolute index of the bottom row he is looking at.
   * Null means he has not scrolled and the pane follows the live bottom, which is the resting
   * state and the one every card is in until he touches it.
   */
  const [anchor, setAnchor] = useState<number | null>(null)

  // This card's own session only. It used to be every card on the board waking for every card's
  // output, four times a second.
  useEffect(() => onPreviewChange(sessionId, () => bump((n) => n + 1)), [sessionId])

  // Show whole rows only. Letting the container clip wherever it lands sliced the top line
  // through the middle of its glyphs, which a blind reviewer read as a rendering bug rather
  // than as scrolled content.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const font =
        parseFloat(getComputedStyle(el).getPropertyValue('--card-font')) || DEFAULT_FONT
      const line = font + LINE_EXTRA
      const usable = el.clientHeight - PAD_PX
      setMaxRows(Math.max(1, Math.floor(usable / line)))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    // The card's font can change without its box changing, so re-measure on every flush too.
    const off = onPreviewChange(sessionId, measure)
    return () => {
      ro.disconnect()
      off()
    }
  }, [sessionId])

  /*
   * While scrolled back, one row is given up to the notice.
   *
   * It used to be drawn over the text, and a blind reviewer read the bottom line as "line 118 of
   * the scrol..." with the label sitting on top of the rest of it. Obscuring the output in order to
   * say something about the output is self-defeating, and worse here than in most places: the whole
   * claim this pane makes is that it shows what the terminal actually said.
   *
   * The pane's height does not change, so nothing on the board moves when he scrolls. He simply
   * sees one fewer line while a notice is up, which is the honest trade and is reversible by the
   * control the notice contains.
   */
  const drawRows = anchor !== null ? Math.max(1, maxRows - 1) : maxRows
  const view = getPreviewWindow(sessionId, drawRows, anchor)
  const scrollable = view.total > drawRows

  if (view.total === 0) {
    /*
     * Two different silences, and saying the same thing for both was a lie by omission.
     *
     * "no output yet" is true of a card that has never been started. Said over a card that ran for
     * an hour and was then stopped, it reads as though the session itself had been wiped, which is
     * exactly how the owner read it after a refresh. Nothing was erased: the card, its role, its
     * wires and its conversation are all still there, and the terminal buffer is the one part that
     * was never kept.
     *
     * This says which case it is and does not speculate about why. It deliberately does not claim
     * the history is recoverable or gone for good, because from here that is not knowable.
     */
    return (
      <div className="mini mini--empty nowheel" ref={ref}>
        {everRan ? 'no terminal history kept for this run' : 'no output yet'}
      </div>
    )
  }

  /*
   * Scroll by the wheel, and hand back to the live bottom when he reaches it.
   *
   * Three gestures already wanted this wheel and all three still work. Ctrl and the wheel sizes the
   * card's text, handled on the card in the capture phase, so it runs before this and this ignores
   * any event carrying ctrl. The canvas zooms on a plain wheel, and the `nowheel` class on this
   * pane is what stops it doing so here; that class predates scrolling and was already keeping the
   * board still while the pointer was over a card. Dragging the card is untouched, since a drag is
   * a pointer gesture and this is not.
   *
   * Reaching the bottom clears the anchor rather than pinning it to the last row, so the pane goes
   * back to following live output. Pinned at the bottom row, a card would sit one line behind
   * forever and look subtly stuck.
   */
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || !scrollable) return
    const step = e.deltaY < 0 ? -3 : 3
    const next = view.end + step
    setAnchor(next >= view.total - 1 ? null : Math.max(drawRows - 1, next))
  }

  /*
   * The thumb is draggable, because a scrollbar that can only be nudged by the wheel is half of
   * what was asked for. `nodrag` is what keeps that drag from also dragging the card: React Flow
   * reads that class to decide whether a pointer gesture belongs to the node.
   */
  const startThumbDrag = (e: React.PointerEvent) => {
    if (!scrollable) return
    e.stopPropagation()
    const track = (e.currentTarget as HTMLElement).parentElement
    if (!track) return
    const rect = track.getBoundingClientRect()
    const startY = e.clientY
    const startEnd = view.end
    const move = (ev: PointerEvent) => {
      // A pixel of travel is worth however many rows the track is standing in for.
      const rowsPerPx = view.total / Math.max(1, rect.height)
      const moved = Math.round((ev.clientY - startY) * rowsPerPx)
      const next = startEnd + moved
      setAnchor(next >= view.total - 1 ? null : Math.max(drawRows - 1, next))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Thumb geometry as plain fractions of the track: how much of the buffer is on screen, and how
  // far down the bottom of the view currently sits.
  const thumbHeight = Math.max(12, (drawRows / view.total) * 100)
  const thumbTop = ((view.end + 1 - drawRows) / view.total) * 100

  return (
    <div className="mini nowheel" ref={ref} onWheel={onWheel}>
      <div className="mini-grid">
        {view.rows.map((spans, i) => (
          <div key={i} className="mini-row">
            {spans.length === 0
              ? ' '
              : spans.map((s, j) => (
                  <span
                    key={j}
                    style={{
                      color: s.fg,
                      background: s.bg,
                      fontWeight: s.bold ? 600 : undefined,
                    }}
                  >
                    {s.text}
                  </span>
                ))}
          </div>
        ))}
      </div>
      {scrollable && (
        <div className="mini-scroll" aria-hidden>
          <div
            className="mini-scroll__thumb nodrag"
            style={{ height: `${thumbHeight}%`, top: `${Math.max(0, Math.min(100 - thumbHeight, thumbTop))}%` }}
            onPointerDown={startThumbDrag}
          />
        </div>
      )}
      {/*
        Say when the pane is not showing the live end, because a card frozen part-way up its own
        history looks exactly like a card whose session has stopped producing output. That confusion
        is the same class as the two silences above, and this pane has already been read wrongly
        once for want of a word.

        In the row given up above rather than over the text. A notice about the output that hides
        the output is worse than no notice.
      */}
      {anchor !== null && (
        <button
          className="mini-follow nodrag"
          title="Back to the live end of this session's output"
          onClick={(e) => {
            e.stopPropagation()
            setAnchor(null)
          }}
        >
          scrolled back, jump to live
        </button>
      )}
    </div>
  )
}
