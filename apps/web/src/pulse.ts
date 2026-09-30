/**
 * The board's one heartbeat: an attribute on the root element flipped about once a second, which the
 * working ring and the "needs you" pill read to brighten and dim.
 *
 * Not a CSS animation, and that is the whole point. Measured on the owner's board on 23 September with
 * four working cards: any running CSS animation, whatever it animated and however it was stepped, kept
 * the page drawing 85 to 120 frames a second, and each frame re-ran layer assignment for a board of
 * about four thousand elements, 250 to 850 ms of main thread per second. With nothing animating the
 * page drew 4 to 11 frames a second. A class flip costs one style pass and one paint per beat instead.
 *
 * A hidden tab gets no beats at all: the browser throttles the timer and there is nothing to see.
 */
const BEAT_MS = 900

export function startPulse() {
  const root = document.documentElement
  setInterval(() => {
    if (document.hidden) return
    root.toggleAttribute('data-pulse')
  }, BEAT_MS)
}
