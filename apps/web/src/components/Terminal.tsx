import { useEffect, useRef } from 'react'
import { acquire, mount } from '../terminal-pool'
import { actions } from '../state'

/**
 * Mounts a pooled terminal into this pane. The instance is not created or destroyed here, so
 * opening and closing a pane is instant and never loses the buffer.
 *
 * Always rendered at 1:1, outside the canvas transform. xterm computes mouse-to-cell from raw
 * client coordinates and is not scale-aware, so a CSS-scaled terminal selects the wrong text.
 */
export function Terminal({ sessionId, live }: { sessionId: string; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  /*
   * `live` is read by the fitting effect but is deliberately not a dependency of it.
   *
   * It flips on every session start and stop, and it used to tear the whole effect down and build it
   * again: detach the host, re-acquire, re-fit, and tell the process a size it already had. A resize
   * is not free even now that ConPTY has stopped duplicating screens over it, because the CLI still
   * repaints its entire screen for one. A ref keeps the current value available to the callbacks
   * without the effect caring that it changed.
   */
  const liveRef = useRef(live)
  liveRef.current = live

  // The parts that genuinely do depend on `live`, applied to the pooled instance in place.
  useEffect(() => {
    const entry = acquire(sessionId)
    entry.term.options.disableStdin = !live
    entry.term.options.cursorBlink = live
    if (live) requestAnimationFrame(() => entry.term.focus())
  }, [sessionId, live])

  useEffect(() => {
    const container = ref.current
    if (!container) return

    const entry = acquire(sessionId)
    // While this is showing, the pool may not dispose it to make room for another. Without this a
    // ninth pane silently killed one of the eight already on screen.
    const release = mount(entry)
    container.appendChild(entry.host)

    /**
     * Fit to the pane, and report the size only if the pane is really a pane yet.
     *
     * This runs once at mount, before the browser has laid the container out, and a fit against a
     * box with no height answers with the whole viewport: opening a pane told the process its screen
     * was 106x34 and then, once the snapshot came back and it fitted again, 106x13. The pane holds
     * 13. The first figure was never measured, it was guessed off an unlaid-out box, and Garden sent
     * it to the process as a fact about its screen.
     *
     * The ResizeObserver below fires as soon as there is a box to measure, so nothing is lost by
     * staying quiet: the guess is dropped and the measurement speaks.
     */
    const doFit = () => {
      try {
        entry.fit.fit()
        if (liveRef.current && container.clientHeight > 0 && container.clientWidth > 0) {
          actions.resize(sessionId, entry.term.cols, entry.term.rows)
        }
      } catch {
        // Not laid out yet.
      }
    }
    doFit()

    // Clicking anywhere in the pane, including the padding around the terminal, focuses it.
    const focusOnClick = () => entry.term.focus()
    container.addEventListener('mousedown', focusOnClick)

    const ro = new ResizeObserver(doFit)
    ro.observe(container)

    return () => {
      ro.disconnect()
      release()
      container.removeEventListener('mousedown', focusOnClick)
      // Detach the host, keep the instance alive in the pool.
      if (entry.host.parentElement === container) container.removeChild(entry.host)
    }
  }, [sessionId])

  return <div className="term-host" ref={ref} />
}
