/**
 * Bring every card on the board back up after a server reset.
 *
 * A Garden restart tears down the PTYs, and the cards do not come back with it. On 2026-08-18 seven
 * of fourteen were dead and seven were fine, with nothing on screen saying which was which. The
 * owner found out because a card stopped answering. This is the one command that fixes that.
 *
 *   node scripts/board-revive.mjs           start every card that is down, report what changed
 *   node scripts/board-revive.mjs --dry     say what it would start, touch nothing
 *
 * It does NOT write to the database. Enumerating is a readonly query, and starting goes through the
 * server's own /hire endpoint, which is the supported path and is idempotent: a card that is already
 * running answers "already running" and nothing happens to it. That matters, because the failure
 * this script exists to prevent must not be replaced by a script that restarts a working card and
 * loses whatever it was mid-way through.
 */
import { createRequire } from 'node:module'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Resolved from this file rather than from a hard-coded install path, so the checkout can live
// anywhere. better-sqlite3 is native and has to come from this repository's own node_modules.
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const PORT = Number(process.env.GARDEN_PORT || 5178)
const DB = process.env.GARDEN_DB || join(homedir(), '.garden', 'garden.db')
const dry = process.argv.includes('--dry')

/*
 * Cards that are stopped on purpose. Without this the script would resurrect the board's history:
 * every card ever hired and deliberately retired would come back on the next reset, and the running
 * limit would refuse the ones that are actually wanted.
 *
 * Named rather than inferred from status, because a card killed by a reset and a card retired by the
 * owner may look identical in the database, and guessing wrong in the resurrect direction is the
 * expensive one.
 */
const RETIRED = new Set(['Iris', 'Manager', 'Worker'])

/**
 * There is exactly one orchestrator and it is whoever is running this. A superseded orchestrator row
 * is left in the database when the card is replaced, and starting it would put a second card on the
 * board that believes it owns the canon and talks to the owner. Caught by the dry run on the first
 * day this script existed.
 */
const ONE_ONLY = new Set(['Orchestrator'])

/** The card asking cannot start itself, and trying would be a no-op at best. */
const SELF = process.env.GARDEN_SESSION_ID || ''
if (!SELF) {
  // Without it, this script cannot tell itself from a stale row of the same name, and the guard
  // above is the only thing standing between a reset and two orchestrators.
  console.error('GARDEN_SESSION_ID is not set. Run this from a card, not from a bare shell.')
  process.exit(1)
}

function post(payload) {
  return new Promise((done) => {
    const body = JSON.stringify(payload)
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/hire',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () => done({ ok: res.statusCode === 200, text: out.trim() }))
      },
    )
    req.on('error', (e) => done({ ok: false, text: `no answer on port ${PORT}: ${e.message}` }))
    req.end(body)
  })
}

let db
try {
  db = new Database(DB, { readonly: true })
} catch (e) {
  console.error(`Cannot read the board at ${DB}: ${e.message}`)
  process.exit(1)
}

/*
 * Every card, whatever its status. NOT "status <> stopped": if a server reset marks a killed card as
 * stopped, filtering on status would skip exactly the cards that need starting, which is the one
 * case this script is for. The retired list above is what narrows it instead, and it is explicit.
 */
const cards = db
  .prepare("SELECT id, title, status FROM sessions WHERE kind = 'session' ORDER BY title")
  .all()
  .filter((c) => c.id !== SELF && !RETIRED.has(c.title) && !ONE_ONLY.has(c.title))

if (!cards.length) {
  console.log('No cards on the board to start.')
  process.exit(0)
}

/*
 * One at a time rather than in parallel. The server enforces a ceiling on running cards and refuses
 * past it, and a refusal that names which card was refused is worth more than a fast sweep whose
 * failures arrive interleaved.
 */
const started = []
const alive = []
const failed = []

for (const c of cards) {
  if (dry) {
    console.log(`would start  ${c.title}  (db status: ${c.status})`)
    continue
  }
  const res = await post({ from: SELF, action: 'start', cardId: c.id })
  if (!res.ok) {
    failed.push(`${c.title}: ${res.text}`)
    // A dead server fails identically for every card, so say it once and stop rather than print it
    // fourteen times.
    if (res.text.includes('no answer on port')) {
      console.error(`Garden is not running on port ${PORT}. Start the server first, then re-run this.`)
      process.exit(1)
    }
  } else if (/already running/i.test(res.text)) alive.push(c.title)
  else started.push(c.title)
}

if (dry) process.exit(0)

console.log(`started ${started.length}, already up ${alive.length}, refused ${failed.length}`)
if (started.length) console.log(`\nstarted:\n  ${started.join('\n  ')}`)
if (alive.length) console.log(`\nalready up:\n  ${alive.join('\n  ')}`)
if (failed.length) console.log(`\nrefused:\n  ${failed.join('\n  ')}`)

/*
 * A started card comes back with its roots and its mail, and without whatever it was part-way
 * through when it died. Anything in flight has to be re-sent by whoever sent it, and only the sender
 * knows what that was, so the script says so rather than implying the board is back to where it was.
 */
if (started.length) {
  console.log(
    `\nNote: a restarted card has its roots and its mail but not its in-flight turn.\n` +
      `Anything dispatched to these ${started.length} and not yet answered needs re-sending.`,
  )
}
