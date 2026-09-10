import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { actions, onSessionBytes } from './state'

/**
 * One xterm instance per session, living outside React.
 *
 * Building and disposing a terminal on every mount is wrong twice over: xterm queues internal
 * work that throws if the instance is disposed underneath it, and re-creating it would throw
 * away the rendered buffer every time a pane is closed and reopened. So instances are pooled
 * and only destroyed when the session itself goes away.
 *
 * Instances are capped, because each live terminal costs real memory and main-thread time.
 */
const MAX_INSTANCES = 8

export interface PooledTerminal {
  term: Xterm
  fit: FitAddon
  host: HTMLDivElement
  detach: () => void
  lastUsed: number
  /**
   * How many panes are showing this instance right now.
   *
   * Eviction used to consult `lastUsed` alone, and `lastUsed` was stamped only in `acquire`, which
   * runs once when a pane mounts. So a pane the owner had been watching for an hour looked like the
   * least recently used thing in the pool, and opening a ninth pane disposed its xterm, unsubscribed
   * it from the byte stream and pulled its host out of the DOM while it was still on screen. The
   * pane went silent for good, with no error and nothing saying why. That is the bug behind
   * "terminals stop updating text", and it is also exactly the kind of thing this project exists not
   * to do: the pane kept drawing a session it was no longer receiving.
   */
  mounted: number
}

const pool = new Map<string, PooledTerminal>()

function create(sessionId: string): PooledTerminal {
  const host = document.createElement('div')
  host.className = 'term-surface'

  const term = new Xterm({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#0b0d12',
      foreground: '#d5dae6',
      cursor: '#7c5cff',
      selectionBackground: '#2a3352',
      black: '#0b0d12',
      brightBlack: '#4a5268',
    },
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  /**
   * Shift+Tab is how a Claude session cycles its permission mode, and xterm sends the right
   * escape for it but does not call preventDefault. The browser therefore also did its own thing
   * with the key and moved focus to the next control in the dock, so the sequence arrived but
   * every keystroke after it went to a button instead of the terminal. That reads as "the
   * terminal stopped responding", which is exactly what it was.
   *
   * Returning true still lets xterm handle the key; only the browser's focus move is cancelled.
   */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Tab') e.preventDefault()
    return true
  })

  /**
   * How much of the byte stream this terminal has already drawn.
   *
   * A snapshot is not a one-time thing: the server answers `session.scrollback` for every open
   * socket, and the client asks again on reconnect and whenever the session list is refreshed.
   * Writing a second snapshot on top of the first appended the entire buffer to itself, which
   * duplicated the conversation and left the viewport parked in the middle of it.
   */
  let writtenSeq = -1
  const pending: Array<{ data: string; seq: number }> = []

  const offBytes = onSessionBytes(sessionId, (data, seq, isSnapshot, cols, rows) => {
    // Recency should mean "this session is doing something", not "this pane was opened recently".
    // `acquire` runs once per mount, so without this a busy terminal ages exactly as fast as an
    // abandoned one and the pool picks its victim by mount order.
    const self = pool.get(sessionId)
    if (self) self.lastUsed = Date.now()

    if (isSnapshot) {
      // Already exactly current, so the snapshot says nothing the live stream has not said.
      if (seq === writtenSeq) return
      // Behind (bytes were missed while the socket was down): rebuild rather than append.
      if (writtenSeq >= 0) term.reset()
      writtenSeq = seq

      /*
       * Be the grid these bytes were drawn against, replay them, then go back to the pane's size.
       *
       * In that order, and the order is the entire fix. `Terminal.tsx` fits this instance to its
       * pane the moment it mounts, and the snapshot arrives afterwards over the socket, so without
       * this the bytes were always replayed at the pane's width rather than the process's. When the
       * two happened to differ, every wrap landed in a different place and every "move up three
       * lines" overwrote something the CLI never meant to touch, which is the text-everywhere the
       * owner reported. Opening a terminal appeared to cure it because the resize that follows made
       * the CLI redraw the whole screen from scratch, which is a repair rather than an absence of
       * the fault: it only ever worked for a session with a live process still able to redraw.
       *
       * `pty-manager.ts` explains the same failure at its own end, where it decided the geometry
       * has to travel with the buffer. The card preview was given it. This path was not.
       *
       * Resizing back afterwards is safe in the way resizing before would not have been. xterm
       * reflows a buffer it has already parsed correctly, which is ordinary rewrapping; replaying
       * unparsed drawing instructions at the wrong width is not recoverable at all.
       */
      const restore = cols && rows && (term.cols !== cols || term.rows !== rows)
      if (restore) term.resize(cols, rows)

      term.write(data, () => {
        if (restore) {
          try {
            fit.fit()
            // The process is drawing for whatever it was last told, so tell it what it is now.
            actions.resize(sessionId, term.cols, term.rows)
          } catch {
            // Not laid out yet. The pane's own ResizeObserver fits it when it is.
          }
        }
        term.scrollToBottom()
      })
      for (const p of pending.splice(0)) {
        if (p.seq <= writtenSeq) continue
        writtenSeq = p.seq
        term.write(p.data)
      }
      return
    }
    if (writtenSeq < 0) {
      pending.push({ data, seq })
      return
    }
    if (seq <= writtenSeq) return
    writtenSeq = seq
    term.write(data)
  })

  const offInput = term.onData((d) => actions.input(sessionId, d))
  actions.requestScrollback(sessionId)

  const entry: PooledTerminal = {
    term,
    fit,
    host,
    lastUsed: Date.now(),
    mounted: 0,
    detach: () => {
      offBytes()
      offInput.dispose()
      term.dispose()
      host.remove()
    },
  }
  return entry
}

export function acquire(sessionId: string): PooledTerminal {
  let entry = pool.get(sessionId)
  if (!entry) {
    entry = create(sessionId)
    pool.set(sessionId, entry)
    evictIfNeeded(sessionId)
  }
  entry.lastUsed = Date.now()
  return entry
}

/** Called when a session is closed for good. */
export function destroy(sessionId: string) {
  const entry = pool.get(sessionId)
  if (!entry) return
  pool.delete(sessionId)
  entry.detach()
}

/**
 * Tell the pool a pane is showing this instance, and hand back the release.
 *
 * Mounting is the thing eviction has to know about, and it was the one thing the pool was never
 * told. Panes call this instead of touching `mounted` themselves so the increment and the matching
 * decrement cannot drift apart.
 */
export function mount(entry: PooledTerminal): () => void {
  entry.mounted++
  let released = false
  return () => {
    if (released) return
    released = true
    entry.mounted = Math.max(0, entry.mounted - 1)
    entry.lastUsed = Date.now()
  }
}

/**
 * Evict the least recently used terminal when over the cap. Only the rendering goes: the PTY
 * keeps running and its scrollback is re-fetched from the server on next use.
 *
 * A terminal currently on screen is never a candidate, whatever its age. The cap exists to bound
 * memory, and going one instance over it costs memory; disposing a pane the owner is reading costs
 * him the truth about what that session is doing, and he has no way to tell it happened. If every
 * instance is mounted, nothing is evicted and the pool runs over.
 */
function evictIfNeeded(keep: string) {
  if (pool.size <= MAX_INSTANCES) return
  const candidates = [...pool.entries()]
    .filter(([id, e]) => id !== keep && e.mounted === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  while (pool.size > MAX_INSTANCES && candidates.length) {
    const [id] = candidates.shift()!
    destroy(id)
  }
}

export function fitAll() {
  for (const entry of pool.values()) {
    try {
      entry.fit.fit()
    } catch {
      // Not laid out yet; the ResizeObserver will fit it when it is.
    }
  }
}
