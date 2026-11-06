/**
 * Reading the token counter the CLI already prints.
 *
 * The owner has been tracking this by eye for months: the spinner carries a running figure for
 * the turn, the agent tree carries one per agent, and it accumulates across a session. Garden
 * holds the same bytes those lines are drawn from, so it can read them instead of asking him to.
 *
 * A note on what this evidence is worth. Everywhere else, Garden refuses to read rendered output
 * and only trusts what the CLI publishes in a file. This is the one place that rule bends, and
 * deliberately: the transcript is the structured source and it is written well after a turn ends,
 * so waiting for it means a gauge that is blank exactly while the session is burning through its
 * window. What is parsed here is not prose being interpreted, it is a number the CLI printed on
 * purpose. It is still marked `terminal` rather than `transcript` so the card can say which it
 * is, and the transcript figure always wins when one exists.
 *
 * Formats seen on this machine, all confirmed against a live session:
 *   ✢ Drizzling… (4m 22s · ↓ 9.9k tokens)
 *   ◯ archivist  You are working in C:\Garden...   3m 45s · ↓ 72.0k tokens
 *   ✶ Flummoxing… · 1s · ↓4 tokens
 */

/** Everything a terminal frame told us about token spend. */
export interface TokenReading {
  /** The figure on the current turn's spinner, if one is showing. */
  turn: number | null
  /** Per named agent, from the agent tree, keyed by the name in the row. */
  agents: Map<string, number>
}

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*\u0007|\u001b[()][B0]|\u001b[=>]/g

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, '')
}

/** "9.9k" is 9900, "1.2M" is 1200000, a bare "4" is 4. */
function scale(value: string, suffix: string | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (!suffix) return Math.round(n)
  const s = suffix.toLowerCase()
  if (s === 'k') return Math.round(n * 1_000)
  if (s === 'm') return Math.round(n * 1_000_000)
  return Math.round(n)
}

const TOKENS = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/g
/*
 * An agent row is a status glyph, a name, its prompt, then the elapsed time and the count. The
 * name is matched as a single word because that is what the tree prints, and the row is anchored
 * on the glyph so an ordinary sentence containing the word "tokens" cannot be mistaken for one.
 */
const AGENT_ROW = /[◯◉●○✻✽✶✢][ 	]+([A-Za-z][\w-]{1,40})[ 	]+.{0,240}?(\d+(?:\.\d+)?)[ 	]*([kKmM])?[ 	]*tokens/

export function readTokens(rawBuffer: string): TokenReading {
  // Only the tail matters: these figures are redrawn constantly and the last frame is the truth.
  const text = stripAnsi(rawBuffer.length > 24_000 ? rawBuffer.slice(-24_000) : rawBuffer)

  /*
   * Line by line, because a row is a line.
   *
   * Matching across the whole buffer let a glyph on one row pair up with a count on the next, so
   * the tree's own "main" heading, which carries no figure at all, took the number belonging to
   * the agent underneath it. Whitespace classes that include a newline are what made that
   * possible, and a per-line pass removes the whole class of mistake.
   */
  const agents = new Map<string, number>()
  for (const line of text.split('\n')) {
    const m = AGENT_ROW.exec(line)
    if (m) agents.set(m[1]!, scale(m[2]!, m[3]))
  }

  let turn: number | null = null
  for (const m of text.matchAll(TOKENS)) {
    turn = scale(m[1]!, m[2])
  }

  return { turn, agents }
}

/**
 * A session's running total, kept across turns.
 *
 * The number on the spinner is the current turn's, and it resets when the next turn starts. What
 * the owner watches is the accumulation, so each turn's peak is banked when the counter drops and
 * the live figure is added on top of the banked total. That is an arithmetic he can check against
 * his own screen: banked turns plus what the spinner says right now.
 *
 * Deliberately forgiving about restarts. A session that is turned off and on begins a new tally
 * rather than carrying a stale one, because the context window it is filling is genuinely new.
 */
export class TokenTally {
  private banked = 0
  private peak = 0

  /** Feed the latest reading. Returns the running total, or null if nothing has been seen yet. */
  observe(turn: number | null): number | null {
    if (turn === null) return this.banked > 0 ? this.banked : null
    // A drop means a new turn started, so whatever the last one reached is now history.
    if (turn < this.peak) {
      this.banked += this.peak
      this.peak = turn
    } else {
      this.peak = turn
    }
    const total = this.banked + this.peak
    return total > 0 ? total : null
  }

  reset() {
    this.banked = 0
    this.peak = 0
  }

  get total(): number {
    return this.banked + this.peak
  }
}

/*
 * The window table lives in @garden/shared now, and is re-exported here so every existing importer
 * keeps working. It moved because the card draws a denominator too, and a table the card cannot
 * reach is a table the card will copy: that is how there came to be three of them.
 */
import { contextWindowFor } from '@garden/shared'
export { contextWindowFor }

/** How full that card's window is, or null when either the total or the window is unknown. */
export function fractionOf(total: number | null, model: string | null): number | null {
  if (total === null) return null
  const window = contextWindowFor(model)
  if (window === null) return null
  return Math.min(1, total / window)
}
