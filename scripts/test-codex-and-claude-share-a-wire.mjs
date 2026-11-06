/**
 * Proves a wire between a Codex card and a Claude card carries in both directions.
 *
 * The owner's ask: "insure codex/claude cards can talk to each other thru the 2 way wire". Garden's
 * mail path has no adapter in it anywhere, so the claim is plausible and was never checked, and a
 * connection nobody has run is a drawn line rather than a connection. That distinction is the one
 * this app exists to make, so it gets a test rather than an assurance.
 *
 * What it does NOT do is ask a model anything. Delivery, the mailbox and the wake-up are Garden's
 * work and are testable on their own; whether the agent then reads its mail is the agent's business.
 * So the Codex card is a real Codex card with a real process, and the sending is done by running the
 * shim exactly as that card would run it, with its own id in the environment and nothing else.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

/*
 * The Codex card comes up silent here.
 *
 * Garden now hands a Codex session a short prompt on launch, because nothing else ever tells it that
 * it is on a board or who it is wired to. A prompt makes the session take a turn, and this test only
 * needs a process on the other end of a wire, so it would be spending the owner's tokens on every
 * run to prove something `test-codex-is-told-it-is-on-a-board.mjs` proves for free.
 */
process.env.GARDEN_CODEX_BRIEF = '0'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEND = join(ROOT, 'server', 'bin', 'garden-send.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Claude side'] })
const claude = board.cards[0]

const added = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.added') added.push(m.session)
})

/*
 * A real Codex card, made the way the right-click menu makes one: adapter only, no title, no start
 * flag. Started, because a card with no process cannot be woken and the wake-up is half of what is
 * being tested.
 */
board.ws.send(JSON.stringify({ t: 'session.create', projectId: board.project.id, adapterId: 'codex' }))
await sleep(4000)
const codex = added.find((s) => s.adapterId === 'codex')
check('a codex card can be made at all', !!codex, codex ? `"${codex.title}" pid=${codex.pid}` : '(none)')
if (!codex) {
  await board.stop()
  process.exit(1)
}
check('and it is a session like any other, not a special case', codex.kind === 'session')

board.ws.send(
  JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: claude.id, targetId: codex.id }),
)
await sleep(1200)

const inboxOf = (id) => join(board.home, 'mail', id, 'INBOX.md')
const peersOf = (id) => join(board.home, 'mail', id, 'PEERS.md')

check(
  'each side is told the other exists',
  existsSync(peersOf(codex.id)) &&
    readFileSync(peersOf(codex.id), 'utf8').includes('Claude side') &&
    existsSync(peersOf(claude.id)) &&
    readFileSync(peersOf(claude.id), 'utf8').includes(codex.title),
  'PEERS.md on both',
)

/** Run the shim as one card would run it, and hand back what it printed. */
const sendAs = (fromId, toTitle, text) =>
  execFileSync(process.execPath, [SEND, '--to', toTitle, '--kind', 'work', '--task', 'wire-1', '--text', text], {
    encoding: 'utf8',
    env: { ...process.env, GARDEN_SESSION_ID: fromId, GARDEN_PORT: String(board.port) },
  })

// --- claude to codex ------------------------------------------------------------------------------

const toCodex = 'Take the loader screen, it is yours.'
const out1 = sendAs(claude.id, codex.title, toCodex)
await sleep(1500)
check(
  'a claude card can send to a codex card',
  existsSync(inboxOf(codex.id)) && readFileSync(inboxOf(codex.id), 'utf8').includes(toCodex),
  out1.trim().split('\n')[0],
)

// --- and back -------------------------------------------------------------------------------------

const toClaude = 'Loader screen done, and I left the sim half alone.'
const out2 = sendAs(codex.id, 'Claude side', toClaude)
await sleep(1500)
check(
  'and the codex card can answer on the same wire',
  existsSync(inboxOf(claude.id)) && readFileSync(inboxOf(claude.id), 'utf8').includes(toClaude),
  out2.trim().split('\n')[0],
)

check(
  'the codex card keeps its own record of what it sent',
  existsSync(join(board.home, 'mail', codex.id, 'SENT.md')) &&
    readFileSync(join(board.home, 'mail', codex.id, 'SENT.md'), 'utf8').includes(toClaude),
)

// --- and it is actually told, not just written to ---------------------------------------------------

/*
 * The wake-up is what makes a mailbox a message. Garden types one line into the card's own process,
 * and that path is a plain PTY write with no adapter in it, so a Codex card should hear it exactly
 * as a Claude card does. Read from the scrollback the server records, which is the bytes the process
 * was actually sent rather than anything rendered.
 */
const scrollback = join(board.home, 'scrollback', `${codex.id}.log`)
/*
 * The exact sentence Garden types, not a word that might appear in it.
 *
 * A first version of this check tested the terminal for /INBOX|wire|message/i and passed, while the
 * send's own answer said the card had been "filed" rather than told and no line had been typed at
 * all. Codex prints eight kilobytes of its own banner on the way up and one of those words was in
 * there. A test that passes on the wrong bytes is worse than no test, because it is evidence that
 * something was checked.
 */
const WAKE = 'Read your INBOX.md'
let heard = ''
for (let i = 0; i < 12 && !heard.includes(WAKE); i++) {
  await sleep(2000)
  heard = existsSync(scrollback) ? readFileSync(scrollback, 'utf8') : ''
}
check(
  'the codex card is told it has mail rather than left to notice',
  heard.includes(WAKE),
  heard.includes(WAKE)
    ? 'Garden typed the notice into its terminal'
    : `never typed; ${heard.length} bytes of terminal recorded and none of it is the notice`,
)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
