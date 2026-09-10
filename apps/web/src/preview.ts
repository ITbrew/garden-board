import { Terminal as HeadlessTerm } from '@xterm/headless'

/**
 * Per-session preview text for canvas nodes.
 *
 * The first version of this stripped ANSI escapes with a regex and appended the result. That is
 * wrong, and a blind reviewer caught it: PowerShell's line editor repositions the cursor and
 * erases as it redraws, so a naive strip-and-append produced duplicated, garbled command lines
 * like "Get-ChildItemGet-ChildItem | Select-Ob...". Interpreting a terminal stream correctly
 * means keeping a terminal, so each session gets a headless one. No DOM, no renderer, just the
 * buffer, which is what a preview needs.
 *
 * Updates are flushed on a timer so a chatty session cannot make the canvas re-render per chunk.
 */
/**
 * The grid this emulator interprets at, which is NOT the size the card is drawn at.
 *
 * Those two were confused, and it is the whole bug. This ran at 200 by 48 while the process behind
 * it was drawing for 120 by 30, on the reasonable-sounding idea that a wider buffer holds more for
 * the card to show. It does not work that way. A terminal stream is drawing instructions computed
 * for a specific grid, so a line the CLI wrapped at column 120 takes two rows in the real terminal
 * and one here, and the next instruction, "move up two rows and rewrite", then lands two rows off
 * and overwrites the wrong line. Repeat that through a turn and the card shows the right words in
 * the wrong order while the dock terminal, whose size matches, is perfectly correct. That is what
 * the owner was looking at.
 *
 * These are only the starting values, used until the server says otherwise. `session.scrollback`
 * carries the real geometry and `resizePreview` follows every resize after that, so a card whose
 * dock pane has been dragged wider keeps interpreting at the size its process was actually told.
 *
 * How much of that buffer a card DRAWS is a separate decision made in TerminalMini, which measures
 * its own box and takes the last however-many rows fit. So a card stays as small as it likes; it
 * simply becomes an accurate miniature instead of a scrambled one.
 */
const COLS = 120
const ROWS = 30
const FLUSH_MS = 250

interface Entry {
  term: HeadlessTerm
  lines: string[]
  dirty: boolean
  /** Cumulative byte count already written, so a snapshot and live data cannot double up. */
  seq: number
  /**
   * The last row with anything on it, or -1 when it needs finding again.
   *
   * Finding it means walking up from the end of the buffer turning rows into strings until one is
   * not blank, and that was being done on every render of every card. It only changes when bytes
   * arrive, and it gets steadily more expensive as a session prints, because the buffer grows from
   * thirty rows towards the two-hundred-and-thirty-row cap. So it is worked out at most once per
   * batch of new bytes and kept.
   */
  bottom: number
}

const entries = new Map<string, Entry>()

/**
 * Who wants to hear that a preview changed, keyed by the session they are drawing.
 *
 * This was one flat set, so every card on the board was woken four times a second by whichever
 * single session happened to be printing. Each of those wake-ups is not free: a card then re-reads
 * its buffer, walks backwards past the blank tail and turns every cell of every drawn row into
 * spans. On a board of forty cards with one busy agent, thirty-nine of those forty renders were
 * redrawing text that had not changed.
 */
const subs = new Map<string, Set<() => void>>()
let anyDirty = false

function notify(sessionId: string) {
  const set = subs.get(sessionId)
  if (!set) return
  for (const fn of set) fn()
}

function entryFor(sessionId: string): Entry {
  let e = entries.get(sessionId)
  if (!e) {
    e = {
      term: new HeadlessTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true }),
      lines: [],
      dirty: false,
      /*
       * Minus one, because zero is a real answer and this needs to mean "nothing yet".
       *
       * A card whose process is gone gets its scrollback from the file on disk, and the server
       * numbers that snapshot `seq: 0`, since no live process has emitted anything. This started at
       * 0 as well, so the very first snapshot after a restart matched the "already exactly current,
       * skip it" test and was thrown away. Every card came back blank and stayed blank until the
       * owner woke the session and made it print something, at which point the history he had been
       * looking for reappeared. The dock terminal never had this: it started its own counter at -1
       * and restored fine, which is why the miniature on the board and the pane below it disagreed
       * about whether anything had ever happened.
       */
      seq: -1,
      bottom: -1,
    }
    entries.set(sessionId, e)
  }
  return e
}

/**
 * Feed the session's byte stream into its preview terminal.
 *
 * A snapshot replaces everything, because it is the whole scrollback as of a point in time.
 * Live chunks are ignored if they are already inside that snapshot, using the same cumulative
 * byte count the dock terminals use. Without the snapshot path, cards were blank every time the
 * page loaded until the session happened to print something new.
 */
export function feedPreview(sessionId: string, data: string, seq: number, isSnapshot = false) {
  const e = entryFor(sessionId)
  if (isSnapshot) {
    // Already exactly current: a reconnect or a session-list refresh asks for scrollback again
    // on every session on the board, and doing a full reset-and-replay of this terminal for an
    // answer that changes nothing is pure waste, multiplied by however many cards are open. The
    // dock terminals already skip this in terminal-pool.ts; matching it here is what keeps the
    // two readers of the same byte stream doing the same thing with it.
    if (seq === e.seq) return
    e.term.reset()
    e.seq = seq
    e.term.write(data, () => {
      e.dirty = true
      e.bottom = -1
      anyDirty = true
    })
    return
  }
  if (seq <= e.seq) return
  e.seq = seq
  e.term.write(data, () => {
    e.dirty = true
    e.bottom = -1
    anyDirty = true
  })
}

export function dropPreview(sessionId: string) {
  const e = entries.get(sessionId)
  if (!e) return
  entries.delete(sessionId)
  e.term.dispose()
}

export function getPreviewLines(sessionId: string): string[] {
  return entries.get(sessionId)?.lines ?? []
}

// --- colour cells -----------------------------------------------------------

export interface Span {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
}

/**
 * The xterm 256-colour palette, built once. Cells report a palette index rather than a colour,
 * so a miniature that wants to look like the real terminal has to resolve it the same way.
 */
const PALETTE: string[] = (() => {
  const base = [
    '#0b0d12', '#f43f5e', '#2dd4bf', '#f59e0b',
    '#60a5fa', '#c084fc', '#22d3ee', '#d5dae6',
    '#4a5268', '#fb7185', '#5eead4', '#fcd34d',
    '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff',
  ]
  const out = [...base]
  const steps = [0, 95, 135, 175, 215, 255]
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        out.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`)
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    out.push(`rgb(${v},${v},${v})`)
  }
  return out
})()

function colour(mode: number, value: number): string | undefined {
  // 0 is "terminal default", which the card paints itself, so it stays undefined.
  if (mode === 0) return undefined
  if (mode === 1) return PALETTE[value] ?? undefined
  if (mode === 2) {
    return `rgb(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255})`
  }
  return undefined
}

/**
 * Which buffer lines are "on screen" right now, shared by both readers below so they can never
 * drift apart from each other the way they already had from the real terminal.
 *
 * This used to end at `baseY + cursorY`, the cursor's own row, on the theory that the cursor
 * marks where the live conversation currently is. It does not: a TUI routinely draws a line or
 * two below wherever its cursor sits, a hint bar, a context readout, the bottom border of a
 * composer box, and cropping at the cursor threw all of that away. The real terminal never did
 * this. `Terminal.tsx` calls `term.scrollToBottom()` on every write and xterm's own renderer
 * always shows a full screen's worth of rows ending at the bottom of what has been written,
 * cursor position or not, which is what made the miniature disagree with the terminal the owner
 * had to open to find out what a card actually said. `buffer.length - 1` is that same bottom
 * line: the last line the buffer has, whether or not the cursor is sitting on it.
 */
function visibleRange(term: HeadlessTerm): { start: number; end: number } {
  const end = term.buffer.active.length - 1
  // The terminal's own row count, not the constant it started at, since a resized session is no
  // longer the size it was created with and a screen's worth means whatever it means now.
  return { start: Math.max(0, end - (term.rows - 1)), end }
}

/**
 * Follow the real terminal's size, so this keeps interpreting the stream the way it was drawn.
 *
 * Called on the scrollback that arrives when a card attaches, and on every resize the dock sends
 * afterwards. Resizing is not free, xterm reflows its buffer, so this returns early when nothing
 * changed rather than reflowing on every keystroke-sized resize event.
 *
 * The emulator is BUILT here when there is not one yet, and that is the whole of a bug that survived
 * every other part of this being right. It used to return when it found no entry, and the entry is
 * only ever created by the first write, so the first scrollback a card ever receives went: no entry,
 * nothing to resize, return; then create one at 120 by 30 and replay a stream drawn at some other
 * size into it. Every card on the board did that on every page load, and the size arriving in the
 * same message was read and thrown away. Building it here costs nothing, because an emulator with
 * no bytes in it has nothing to reflow.
 */
export function resizePreview(sessionId: string, cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
  const e = entryFor(sessionId)
  if (e.term.cols === cols && e.term.rows === rows) return
  try {
    e.term.resize(cols, rows)
    e.dirty = true
    anyDirty = true
  } catch {
    // A resize that xterm refuses is not worth losing the preview over: the old size still renders,
    // it is simply the wrong one, which is where this started rather than a new failure.
  }
}

/**
 * Read the terminal's real screen as styled spans, so a card can be an actual miniature of the
 * terminal rather than grey text. Adjacent cells sharing a style are merged into one span, which
 * keeps the DOM small enough to render many cards at once.
 */
export function getPreviewSpans(sessionId: string): Span[][] {
  const e = entries.get(sessionId)
  if (!e) return []
  const { start, end } = visibleRange(e.term)
  const rows = spansFor(e.term, start, end)
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop()
  return rows
}

/**
 * Read a row range as styled spans. Split out of `getPreviewSpans` when the miniature learned to
 * scroll, so the live view and a scrolled-back view cannot disagree about what a row looks like.
 * Adjacent cells sharing a style are merged into one span, which keeps the DOM small enough to
 * render many cards at once.
 *
 * The blank-tail trim stays with the caller rather than living in here: the live view wants it, so
 * an idle session shows its prompt at the bottom of the pane, and a scrolled view must not have it,
 * because dropping rows would shift the text under the owner's eyes as he scrolls past a gap.
 */
function spansFor(term: HeadlessTerm, start: number, end: number): Span[][] {
  const buf = term.buffer.active
  const rows: Span[][] = []

  for (let i = start; i <= end; i++) {
    const line = buf.getLine(i)
    if (!line) {
      rows.push([])
      continue
    }
    const spans: Span[] = []
    let cur: Span | null = null
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      const chars = cell.getChars() || ' '
      const inverse = !!cell.isInverse()
      let fg = colour(cell.getFgColorMode(), cell.getFgColor())
      let bg = colour(cell.getBgColorMode(), cell.getBgColor())
      if (inverse) {
        const swap = fg
        fg = bg ?? '#0b0d12'
        bg = swap ?? '#c9d2e6'
      }
      const bold = !!cell.isBold()
      if (cur && cur.fg === fg && cur.bg === bg && cur.bold === bold) {
        cur.text += chars
      } else {
        cur = { text: chars, fg, bg, bold }
        spans.push(cur)
      }
    }
    // Trailing blanks with no styling add nothing but DOM.
    while (spans.length && spans[spans.length - 1]!.text.trim() === '' && !spans[spans.length - 1]!.bg) {
      spans.pop()
    }
    rows.push(spans)
  }

  return rows
}

/**
 * One window onto the session's buffer, so a card can scroll back through what its terminal said
 * without opening the dock.
 *
 * This reads the SAME headless terminal `getPreviewSpans` reads, deliberately. The obvious cheaper
 * route is to keep a text buffer of lines and slice it, and the comment at the top of this file
 * records what that cost the first time: a terminal stream is drawing instructions, not text, and
 * PowerShell's line editor repositions the cursor and erases as it redraws, so anything that treats
 * the stream as text produces duplicated, garbled lines. Scrolling changes which rows are read. It
 * does not change what a row is.
 *
 * `anchorEnd` is the absolute buffer index of the bottom row wanted, or null to follow the live
 * bottom. Absolute rather than an offset from the end, because an offset means the text under the
 * owner's eyes slides upward by one line for every line the session prints while he is reading it.
 * The anchor is clamped here rather than by the caller, since only this function knows how much
 * buffer there is, and xterm drops the oldest rows once the scrollback is full.
 *
 * `total` is the scrollable extent, ending at the last row with anything on it. Trailing blank rows
 * are excluded so a mostly-idle session does not report a page of empty scrollback to scroll
 * through, which is the same reason the live reader trims them.
 */
export interface PreviewWindow {
  rows: Span[][]
  /** Absolute index of the bottom row in `rows`, which is what to hand back as the next anchor. */
  end: number
  /** Absolute index of the top row in `rows`. */
  start: number
  /** How many rows exist to scroll through, blank tail excluded. */
  total: number
}

export function getPreviewWindow(
  sessionId: string,
  rowsWanted: number,
  anchorEnd: number | null = null,
): PreviewWindow {
  const e = entries.get(sessionId)
  const want = Math.max(1, Math.floor(rowsWanted))
  if (!e) return { rows: [], start: 0, end: 0, total: 0 }
  const buf = e.term.buffer.active

  // The last row with anything on it. A terminal's buffer is padded with blank rows below whatever
  // was drawn, and scrolling into that padding shows the owner nothing while looking like content.
  // Cached on the entry and invalidated when bytes arrive, because this is per-render work that
  // only ever changes per-write, and it grows with the buffer.
  let bottom = e.bottom
  if (bottom < 0) {
    bottom = buf.length - 1
    while (bottom > 0) {
      const line = buf.getLine(bottom)
      if (line && line.translateToString(true).trim() !== '') break
      bottom--
    }
    e.bottom = bottom
  }

  const end = anchorEnd === null ? bottom : Math.max(0, Math.min(Math.floor(anchorEnd), bottom))
  const start = Math.max(0, end - want + 1)
  return { rows: spansFor(e.term, start, end), start, end, total: bottom + 1 }
}

/** Hear about one session's preview, and only that one. */
export function onPreviewChange(sessionId: string, fn: () => void) {
  let set = subs.get(sessionId)
  if (!set) {
    set = new Set()
    subs.set(sessionId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) subs.delete(sessionId)
  }
}

function readLines(term: HeadlessTerm): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  // Read the whole viewport plus a little history, then trim trailing blanks so a mostly-idle
  // session shows its prompt at the bottom of the pane rather than floating in whitespace.
  const { start, end } = visibleRange(term)
  for (let i = start; i <= end; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  while (out.length && out[out.length - 1]!.trim() === '') out.pop()
  return out
}

setInterval(() => {
  if (!anyDirty) return
  anyDirty = false
  for (const [sessionId, e] of entries) {
    if (!e.dirty) continue
    e.dirty = false
    e.lines = readLines(e.term)
    // Only the cards drawing this session. A board of forty cards used to redraw all forty because
    // one of them printed a line.
    notify(sessionId)
  }
}, FLUSH_MS)
