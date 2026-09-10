/**
 * Typing into a subagent card, and having it reach that subagent.
 *
 * A spawned agent has no process of its own: it runs inside the session that hired it, and its
 * input and output are multiplexed through that session's terminal. The CLI offers no way to
 * address one by id from a command line, so the only route is the one a person uses, which is the
 * agent list at the bottom of the parent's screen.
 *
 * That is a keyboard dance, and doing it blind is dangerous rather than merely unreliable. Text
 * typed at the parent's ordinary prompt while agents are running does not reach an existing agent,
 * it DISPATCHES A NEW ONE. So a navigation that is off by one does not fail quietly, it spends the
 * owner's money starting an agent nobody asked for while his message disappears.
 *
 * Garden can do it anyway because it owns the parent's PTY and can therefore read the screen, which
 * is the part the CLI assumes a human is doing with their eyes. Every move is made and then
 * confirmed by reading again. If a confirmation fails, this stops, puts the terminal back, and says
 * why. It never types on the strength of where it believes the selection ought to be.
 */

/** The parts of the pty manager this needs, kept narrow so it can be tested without one. */
export interface PtyAccess {
  isLive(sessionId: string): boolean
  write(sessionId: string, data: string): void
  scrollback(sessionId: string): { data: string; seq: number }
}

export type ReachResult = { ok: true } | { ok: false; reason: string }

const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const DOWN = ESC + '[B'
const UP = ESC + '[A'
const LEFT = ESC + '[D'
const ENTER = CR

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until the card has stopped printing.
 *
 * The byte counter is cumulative, so it going unchanged for a stretch is proof the CLI has finished
 * whatever it was drawing rather than a guess that enough time has passed. Returns whether it went
 * quiet at all, so a caller can tell a settled screen from one that simply ran out of patience.
 */
async function quiet(ptys: PtyAccess, id: string, stillMs: number, capMs: number): Promise<boolean> {
  const until = Date.now() + capMs
  let last = ptys.scrollback(id).seq
  let changed = Date.now()
  while (Date.now() < until) {
    await sleep(Math.min(120, stillMs))
    const now = ptys.scrollback(id).seq
    if (now !== last) {
      last = now
      changed = Date.now()
    } else if (Date.now() - changed >= stillMs) return true
  }
  return false
}

/**
 * Enough of a terminal to know what is on the bottom of the screen.
 *
 * The CLI repaints by addressing the cursor, so the byte stream is not the screen and stripping the
 * escapes out of it gives the order things were written rather than where they ended up. The list
 * this needs to read is rewritten in place every second by the elapsed-time column, so reading the
 * stream instead of the screen would see every past state of it at once.
 *
 * Only what that repainting actually uses: absolute cursor moves, forward moves, erase to end of
 * line, erase screen, carriage return and newline. Anything else is consumed and ignored, which is
 * right for colour and cursor visibility and harmless for the rest, since none of it moves text.
 */
export function renderScreen(stream: string, cols = 200, rows = 60): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0
  let c = 0
  let i = 0

  const clampRow = () => {
    if (r < 0) r = 0
    if (r >= rows) {
      // Scroll, so a session that has printed more than a screenful still ends up with its last
      // lines at the bottom where the list lives.
      const shed = r - rows + 1
      grid.splice(0, shed)
      for (let k = 0; k < shed; k++) grid.push(Array(cols).fill(' '))
      r = rows - 1
    }
  }

  while (i < stream.length) {
    const ch = stream[i]!
    if (ch === ESC) {
      const next = stream[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < stream.length && !/[A-Za-z]/.test(stream[j]!)) j++
        const final = stream[j]
        const params = stream.slice(i + 2, j).split(';')
        const n = (k: number, d: number) => {
          const v = Number(params[k])
          return Number.isFinite(v) && params[k] !== '' ? v : d
        }
        if (final === 'H' || final === 'f') {
          r = n(0, 1) - 1
          c = n(1, 1) - 1
        } else if (final === 'C') {
          c += n(0, 1)
        } else if (final === 'D') {
          c -= n(0, 1)
        } else if (final === 'K') {
          const mode = n(0, 0)
          if (mode === 0) for (let k = c; k < cols; k++) grid[r]![k] = ' '
          if (mode === 1) for (let k = 0; k <= c && k < cols; k++) grid[r]![k] = ' '
          if (mode === 2) for (let k = 0; k < cols; k++) grid[r]![k] = ' '
        } else if (final === 'J') {
          const mode = n(0, 0)
          if (mode === 2 || mode === 3) {
            for (const row of grid) row.fill(' ')
            r = 0
            c = 0
          }
        }
        i = j + 1
        clampRow()
        if (c < 0) c = 0
        continue
      }
      if (next === ']') {
        // An operating system command, used here for the window title. Runs to a bell or ST.
        let j = i + 2
        while (j < stream.length && stream[j] !== '' && !(stream[j] === ESC && stream[j + 1] === '\\')) j++
        i = stream[j] === ESC ? j + 2 : j + 1
        continue
      }
      i += 2
      continue
    }
    if (ch === '\r') {
      c = 0
      i++
      continue
    }
    if (ch === '\n') {
      r++
      clampRow()
      i++
      continue
    }
    if (ch === '\b') {
      c = Math.max(0, c - 1)
      i++
      continue
    }
    if (ch < ' ') {
      i++
      continue
    }
    if (c >= cols) {
      c = 0
      r++
      clampRow()
    }
    grid[r]![c] = ch
    c++
    i++
  }

  return grid.map((row) => row.join('').replace(/\s+$/, ''))
}

/** A row of the agent list as it appears on screen. */
interface ListRow {
  /** Which line of the screen it is on, so a move can be checked against the same line. */
  line: number
  selected: boolean
  /** True for the "main" row, which is the session itself rather than an agent. */
  isMain: boolean
  /** The agent type, for example general-purpose. Empty for main. */
  type: string
  /** What the agent was asked to do, as the list shows it. */
  description: string
  /** How long the row says it has been running, in seconds, or null when it shows no clock. */
  elapsedSec: number | null
  raw: string
}

/** "9s", "1m 4s", "2h 3m" as the list writes them, in seconds. */
function parseElapsed(tail: string): number | null {
  const m = /(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/.exec(tail.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * The agent list, read off the bottom of the screen.
 *
 * It is always drawn while background agents exist; the down arrow does not open it, it starts
 * selecting on a list that is already there. A row is `  ● main` or `  ◯ <type>  <description>
 * <elapsed> · ↓ <tokens>`, and the selected one carries a chevron in the first column. The chevron
 * is the only marker worth reading: the rows also change colour, but `main` does not, so colour
 * cannot answer this for every row.
 */
export function readAgentList(screen: string[]): ListRow[] {
  const rows: ListRow[] = []
  for (let line = 0; line < screen.length; line++) {
    const raw = screen[line]!
    const m = /^([❯>]?)\s*([●◯○])\s+(\S+)(?:\s\s+(.*))?$/u.exec(raw)
    if (!m) continue
    const label = (m[3] ?? '').trim()
    const rest = (m[4] ?? '').trim()
    /*
     * Told apart by the glyph, not the word.
     *
     * The CLI marks the session itself with a filled dot and each agent with a hollow one. Reading
     * the label instead looked equivalent and is not: the row is repainted in place and the word
     * "main" is shorter than what was there before, so against real captured bytes it came back as
     * "mainral-purpose" with the tail of a previous line still behind it. The glyph is written
     * fresh every time and cannot pick up somebody else's leftovers.
     */
    const isMain = m[2] === '●'
    rows.push({
      line,
      selected: m[1] === '❯' || m[1] === '>',
      isMain,
      type: isMain ? '' : label,
      // The elapsed and token columns trail the description and change every second, so they are
      // cut off it rather than compared as text. The clock itself is kept, because when two rows
      // are otherwise identical it is the only thing on screen that tells them apart.
      description: rest.replace(/\s{2,}\d[\dhms\s]*·.*$/u, '').replace(/\s{2,}\d[\dhms\s]*$/u, '').trim(),
      elapsedSec: parseElapsed((/\s{2,}(\d[\dhms\s]*?)\s*(?:·|$)/u.exec(rest)?.[1] ?? '')),
      raw,
    })
  }
  /*
   * Only a contiguous run at the very bottom counts. Anything higher up matching this shape is the
   * transcript of the conversation, not the live list, and acting on a line scrolled off into
   * history would be exactly the mistake this function exists to avoid.
   */
  if (rows.length === 0) return rows
  const tail: ListRow[] = [rows[rows.length - 1]!]
  for (let k = rows.length - 2; k >= 0; k--) {
    if (rows[k]!.line === tail[0]!.line - 1) tail.unshift(rows[k]!)
    else break
  }
  return tail
}

/**
 * Send one line to a running subagent through the terminal of the card that hired it.
 *
 * Returns a reason rather than throwing, because every failure here is something the card has to
 * say out loud: the agent has finished, the list cannot be read, two agents look identical. A card
 * that quietly did nothing would be worse than one that says it could not.
 */
export async function reachAgent(args: {
  ptys: PtyAccess
  parentId: string
  agentType: string
  description: string | null
  text: string
  /**
   * When Garden created this agent's card, used only to tell two otherwise identical rows apart by
   * the clock each one shows. Absent means no such tie can be broken, and a tie then refuses.
   */
  startedAt?: number
  /** How long to let the screen settle after each keypress. */
  settleMs?: number
}): Promise<ReachResult> {
  const { ptys, parentId, agentType, text } = args
  const settle = args.settleMs ?? 350
  if (!text.trim()) return { ok: false, reason: 'there was nothing to send' }
  if (!ptys.isLive(parentId)) {
    return { ok: false, reason: 'the card that hired this agent is not running, so there is no terminal to reach it through' }
  }

  const screen = () => renderScreen(ptys.scrollback(parentId).data)
  const wanted = (r: ListRow) =>
    !r.isMain &&
    r.type === agentType &&
    (!args.description || r.description === args.description.trim())

  let list = readAgentList(screen())
  if (list.length === 0) {
    return { ok: false, reason: 'no agent list is on that card\'s screen, so nothing is running to reach' }
  }
  const matches = list.filter(wanted)
  if (matches.length === 0) {
    return { ok: false, reason: `no running agent on that card matches "${agentType}", so it has probably finished` }
  }
  let chosen = matches[0]!
  if (matches.length > 1) {
    /*
     * Two rows of the same type and description are identical as text, and the list carries no id.
     * The one thing that does separate them is the clock each row shows, and Garden knows when it
     * created each card, so the two can be lined up.
     *
     * Only when the answer is not close. If the best match is within a few seconds of the expected
     * age and the next best is well clear of it, that is a real identification. If two agents were
     * started at about the same moment, which is exactly what happens when one prompt spawns
     * several, nothing on screen can tell them apart and this refuses rather than picking. Sending
     * the owner's message to the wrong agent would be worse than not sending it.
     */
    const expected = args.startedAt ? (Date.now() - args.startedAt) / 1000 : null
    const scored = matches
      .map((r) => ({ r, gap: expected !== null && r.elapsedSec !== null ? Math.abs(r.elapsedSec - expected) : Infinity }))
      .sort((a, b) => a.gap - b.gap)
    const best = scored[0]!
    const runnerUp = scored[1]!
    if (best.gap <= 20 && runnerUp.gap - best.gap >= 15) {
      chosen = best.r
    } else {
      return {
        ok: false,
        reason: `${matches.length} running agents look identical on that card's screen ("${agentType}"), the list shows no id, and they started too close together to tell apart by how long they have been running, so Garden will not guess which one you meant`,
      }
    }
  }
  /*
   * The target is held as its text, never as the line it was on.
   *
   * The list is drawn at the bottom of a transcript that is still growing, so its screen rows slide
   * upward every time the parent prints anything. An earlier version remembered the line number and
   * compared against it after each press, and on a card that was mid-turn it read a selection that
   * had genuinely moved as one that had not moved at all, because the whole list had shifted by one
   * row underneath it. Position in the list is stable; position on the screen is not.
   */
  const same = (a: ListRow, b: ListRow) => a.isMain === b.isMain && a.type === b.type && a.description === b.description
  const target = chosen

  let lastIndex = -1
  let stalled = 0
  for (let step = 0; step < 24; step++) {
    // Read a settled screen. Reading one mid-repaint is how a half-drawn list gets acted on.
    await quiet(ptys, parentId, 250, 4000)
    list = readAgentList(screen())
    if (list.length === 0) {
      return { ok: false, reason: 'the agent list left the screen while Garden was moving through it, so nothing was sent' }
    }
    const want = list.findIndex((r) => same(r, target))
    if (want < 0) {
      return { ok: false, reason: `"${agentType}" is no longer in that card's list, so it has finished; nothing was sent` }
    }
    const here = list.findIndex((r) => r.selected)

    /*
     * Nothing is selected yet, so the list is showing but not being driven. The first press starts
     * the selection rather than moving it, which is why it is not counted as a move.
     */
    if (here < 0) {
      if (step > 2) return { ok: false, reason: 'that card did not respond to the key that opens its agent list' }
      ptys.write(parentId, DOWN)
      continue
    }
    if (here === want) break

    if (here === lastIndex) {
      if (++stalled >= 2) {
        return { ok: false, reason: 'the selection did not move when Garden pressed an arrow, so nothing was sent' }
      }
    } else stalled = 0
    lastIndex = here
    ptys.write(parentId, here < want ? DOWN : UP)
  }

  await quiet(ptys, parentId, 250, 4000)
  list = readAgentList(screen())
  const finally_ = list.find((r) => r.selected)
  if (!finally_ || !same(finally_, target) || !wanted(finally_)) {
    return {
      ok: false,
      reason: `Garden could not confirm the right agent was selected, so it sent nothing (it is on ${JSON.stringify(finally_?.raw ?? 'nothing')})`,
    }
  }

  /*
   * Attach, and check it happened before typing a single character.
   *
   * This is the moment the whole function exists to protect. Typing while still on the list, or
   * back at the ordinary prompt, does not reach this agent: it goes to the parent's own composer,
   * and the parent's model then reads the owner's words as an instruction to itself. Measured on
   * 2026-08-12, that failure is invisible from downstream evidence. A message typed at the parent
   * ended up in the subagent's transcript anyway, because the parent decided to relay it with
   * SendMessage. The words arrived; nothing about the delivery was Garden's doing, and a check that
   * only looked for the text downstream would have called that a pass.
   *
   * What the attach actually prints is the confirmation, and it is a good one because it names the
   * agent back: a header reading "Viewing @<name> · esc to return" and a composer whose placeholder
   * is "Message @<name>…". Either of those naming THIS agent is proof the next keystroke goes to
   * it. The first version of this check waited for the list to disappear instead, which is not what
   * happens: the list stays on screen underneath the attached view, so a correct attach was read as
   * a failure and the message was never sent.
   */
  ptys.write(parentId, ENTER)
  await sleep(settle * 2)
  /*
   * Wait for the panel to finish painting before anything is typed into it.
   *
   * A fixed sleep was not enough. The attach repaints most of the screen, and text written while
   * that is still streaming is dropped outright: measured on 2026-08-12, the panel opened
   * correctly, the message was written, and not one character of it was ever echoed back. Silence
   * on the byte stream is the only honest signal that the CLI has finished drawing and is waiting
   * on a keystroke, which is the same thing Garden already relies on before waking a card with its
   * mail.
   */
  await quiet(ptys, parentId, 400, 6000)
  const attached = screen().join('\n')
  /*
   * The panel names the agent back, which is the confirmation, but it does not always use the same
   * name the row does. Measured twice on 2026-08-12: once it opened as "Viewing @reachme · esc to
   * return", where reachme was the row's type column, and once as a bordered panel titled
   * "───── reachme ─", where reachme was the row's description column and the type was
   * general-purpose. So both of the row's own labels are accepted, and only in a position that
   * belongs to the panel: a Viewing or Message header, or a title sitting inside a border rule.
   * Matching the name loose anywhere on screen would match the transcript above it, which still
   * carries the words that dispatched the agent in the first place.
   */
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const labels = [agentType, matches[0]!.description.replace(/\.{2,}$/, '').trim()].filter((l) => l.length >= 3)
  const named = labels.length
    ? new RegExp(labels.map((l) => `(?:(?:Viewing|Message)\\s+@?${esc(l)})|(?:─\\s?${esc(l)}\\s?─)`).join('|'))
    : /$^/
  if (!named.test(attached)) {
    /*
     * Not attached, and this is where it stops. Escape is sent anyway in case a panel opened
     * without naming anything, so the terminal is not left somewhere the owner did not put it.
     */
    ptys.write(parentId, ESC)
    await sleep(settle)
    return { ok: false, reason: `that card did not open ${agentType}, so nothing was typed` }
  }

  // Text and Enter separately, or the CLI reads the burst as a paste and sends nothing.
  ptys.write(parentId, text)
  await sleep(60)
  /*
   * The text has to be on screen before the return is sent. If it is not, it went somewhere this
   * cannot see, and a return then submits whatever IS focused, which is the parent's own prompt.
   */
  await quiet(ptys, parentId, 400, 6000)
  if (!screen().join('\n').includes(text.slice(0, Math.min(text.length, 40)))) {
    ptys.write(parentId, ESC)
    await sleep(settle)
    return { ok: false, reason: 'the message did not appear on screen after being typed, so no return was sent' }
  }
  ptys.write(parentId, CR)
  await sleep(settle)

  // Back out to where the owner left it, so his terminal is not left inside an agent. The attached
  // view says "esc to return" in its own header, which is why this is escape and not a left arrow.
  ptys.write(parentId, ESC)
  await sleep(settle)

  return { ok: true }
}
