import { useEffect, useRef, useState } from 'react'
import { getPreviewMouse, getPreviewWindow, onPreviewChange, type PreviewMouse } from '../preview'
import { actions } from '../state'

/**
 * Row height must match the CSS exactly or partial rows creep back in. The CSS derives it from
 * the card's own font size, which ctrl and the wheel change, so this reads the same value from
 * the element rather than assuming a constant.
 */
const DEFAULT_FONT = 11
const LINE_EXTRA = 4
const PAD_PX = 12

/**
 * How much wheel travel makes one report to the program, in pixels. A mouse notch is about 100 and
 * sends one, as the dock's terminal does; a trackpad's small steps add up to one here rather than
 * each sending its own and flinging the program's view.
 */
const WHEEL_STEP_PX = 16

/** Reporting modes that include the wheel. X10 reports presses only, so it never saw a wheel. */
const WHEEL_REPORTED = new Set<PreviewMouse['tracking']>(['vt200', 'drag', 'any'])

/**
 * One wheel report in the form the program asked for. Buttons 64 and 65 are wheel up and down, and
 * shift and alt add 4 and 8, as xterm sends them. Ctrl never arrives here: it sizes the card's text.
 */
function wheelReport(m: PreviewMouse, up: boolean, col: number, row: number, e: React.WheelEvent): string {
  const code = (up ? 64 : 65) + (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0)
  if (m.encoding === 'sgr') return `\x1b[<${code};${col};${row}M`
  return `\x1b[M${String.fromCharCode(32 + code, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`
}

let measure2d: CanvasRenderingContext2D | null = null

/** The width of one character in the grid's own font, before the board's zoom. */
function charWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  const size = parseFloat(cs.fontSize) || DEFAULT_FONT
  measure2d ??= document.createElement('canvas').getContext('2d')
  if (!measure2d) return size * 0.6
  measure2d.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  return measure2d.measureText('0000000000').width / 10 || size * 0.6
}

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
  live,
}: {
  sessionId: string
  /**
   * True when this card has run at least once, from its own `exitedAt`, so an empty pane can say
   * which of two very different things it means.
   */
  everRan?: boolean
  /**
   * True when a process is behind the card. Only then can the wheel go to the program: a card that
   * was stopped keeps the mouse modes its last run switched on in its saved bytes, and a report sent
   * to it would reach nothing.
   */
  live?: boolean
}) {
  const [, bump] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const wheelTravel = useRef(0)
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
   * The program scrolls, when it asked for the mouse. Then the card follows the live screen and the
   * wheel goes to the program (see `onWheel`), so the card's own scroll position and bar are set
   * aside rather than offered as a second, conflicting way to scroll the same pane.
   */
  const mouse = live ? getPreviewMouse(sessionId) : null
  const programScrolls = !!mouse && WHEEL_REPORTED.has(mouse.tracking) && mouse.encoding !== 'sgr-pixels'
  const held = programScrolls ? null : anchor

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
  const drawRows = held !== null ? Math.max(1, maxRows - 1) : maxRows
  const view = getPreviewWindow(sessionId, drawRows, held)
  const scrollable = !programScrolls && view.total > drawRows

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
    if (e.ctrlKey) return
    if (programScrolls && mouse) {
      sendWheel(e, mouse)
      return
    }
    if (!scrollable) return
    const step = e.deltaY < 0 ? -3 : 3
    const next = view.end + step
    setAnchor(next >= view.total - 1 ? null : Math.max(drawRows - 1, next))
  }

  /*
   * Hand one wheel step to the program, as a report naming the cell under the pointer.
   *
   * This is what the dock's terminal does, for a full-screen program that keeps its own history and
   * repaints when asked to move. A Claude card no longer comes here: it draws its conversation from
   * the transcript and scrolls that itself (`ClaudeTerminal`, canon 02 revision 13). The cell is worked out from the row the pointer is over, turned into the screen
   * row the program knows, and the column under it at the board's current zoom.
   */
  const sendWheel = (e: React.WheelEvent, m: PreviewMouse) => {
    const px = e.deltaMode === 1 ? e.deltaY * WHEEL_STEP_PX : e.deltaMode === 2 ? e.deltaY * m.rows * WHEEL_STEP_PX : e.deltaY
    if (px === 0) return
    // A change of direction starts the count again, so a reversal is never swallowed.
    if (Math.sign(px) !== Math.sign(wheelTravel.current)) wheelTravel.current = 0
    wheelTravel.current += px
    if (Math.abs(wheelTravel.current) < WHEEL_STEP_PX) return
    wheelTravel.current = 0
    if (anchor !== null) setAnchor(null)

    const grid = gridRef.current
    let rowIndex = view.rows.length - 1
    let col = 1
    if (grid) {
      const rowEls = grid.children
      for (let i = 0; i < rowEls.length; i++) {
        if (e.clientY < rowEls[i]!.getBoundingClientRect().bottom) {
          rowIndex = i
          break
        }
      }
      const box = grid.getBoundingClientRect()
      const zoom = grid.offsetWidth ? box.width / grid.offsetWidth : 1
      col = Math.floor((e.clientX - box.left) / (charWidth(grid) * zoom)) + 1
    }
    const row = view.start + Math.max(0, rowIndex) - m.screenTop + 1
    const clamp = (n: number, hi: number) => Math.max(1, Math.min(hi, n))
    actions.input(sessionId, wheelReport(m, px < 0, clamp(col, m.cols), clamp(row, m.rows), e))
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
      <div className="mini-grid" ref={gridRef}>
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
      {held !== null && (
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
