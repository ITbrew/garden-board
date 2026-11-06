/**
 * The board's one heartbeat: an attribute on the root element flipped about once a second, which the
 * "needs you" pill reads to brighten and dim, and the step that moves every working card's ring.
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

/*
 * The ring's comet, stepped rather than animated (canon 02 revision 19). Twelve steps a second, a lap
 * in 2.4 seconds, so each step moves it 12.5 degrees: with a tail a quarter of the way round, that
 * reads as travelling rather than jumping. Each step sets one custom property on each ring element,
 * which has no children, so what is re-styled and re-painted is the rings and nothing else. When no
 * card is working the step finds nothing and does nothing.
 */
const RING_MS = 83
const LAP_MS = 2400

export function startPulse() {
  const root = document.documentElement
  setInterval(() => {
    if (document.hidden) return
    root.toggleAttribute('data-pulse')
  }, BEAT_MS)

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const rings = document.getElementsByClassName('node-ring')
  setInterval(() => {
    if (document.hidden || rings.length === 0 || still?.matches) return
    const angle = `${Math.round(((performance.now() % LAP_MS) / LAP_MS) * 360)}deg`
    for (let i = 0; i < rings.length; i++) (rings[i] as HTMLElement).style.setProperty('--ring-a', angle)
  }, RING_MS)
}
