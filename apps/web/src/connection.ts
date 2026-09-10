import { DEFAULT_PORT, WS_PATH, type ClientMessage, type ServerMessage } from '@garden/shared'

type Listener = (msg: ServerMessage) => void

/**
 * Which server this page belongs to.
 *
 * When the page came from the Garden server itself, it is that server's: following the address bar
 * is what lets a second copy run beside the one the owner is using, with its own board, without
 * either page reaching across to the other. Only the Vite dev server, which serves the app from a
 * port of its own and has no board behind it, needs the fixed fallback.
 */
function serverHost(): string {
  // Vite sets this, and only Vite, so it is the one reliable way to know the page did not come
  // from the server it needs to talk to.
  if (import.meta.env.DEV) return `127.0.0.1:${DEFAULT_PORT}`
  const { hostname, port } = window.location
  return port ? `${hostname}:${port}` : `127.0.0.1:${DEFAULT_PORT}`
}

/**
 * Where the owner's key is kept, and why it is kept in the browser at all.
 *
 * The server writes it once to `~/.garden/owner.key` and hands it to the browser through the URL it
 * prints at start; the page keeps it so a reload does not become a guest. In `localStorage` rather
 * than on the server for the plain reason that the server is what it authenticates to, and per
 * browser rather than per board because it is the owner's key and not a property of any one
 * project.
 *
 * Canon is honest about what this does and does not buy, and so is this comment: every card runs as
 * the same Windows user as the owner, so a card that goes looking can read the key off disk. What
 * the key stops is a connection being the owner by omission, which is what was happening before.
 */
const OWNER_KEY = 'garden.ownerKey'

/** The stored key, or null. Storage can throw outright in a locked-down browser, hence the catch. */
export function ownerKey(): string | null {
  try {
    const raw = localStorage.getItem(OWNER_KEY)
    return raw && raw.trim() ? raw.trim() : null
  } catch {
    // A browser with site data blocked. The page still works, as a guest, which is the honest state.
    return null
  }
}

/**
 * Keep a key, or forget one, and start a fresh handshake either way.
 *
 * The reconnect is the whole point: identity is decided in `hello` and nowhere else, so a key
 * pasted into a live socket changes nothing until that socket is replaced. Doing it here rather
 * than leaving it to the caller means there is no way to store a key and forget to use it.
 */
export function setOwnerKey(key: string | null) {
  storeKey(key)
  conn.reconnect()
}

/** The write half of `setOwnerKey`, without the reconnect, for the one caller that runs before it. */
function storeKey(key: string | null) {
  try {
    if (key && key.trim()) localStorage.setItem(OWNER_KEY, key.trim())
    else localStorage.removeItem(OWNER_KEY)
  } catch {
    // Storage blocked. The key is still sent on this connection, so the session works and the next
    // reload is a guest again. Nothing here can honestly promise otherwise.
  }
}

/**
 * Take the owner's key out of the address the launcher opened, and take it out of the address bar.
 *
 * The server prints `http://localhost:<port>/#key=<key>` at start and the launcher opens it. A
 * fragment is the right carrier for a secret in a URL: browsers never send it to the server, so it
 * is in no request line and no access log. The page reads it once, keeps it where a reload and a
 * reconnect will find it, and then rewrites the address without it, so the key is not in the bar,
 * in a bookmark, or in a screenshot of the board.
 *
 * This is what replaces the field in the Ceiling panel. The owner could not say what that field was
 * for, which is fair: it asked him to fetch a secret from a file and paste it in, to get back the
 * only role he ever has on his own machine. Called before the first `hello`, because identity is
 * decided there and nowhere else.
 *
 * Returns whether a key was taken, and never the key itself, so no caller can log it by accident.
 */
export function adoptKeyFromUrl(): boolean {
  try {
    const hash = window.location.hash
    if (!hash || hash.length < 2) return false
    const value = new URLSearchParams(hash.slice(1)).get('key')
    if (!value || !value.trim()) return false
    storeKey(value)
    // `replaceState` rather than assigning `location.hash`, which would leave a "#" behind and add
    // an entry the back button would walk into.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    return true
  } catch {
    // A browser that refuses history rewriting still gets the key; it just keeps it in the bar.
    return false
  }
}

/**
 * One socket for the whole app. Terminal bytes are high-volume, so listeners are plain
 * callbacks rather than React state: only the components that own a session's bytes subscribe
 * to them, and the canvas never re-renders because a terminal printed a line.
 */
/**
 * How long the socket may say nothing before it is assumed dead.
 *
 * The client sends a `pulse` every tick and the server answers immediately, so on a live socket
 * something arrives every few seconds no matter how quiet the board is. Silence past this window
 * means the answers are not coming back, not that nothing is happening. Three missed round trips
 * before acting, because a busy machine can lose one.
 */
const WATCHDOG_TICK_MS = 5_000
const SILENCE_LIMIT_MS = 20_000
/** How long a handshake may hang before the attempt is abandoned and a fresh one made. */
const CONNECT_LIMIT_MS = 8_000

class Connection {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private queue: ClientMessage[] = []
  private retry = 0
  private lastHeard = 0
  /** When the watchdog last ran, so a throttled timer can be told from a silent socket. */
  private lastTick = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  connected = false

  /**
   * Notice a socket that died without saying so.
   *
   * `onclose` was the only thing that triggered a reconnect, and a half-open TCP connection never
   * fires it: the machine sleeps, or the server dies without a clean close, and both ends go on
   * reporting `OPEN` forever. `send` then succeeds into nothing and no message ever comes back. From
   * the owner's side every card and every terminal stops at the same instant, permanently, while the
   * page still looks connected. That is the whole-app freeze.
   *
   * A ping from the server is answered by the browser's own stack, below JavaScript, so it is not
   * visible here. So the page sends its own `pulse`, which the server answers as an ordinary
   * message, and watches the clock: on a live socket something comes back every few seconds however
   * quiet the board is, and silence past the limit means the answers are not arriving.
   */
  private startWatchdog() {
    if (this.watchdog) return
    this.lastTick = Date.now()

    /*
     * A hidden window is not a dead server, and the first version of this could not tell them apart.
     *
     * Chrome throttles timers in a window that is minimised or behind another one, down to about
     * once a minute. So the pulse stops going out, nothing comes back, and the next time the timer
     * does fire the clock shows a minute of silence against a twenty second limit. This closed a
     * perfectly healthy socket and put "Not connected to the Garden server" on screen, and on a quiet
     * board it did it again on every wake-up, because the only traffic was the pulse it had stopped
     * sending. The owner reported exactly that, on a server that was up and answering the whole time.
     *
     * Two guards, and both are needed. A gap between ticks much longer than the interval means the
     * timer was throttled rather than the socket being silent, so the clock is reset instead of being
     * believed. And nothing is judged at all while the page is hidden, because a backgrounded window
     * cannot expect answers it never asked for.
     */
    this.watchdog = setInterval(() => {
      const now = Date.now()
      const throttled = now - this.lastTick > WATCHDOG_TICK_MS * 3
      this.lastTick = now
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (throttled || document.hidden) {
        this.lastHeard = now
        return
      }
      if (now - this.lastHeard >= SILENCE_LIMIT_MS) return this.giveUp()
      this.ws.send(JSON.stringify({ t: 'pulse' } satisfies ClientMessage))
    }, WATCHDOG_TICK_MS)

    // Coming back to the window starts the clock again rather than settling an argument about how
    // long it was away.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      this.lastHeard = Date.now()
      this.lastTick = Date.now()
    })
  }

  /**
   * Abandon a socket that has stopped answering, and start again.
   *
   * Calling `close()` and waiting for `onclose` is not enough here, and the reason is the whole
   * point of the case: closing a WebSocket sends a close frame and waits for the peer to send one
   * back, and the peer is exactly what has stopped talking. The browser sits on that handshake for
   * a long time, so the page stayed silently frozen for as long again as it had already been frozen.
   * Measured with a black-holed connection, the banner did not appear within thirty seconds.
   *
   * So the handlers are detached first and the verdict is announced immediately. `close()` is still
   * called, to release the socket whenever the browser gets round to it, but nothing waits for it.
   */
  private giveUp() {
    const dead = this.ws
    this.ws = null
    if (dead) {
      dead.onopen = null
      dead.onmessage = null
      dead.onclose = null
      dead.onerror = null
      try {
        dead.close()
      } catch {
        // Already unusable, which is the situation this is for.
      }
    }
    this.connected = false
    this.emit({ t: 'error', message: '__disconnected__' })
    const delay = Math.min(4000, 400 * 2 ** this.retry++)
    setTimeout(() => this.connect(), delay)
  }

  connect() {
    // StrictMode mounts effects twice in development. Two sockets would mean every broadcast
    // arrives twice, so this is deliberately idempotent.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    const url = `ws://${serverHost()}${WS_PATH}`
    const ws = new WebSocket(url)
    this.ws = ws

    /*
     * A connection attempt that never finishes is its own dead end.
     *
     * `connect` refuses to build a second socket while one is CONNECTING, which is right for
     * StrictMode's double mount and wrong for a handshake going nowhere: opening a socket into a
     * black hole leaves it CONNECTING forever, and with it sitting there nothing ever retried. The
     * board stayed offline after the network came back, which is worse than the freeze it replaced,
     * because that one at least ended when the owner reloaded the page.
     */
    const opening = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) this.giveUp()
    }, CONNECT_LIMIT_MS)

    ws.onopen = () => {
      clearTimeout(opening)
      this.connected = true
      this.retry = 0
      this.lastHeard = Date.now()
      this.startWatchdog()
      this.emit({ t: 'error', message: '__connected__' })
      /*
       * The key travels on the handshake and only on the handshake, which is where the server
       * decides who this connection is.
       *
       * Built as a named variable rather than written inline, because `ClientMessage`'s `hello` has
       * no `key` field yet: the file that defines it belongs to another card this week. A fresh
       * object literal with an extra property is rejected by TypeScript's excess-property check and
       * a variable of a wider shape is not, which is the same trick `actions.createDoc` in
       * `state.ts` uses for `x`/`y` and for the same reason. Once `hello` grows the field this needs
       * no change; until then the key is simply not read yet rather than refused.
       *
       * Sent only when there is one. A `hello` with `key: null` and a `hello` with no key are the
       * same request, and sending the field empty invites a server to tell the difference.
       */
      const key = ownerKey()
      const hello: { t: 'hello'; key?: string } = key ? { t: 'hello', key } : { t: 'hello' }
      this.send(hello)
      for (const m of this.queue.splice(0)) this.send(m)
    }

    ws.onmessage = (ev) => {
      this.lastHeard = Date.now()
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.emit(msg)
    }

    ws.onclose = () => {
      clearTimeout(opening)
      // A close that arrives after the watchdog already gave up on this socket has nothing to say:
      // the reconnect it would start is already scheduled, and starting a second one would double
      // the number of sockets each time round.
      if (this.ws !== ws) return
      this.ws = null
      this.connected = false
      this.emit({ t: 'error', message: '__disconnected__' })
      const delay = Math.min(4000, 400 * 2 ** this.retry++)
      setTimeout(() => this.connect(), delay)
    }

    ws.onerror = () => ws.close()
  }

  /**
   * Throw this socket away and hand-shake again, now.
   *
   * Deliberate, unlike `giveUp`, and that difference is why it is a separate method rather than a
   * call to that one. `giveUp` is the watchdog deciding a socket died and it backs off before
   * retrying, which is right when the server may be down and wrong here: the owner has just pasted
   * a key and is waiting to see whether it worked, and a four second pause before the attempt reads
   * as the field having done nothing.
   *
   * The handlers come off before the close for the same reason they do in `giveUp`: closing sends a
   * frame and waits for one back, and nothing may depend on that arriving.
   */
  reconnect() {
    const old = this.ws
    this.ws = null
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      try {
        old.close()
      } catch {
        // Already unusable, which does not stop the new one being made.
      }
    }
    this.connected = false
    this.emit({ t: 'error', message: '__disconnected__' })
    // The backoff is about a server that may be down, and this is not that. Starting from zero
    // means the next genuine failure still gets the full ladder.
    this.retry = 0
    this.connect()
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      this.queue.push(msg)
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(msg: ServerMessage) {
    for (const fn of this.listeners) fn(msg)
  }
}

export const conn = new Connection()
