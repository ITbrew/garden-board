/**
 * Proves a stopped card's history is handed over labelled with the size it was actually drawn at.
 *
 * The failure this catches, in the owner's words: "columns overlapping/erasing words". A CLI does
 * not print finished text. It prints instructions computed for the grid it believes it has, so
 * replaying them at another width puts every wrap somewhere else and lands every "move up two rows
 * and rewrite" on a line it was never aimed at. Characters from two different lines end up
 * interleaved on one row.
 *
 * `scrollback()` answered with the spawn constants, 120x30, for any card with no live process, on
 * the stated reasoning that this is what the bytes on disk were produced against. That is false the
 * moment a pane is opened, because opening one fits the terminal to the pane and resizes the
 * process. And every card is stopped after a server restart, so it was every card at once.
 *
 * Two parts, and they answer different questions. The first is what Garden reports; the second is
 * what a wrong report costs, on a stream this file draws itself so the damage is not a claim about
 * some other program's output.
 */
import { createRequire } from 'node:module'
import { openBoard } from './lib/board.mjs'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { Terminal } = require('@xterm/headless')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// --- part one: what Garden says the bytes mean --------------------------------------------------

const board = await openBoard({ cards: ['Sizer'] })
const card = board.cards[0]

const said = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.scrollback' && m.sessionId === card.id) said.push({ cols: m.cols, rows: m.rows })
})

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(2500)

// The size a dock pane would fit this to. Deliberately neither dimension of the spawn pair, so a
// reply carrying either one is unambiguous about which number it came from.
board.ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols: 100, rows: 40 }))
await sleep(600)

// Something in the buffer, so the card has a history worth replaying at all.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'echo sized\r' }))
await sleep(1500)

board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
await sleep(800)
const live = said[said.length - 1]
check(
  'a live card reports the size it was resized to',
  live?.cols === 100 && live?.rows === 40,
  `reported ${live?.cols}x${live?.rows}`,
)

board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(2000)

board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
await sleep(800)
const dead = said[said.length - 1]
check(
  'and so does the same card once it is stopped',
  dead?.cols === 100 && dead?.rows === 40,
  `reported ${dead?.cols}x${dead?.rows}, drawn at 100x40`,
)

await board.stop()

// --- part two: what the wrong pair costs --------------------------------------------------------

/*
 * A stream drawn for a 100 column grid, using the two things every full-screen CLI does: wrap at the
 * width it was told, and move the cursor back up to rewrite a line it has already printed. Nothing
 * here is specific to Claude Code; it is the shape of all of them.
 *
 * The run of As is the data. It fills the grid exactly, so at 100 columns the words after it are a
 * second row and the rewrite one row up lands on those words. At 120 they are all one row, the same
 * rewrite lands on the data instead, and eleven characters of it are gone.
 */
const WIDTH = 100
const drawn = [
  '\x1b[2J\x1b[H',
  'A'.repeat(WIDTH) + 'a status line',
  '\r\n',
  'the answer itself',
  '\x1b[1A\r',
  'REWRITTEN..',
].join('')

const screenAt = async (cols) => {
  const term = new Terminal({ cols, rows: 12, scrollback: 50, allowProposedApi: true })
  await new Promise((r) => term.write(drawn, r))
  const out = []
  for (let y = 0; y < term.buffer.active.length; y++) {
    out.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  }
  return out.filter((l) => l.trim())
}

const right = await screenAt(WIDTH)
const wrong = await screenAt(120)

const intact = (rows) => rows.some((l) => l === 'A'.repeat(WIDTH))
const shorten = (rows) => rows.map((l) => l.replace(/A{4,}/g, (m) => `A×${m.length}`)).join(' / ').slice(0, 100)

check(
  'replayed at its own width, the rewrite lands on the status line and the data is untouched',
  intact(right) && right.some((l) => l.startsWith('REWRITTEN..')),
  shorten(right),
)
check(
  'replayed at another width, the same rewrite eats the data instead',
  !intact(wrong),
  shorten(wrong),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
