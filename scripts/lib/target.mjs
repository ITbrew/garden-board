/**
 * Which Garden a test talks to, and why it is never the owner's by accident.
 *
 * Every one of these scripts used to open with `Number(process.env.GARDEN_PORT) || 5178`, so running
 * one with no environment set pointed it straight at the board the owner is working on. That is not
 * a hypothetical: it has now happened three times. Twice earlier, badly enough that the damage got
 * blamed on the app rather than on the script, and once again today, which added three scratch
 * projects and six cards to a live board mid-session and left two processes running.
 *
 * The default is inverted here. No port in the environment means the test gets a Garden of its own,
 * on its own port, with its own workspace and database, which is what a test should have had all
 * along. Reaching the owner's board now takes saying so out loud.
 *
 * One way to say so:
 *   GARDEN_LIVE=1      talk to the running app, on GARDEN_PORT if set and 5178 otherwise
 *
 * GARDEN_PORT on its own used to be a second way, and it is not any more: see the note inside
 * `target` for the card terminal that had it set without ever asking for it.
 *
 * Returns the same shape `startInstance` does, so a caller does not have to care which it got, and
 * `stop()` is safe to call either way: it tears down an instance this created and does nothing to
 * one it did not.
 */
import { startInstance } from './instance.mjs'

export async function target({ quiet = true } = {}) {
  /*
   * GARDEN_LIVE=1 is the only thing that reaches a running board. GARDEN_PORT alone is not enough,
   * and the reason is where these scripts actually get run from: every card terminal on the board
   * is spawned with GARDEN_PORT already in its environment, so "a port in the environment means you
   * meant it" was true of the owner's shell and false of the one place a test is most likely to be
   * started. On 2026-09-04 a card ran seven of these from its terminal, each took 5178 without a
   * word, and two that crashed mid-run left three scratch projects and five cards on the live
   * board. A card cannot have GARDEN_LIVE=1 by accident; it has GARDEN_PORT by construction.
   */
  if (process.env.GARDEN_LIVE === '1') {
    const asked = Number(process.env.GARDEN_PORT)
    const port = Number.isFinite(asked) && asked > 0 ? asked : 5178
    return { port, home: process.env.GARDEN_HOME ?? null, own: false, async stop() {} }
  }
  const instance = await startInstance({ quiet })
  return { ...instance, own: true }
}
