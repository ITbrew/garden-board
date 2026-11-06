/**
 * Reload the page by itself when a new build has been deployed underneath it.
 *
 * The server serves `apps/web/dist` as static files. Rebuilding it changes what a NEW tab loads and
 * does nothing at all to a tab that is already open: it keeps running the JavaScript it booted with
 * until somebody presses refresh. The owner, 2026-08-24: "i sit empty until i realize i have to
 * refresh". That is the whole problem, and it is worst exactly when a build is broken, because a
 * page that has failed is the one least likely to tell you it is out of date.
 *
 * Done from the CLIENT on purpose, with no server involvement.
 *
 * The obvious design is for the server to watch dist and push a message down the socket it already
 * holds. It is a better design in the abstract and it is the wrong one here: it would need a server
 * restart to take effect, and restarting Garden's server tears down every card's PTY. Paying for a
 * refresh convenience with every running agent on the board is a bad trade. This needs a rebuild
 * and nothing else, and a rebuild is already happening whenever this would matter.
 *
 * Vite content-hashes the entry bundle, so `index-CnEzrH6X.js` becoming `index-9fQ2xB1p.js` IS the
 * signal. `import.meta.url` tells the running page which one it is, and `/` says which one is
 * current. No version endpoint, no build stamp to keep in sync, and it cannot drift from the truth
 * because the filename is generated from the bundle's own contents.
 */

/** The bundle this page actually booted from, or null when served from source in dev. */
const SELF = (() => {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() ?? null
  } catch {
    return null
  }
})()

const CHECK_MS = 10_000
/**
 * How long a stale page is allowed to keep running while he is typing into it.
 *
 * Reloading out from under a keystroke loses whatever is in the composer, so a focused text field
 * defers the reload. But xterm keeps a hidden textarea focused for as long as a terminal has focus,
 * so "never reload while typing" would mean never reloading at all on the screen he spends his time
 * on. After this long the reload happens regardless, which is the lesser loss: a stale board is a
 * board showing him things that are not true any more.
 */
const FORCE_AFTER_MS = 60_000

const RELOAD_KEY = 'garden.reloadedForBuild'

let firstSeenStaleAt = 0
let reloading = false

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

/**
 * Never reload twice for the same target build.
 *
 * If the page comes back up and STILL does not match, the honest conclusion is that something else
 * is wrong (a half-written dist, a proxy serving a stale index) and reloading again would produce an
 * endless refresh loop, which is far worse than being out of date. Remembering the build we already
 * reloaded for turns that into one wasted reload rather than an unusable tab.
 */
function alreadyTried(remote: string): boolean {
  try {
    return sessionStorage.getItem(RELOAD_KEY) === remote
  } catch {
    return false
  }
}

function remember(remote: string): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, remote)
  } catch {
    // Private mode, or storage disabled. The reload still happens; only the loop guard is lost,
    // and the guard mattering at all already means something else is broken.
  }
}

async function check(): Promise<void> {
  if (reloading || !SELF) return
  if (document.visibilityState !== 'visible') return

  let html: string
  try {
    const res = await fetch('/', { cache: 'no-store' })
    if (!res.ok) return
    html = await res.text()
  } catch {
    // Server down or restarting. Not stale, just unreachable, and reloading into a dead server
    // would replace a working page with an error page.
    return
  }

  const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)
  if (!match) return // Dev server, or an index we do not recognise. Say nothing.

  const remote = match[1]
  if (remote === SELF) {
    firstSeenStaleAt = 0
    return
  }
  if (alreadyTried(remote)) return

  if (!firstSeenStaleAt) firstSeenStaleAt = Date.now()
  if (typing() && Date.now() - firstSeenStaleAt < FORCE_AFTER_MS) return

  reloading = true
  remember(remote)
  location.reload()
}

export function watchForNewBuild(): void {
  if (!SELF) return
  setInterval(() => void check(), CHECK_MS)
  // Coming back to the tab is the moment he is most likely to be looking at something stale.
  document.addEventListener('visibilitychange', () => void check())
  void check()
}
