/**
 * Proves the owner and one card can hold a conversation that nothing else is in.
 *
 * Why it exists, in his words: "currently orchestrator gets tied up in a lot of things and its hard
 * for me to found our back and forth". A card's terminal carries every tool call, every file it read
 * and every message off every wire, so the two sentences he actually exchanged with it are somewhere
 * in the middle of all that. The message card is a second, much smaller surface holding only those.
 *
 * The thing being checked is that it is a file and not a transport. There is one copy of the
 * conversation, `NOTES.md` in the bound card's own mail directory, the owner appends to it by
 * pressing Send, the card appends to it with the ordinary file writing it already has, and both
 * sides are looking at the same bytes. So this test writes as the card would, with `appendFileSync`
 * and nothing else, and checks the board notices.
 *
 * Its own Garden on its own port with its own workspace, so it cannot reach a real board.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Orchestrator'] })
const card = board.cards[0]

const channels = []
const texts = []
const errors = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'channel.added' || m.t === 'channel.updated') channels.push(m.channel)
  if (m.t === 'channel.text') texts.push(m)
  if (m.t === 'error') errors.push(m.message)
})

// --- drawn, and bound to nobody -------------------------------------------------------------------

board.ws.send(JSON.stringify({ t: 'channel.create', projectId: board.project.id, x: 40, y: 40 }))
await sleep(900)
const made = channels[0]
check('a message card can be put on the board', !!made, made ? made.id.slice(0, 8) : '(none)')
check(
  'and it starts bound to nobody, which is a real state and not an error',
  made && made.sessionId === null && made.path === null,
)

const before = errors.length
board.ws.send(JSON.stringify({ t: 'channel.send', channelId: made.id, text: 'anyone there' }))
await sleep(700)
check(
  'sending before it is wired is refused rather than dropped',
  errors.length > before && /not wired/i.test(errors[errors.length - 1]),
  errors[errors.length - 1] ?? '(said nothing)',
)

// --- the wire is what binds it ---------------------------------------------------------------------

board.ws.send(
  JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: made.id, targetId: card.id }),
)
await sleep(1200)

const bound = channels[channels.length - 1]
const notes = join(board.home, 'mail', card.id, 'NOTES.md')
check('drawing the wire binds the card', bound.sessionId === card.id, `bound to ${bound.sessionId?.slice(0, 8)}`)
check(
  'and the file it writes to is that card\'s own, beside its mailbox',
  bound.path && bound.path.replace(/\\/g, '/').endsWith(`mail/${card.id}/NOTES.md`),
  bound.path ?? '(none)',
)
check('the file exists once it is bound', existsSync(notes))

// --- what the owner says --------------------------------------------------------------------------

const said = "Don't take the roots job yet. I want the board's own \"NOTES\" first."
board.ws.send(JSON.stringify({ t: 'channel.send', channelId: made.id, text: said }))
await sleep(1200)

const onDisk = readFileSync(notes, 'utf8')
check('what the owner sends lands in the file, verbatim', onDisk.includes(said), `${onDisk.length} bytes`)
check('and is attributed to him', /^## Owner,/m.test(onDisk))
check(
  'and comes back to the board from the file rather than from the send',
  texts.some((t) => t.channelId === made.id && t.text.includes(said)),
  `${texts.length} pushes`,
)

// --- what the card says back ------------------------------------------------------------------------

/*
 * Appended the way the card would append it, with a file write and nothing else. No hook fires for
 * this and Garden is told nothing, so a board that shows it has genuinely noticed a file change
 * rather than been notified of one.
 */
const replied = 'Understood. NOTES first, roots after.'
const seen = texts.length
appendFileSync(notes, `\n## Orchestrator, now\n\n${replied}\n`, 'utf8')
await sleep(2500)

check(
  'a reply written straight into the file reaches the board',
  texts.length > seen && texts[texts.length - 1].text.includes(replied),
  texts.length > seen ? 'noticed without being told' : 'the board never saw it',
)

// --- and it is not the mail system --------------------------------------------------------------

const inbox = join(board.home, 'mail', card.id, 'INBOX.md')
check(
  'none of it went through the card\'s mailbox',
  !existsSync(inbox) || !readFileSync(inbox, 'utf8').includes(said),
  'the whole point is that this is separate from mail',
)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
