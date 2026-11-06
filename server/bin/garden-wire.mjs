/**
 * Draw a wire between two cards that already exist.
 *
 * This was the missing half of a card's board powers and the owner found it the way these things
 * are always found: an orchestrator on another project could not connect anything, and there was no
 * command to run. The capability was never withheld. `wire.create` has no permission check at all
 * (`index.ts` around 3253); there was simply no tool, so the protocol allowed something nobody could
 * reach.
 *
 * WHY THIS MATTERS MORE THAN A CONVENIENCE. `garden-hire.mjs` takes `--reports-to`, and a card
 * hired WITHOUT it lands with no parent, which means no wire, which means nothing can speak to it
 * and it cannot answer. Until this file existed that mistake was unrecoverable from a card: the only
 * repair was the owner drawing the line by hand. So the gap did not just block new connections, it
 * made one wrong flag permanent.
 *
 *   node <this> --to "DEF side"                       wire the caller to that card, both ways
 *   node <this> --from "ATK side" --to "DEF side"      wire two other cards
 *   node <this> --to "Scout" --label "search"          give the line a name on the board
 *   node <this> --to "Scout" --one-way                 caller may speak, the far end may not answer
 *
 * Titles are accepted as well as ids, resolved within the CALLER'S OWN PROJECT and nowhere else.
 * A title that matches two cards is refused rather than guessed at, because picking one silently is
 * how a message reaches the wrong card and nobody finds out for a day.
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const ME = process.env.GARDEN_SESSION_ID || null

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/*
 * Walked in pairs rather than searched, the same discipline as garden-send and garden-hire: an
 * unrecognised token at an even offset is the visible proof that the shell shattered an argument at
 * a quote, and stepping over it in silence is how half a thing happens while every surface reads as
 * success.
 */
const BOOLEAN = new Set(['--one-way'])
const VALUED = new Set(['--from', '--to', '--label'])
const opts = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (BOOLEAN.has(token)) {
    if (token in opts) fail(`${token} was given twice.`)
    opts[token] = true
    continue
  }
  if (!VALUED.has(token)) {
    fail(`I do not know the argument "${token}".\nI take --from, --to, --label and --one-way.`)
  }
  if (token in opts) fail(`${token} was given twice.`)
  const value = argv[++i]
  if (value === undefined) fail(`${token} was given with nothing after it.`)
  opts[token] = String(value).trim()
}

if (!opts['--to']) fail('Nothing to wire to. Pass --to "<card title or id>".')
if (!ME && !opts['--from']) {
  fail(
    'GARDEN_SESSION_ID is not set, so I do not know which card is asking.\n' +
      'Pass --from "<card title or id>" as well as --to.',
  )
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })))

let acted = false

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return
  }

  /*
   * `wire.added` is the server's confirmation and it is what this waits for, rather than exiting on
   * a hopeful send. A tool that reports success because it managed to write to a socket is the
   * shape of every "filed" that never arrived.
   */
  if (msg.t === 'wire.added' && acted) {
    const w = msg.wire || {}
    process.stdout.write(
      `Wired ${nameOf(w.sourceId)} ${w.bidirectional === false ? '->' : '<->'} ${nameOf(w.targetId)}` +
        `${w.label ? ` labelled "${w.label}"` : ''}.\n`,
    )
    ws.close()
    process.exit(0)
  }

  if (msg.t !== 'state' || acted) return

  const sessions = Array.isArray(msg.sessions) ? msg.sessions : []
  const docs = Array.isArray(msg.docs) ? msg.docs : []
  const channels = Array.isArray(msg.channels) ? msg.channels : []
  const wires = Array.isArray(msg.wires) ? msg.wires : []
  const all = [...sessions, ...docs, ...channels]
  remember(all)

  const mine = ME ? all.find((s) => s.id === ME) : null
  const fromId = resolve(all, opts['--from'] ?? ME, mine, 'from')
  const toId = resolve(all, opts['--to'], mine, 'to')

  if (fromId === toId) fail('A card cannot be wired to itself.')

  const projectId = (all.find((s) => s.id === fromId) || {}).projectId
  if (!projectId) fail('I could not tell which board that card is on.')

  /*
   * Already wired is a success, not a timeout.
   *
   * The server returns early and silently on an existing pair, so no wire.added ever arrives and
   * this would otherwise sit until its own deadline and report that nothing was wired. That reads
   * as a failure of the thing the caller wanted, which already exists, and sends them to retry
   * something that was never broken.
   */
  const already = wires.find(
    (w) =>
      (w.sourceId === fromId && w.targetId === toId) ||
      (w.sourceId === toId && w.targetId === fromId),
  )
  if (already) {
    process.stdout.write(
      `Already wired: ${nameOf(already.sourceId)} ` +
        `${already.bidirectional === false ? '->' : '<->'} ${nameOf(already.targetId)}` +
        `${already.label ? ` labelled "${already.label}"` : ''}. Nothing to do.\n`,
    )
    ws.close()
    process.exit(0)
  }

  acted = true
  ws.send(
    JSON.stringify({
      t: 'wire.create',
      projectId,
      sourceId: fromId,
      targetId: toId,
      label: opts['--label'] ?? '',
      kind: 'manual',
      // Two-way unless asked otherwise, matching what the board does when the owner draws one:
      // a line that refuses the reply reads as the app being broken.
      bidirectional: !opts['--one-way'],
    }),
  )
})

const names = new Map()
function remember(all) {
  for (const s of all) names.set(s.id, s.title || s.name || s.id)
}
function nameOf(id) {
  return `"${names.get(id) || id}"`
}

/**
 * A title or an id, resolved inside the caller's own project.
 *
 * Scoped that way on purpose: two boards can hold cards with the same name, and a tool that searched
 * everywhere would let a wire cross projects on a coincidence of spelling. An exact id is still
 * honoured, so nothing legitimate is blocked; only guessing is.
 */
function resolve(all, wanted, mine, which) {
  if (!wanted) fail(`Nothing given for --${which}.`)
  const exact = all.find((s) => s.id === wanted)
  if (exact) return exact.id

  const scope = mine ? all.filter((s) => s.projectId === mine.projectId) : all
  const want = wanted.toLowerCase()
  const hits = scope.filter((s) => String(s.title || s.name || '').trim().toLowerCase() === want)

  if (hits.length === 1) return hits[0].id
  if (hits.length === 0) {
    const known = scope
      .map((s) => s.title || s.name)
      .filter(Boolean)
      .sort()
    fail(
      `No card called "${wanted}" on this board.\n` +
        (known.length ? `I can see: ${known.join(', ')}` : 'I can see no cards at all.'),
    )
  }
  fail(
    `"${wanted}" matches ${hits.length} cards on this board, so I will not guess.\n` +
      `Pass one of these ids instead: ${hits.map((h) => h.id).join(', ')}`,
  )
}

setTimeout(() => fail('Garden did not answer in time. Nothing was wired.'), 10000).unref?.()
