/**
 * What a card can find out about the cards it is wired to, without asking them.
 *
 * The gap this closes was measured rather than imagined. On 2026-08-20 an orchestrator sent three
 * cards the same request twice over four hours and got nothing back, and could not tell whether
 * they had never started, had started and declined, or had died. `garden-send` answers "filed" or
 * "the card is starting" and then says nothing ever again, so the only signal a sender has is a
 * reply, and silence is indistinguishable from every kind of failure. It guessed, and it guessed
 * right by luck, and it wrote the guess down as a limit of the board.
 *
 * The same day the owner reached 95 percent of his weekly usage and the orchestrator could not say
 * which cards had spent it, so it could not have throttled the expensive ones even in principle.
 *
 * Garden already holds both answers. The server knows every session's status, its pid, what it is
 * waiting for and since when, and the CLI's own token and context figures. The board draws all of
 * it. Nothing here computes anything: this asks the server the same question the web app asks on
 * connect, and prints the reply.
 *
 * On provenance, which is this project's whole rule. A number the CLI has not reported is printed
 * as `unknown` and never as zero, and a token figure says whether it came from the transcript (the
 * CLI's own usage record, exact, written after the turn) or from the terminal (a number the CLI
 * printed on its spinner, live but rendered). A reader who cannot tell those apart will trust the
 * live one too far.
 *
 * Usage, from inside a session:
 *   node <this>                     every card on this card's board
 *   node <this> --to "SFX"          one card by title
 *   node <this> --json              the raw rows, for something that wants to parse them
 *   node <this> --finished          include cards that have already finished
 *
 * It is read only. There is no argument that changes anything.
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const ME = process.env.GARDEN_SESSION_ID || null

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/*
 * The command line is walked in pairs for the same reason garden-send walks it in pairs: PowerShell
 * 5.1 rebuilds the line when it invokes node and does not escape a quote inside a value, so a value
 * closes early and the rest arrives as stray argv entries. Silent truncation becomes an error here
 * rather than a filter that quietly matched nothing.
 */
const argv = process.argv.slice(2)
const FLAGS = new Set(['--to', '--json', '--all-projects', '--finished'])
const opts = {}
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!FLAGS.has(token))
    fail(`I do not know the argument "${token}". I take --to, --json, --finished and --all-projects.`)
  if (token in opts) fail(`${token} was given twice, so one of the values was going to be ignored.`)
  if (token === '--json' || token === '--all-projects' || token === '--finished') {
    opts[token] = true
    continue
  }
  const value = argv[++i]
  if (value === undefined) fail(`${token} was given with nothing after it.`)
  opts[token] = value
}

/** How long ago, in the shortest form that is still honest. */
function since(ms) {
  if (ms == null) return 'unknown'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

/** A count the CLI reported, or the word unknown. Never zero standing in for silence. */
function tokens(n, source) {
  if (n == null) return 'unknown'
  const figure = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  // Which source it came from decides how much it is worth, so it is never dropped.
  return `${figure} ${source ?? '?'}`
}

function pct(x) {
  return x == null ? 'unknown' : `${Math.round(x * 100)}%`
}

/*
 * The socket is mounted at a path rather than at the root, and connecting to the root is refused
 * with a 400 that reads like the server being down. The path is WS_PATH in the shared package and
 * it is spelled here rather than imported, because a .mjs in bin cannot reach the workspace build
 * without a bundler step this file exists to avoid.
 */
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)

ws.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })))

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return
  }
  // The server sends several kinds of frame; the board state is the one that answers this.
  if (msg.t !== 'state') return

  const sessions = Array.isArray(msg.sessions) ? msg.sessions : []
  const mine = ME ? sessions.find((s) => s.id === ME) : null

  /*
   * Default scope is this card's own board.
   *
   * A card asking who is alive means the cards it could actually talk to, and a board is the unit
   * that bounds that. Printing every session on the machine would bury the answer in other
   * projects' cards, which is the shape of failure this tool exists to remove rather than repeat.
   */
  let rows = sessions
  if (!opts['--all-projects'] && mine) rows = sessions.filter((s) => s.projectId === mine.projectId)
  if (opts['--to']) {
    const want = String(opts['--to']).trim().toLowerCase()
    rows = rows.filter((s) => String(s.title ?? '').trim().toLowerCase() === want)
    if (rows.length === 0) fail(`No card on this board is called "${opts['--to']}".`)
  }

  if (opts['--json']) {
    process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`)
    ws.close()
    return
  }

  /*
   * Finished subagents are collapsed into a count unless asked for.
   *
   * A board that has been working for a week accumulates dozens of `done` subagent cards, and the
   * first version of this printed all seventy. The two rows that answered the question the tool was
   * built for, two managers sitting at `failed` for four days, were on screen and were not found,
   * which is the same burying this exists to undo. What is live is the answer; what is finished is
   * a number.
   *
   * This names what is FINISHED and shows everything else, and the direction matters more than it
   * looks. The first version listed what was live instead, and left `working` out of that list, so
   * the busiest state a card can be in was filed as finished and hidden. On 2026-08-24 the owner
   * asked for four failed cards to be brought back; three appeared as `idle` and SFX vanished from
   * the board entirely, because it was the one that came up fast enough to already be reading its
   * inbox. The tool reported it as a finished card while it was doing exactly what it was asked.
   *
   * An allow-list also fails silently toward hiding: any status added to the server later is
   * invisible here until somebody notices a missing row, which is the hardest bug to notice. A
   * deny-list fails the other way and shows an unrecognised status, which is noisy and honest.
   * `done` is the only status a card does not come back from. `stopped` and `failed` both revive on
   * a message, so both stay on the board.
   */
  const FINISHED = new Set(['done'])
  const finished = rows.filter((s) => FINISHED.has(String(s.status ?? '')))
  if (!opts['--finished']) rows = rows.filter((s) => !FINISHED.has(String(s.status ?? '')))

  rows.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))

  const out = []
  out.push('CARD                      STATUS         FOR      WAITING ON            TOKENS         CONTEXT')
  for (const s of rows) {
    const title = String(s.title ?? '(untitled)').slice(0, 24).padEnd(24)
    const status = String(s.status ?? 'unknown').slice(0, 13).padEnd(13)
    const forHow = since(s.statusSince).padEnd(7)
    const waiting = String(s.waitingFor ?? '').slice(0, 20).padEnd(20)
    const tok = tokens(s.tokensUsed, s.contextSource).padEnd(13)
    const ctx = pct(s.contextUsed)
    out.push(`${title}  ${status}  ${forHow}  ${waiting}  ${tok}  ${ctx}`)
  }

  /*
   * The count of what has no answer, printed rather than left to be noticed.
   *
   * A table of mostly-unknown is a different situation from a table of mostly-known, and a reader
   * scanning rows will not add it up. This is the line that stops a sender concluding "nobody is
   * spending anything" from a column the CLI simply has not reported yet.
   */
  const unknownTokens = rows.filter((s) => s.tokensUsed == null).length
  const spent = rows.reduce((n, s) => n + (s.tokensUsed ?? 0), 0)
  out.push('')
  out.push(`${rows.length} live cards. ${unknownTokens} have reported no token figure yet, which is not the same as zero.`)
  out.push(`Reported spend across those that have: ${(spent / 1000).toFixed(1)}k tokens.`)
  if (finished.length && !opts['--finished'])
    out.push(`${finished.length} finished cards hidden. Pass --finished to see them.`)
  /*
   * A failed card is named with the command that revives it, not just with its title.
   *
   * The first version said which cards were dead and stopped there, which left the reader holding a
   * diagnosis and no way to act on it: `garden-hire --start` needs the card ID, and the ID is not on
   * screen anywhere. Two of these had been dead for four days while messages were sent to them, so
   * the gap between noticing and fixing is exactly where this tool should not add friction.
   *
   * Reviving is deliberately NOT done here. A card reads its inbox as it comes up, which costs the
   * owner tokens, and a tool that asked for a status should never spend money as a side effect.
   *
   * CORRECTED 2026-08-24, an hour after this file was written. The first version said a message to a
   * failed card "is filed and never read". That is false, and it was tested on the live board by
   * accident: two failed cards were sent a message described in its own body as costing nobody
   * anything, and both woke up and read it.
   *
   * What is true is narrower and was in `garden-send`'s own output the whole time. It answers
   * "delivered to X, and it has been told on screen" for a card that is up, and "filed for X and the
   * card is starting" for one that is not. The second sentence says exactly what happens and it was
   * read as boilerplate for a week.
   */
  const dead = rows.filter((s) => String(s.status) === 'failed')
  if (dead.length) {
    out.push('')
    out.push(`${dead.length} FAILED. Sending to one WAKES IT, and it reads its inbox as it comes up:`)
    for (const d of dead) {
      out.push(`  ${d.title}`)
      out.push(`    node "C:/Garden/server/bin/garden-hire.mjs" --start ${d.id}`)
    }
    out.push('  Reviving costs tokens: each card reads its inbox as it comes up.')
  }
  if (!ME) out.push('GARDEN_SESSION_ID is not set here, so this is every board rather than yours.')

  process.stdout.write(`${out.join('\n')}\n`)
  ws.close()
})

// A board that never answers is a failure worth naming rather than a command that hangs.
setTimeout(() => fail('Garden accepted the connection and never sent the board state.'), 10_000).unref()
