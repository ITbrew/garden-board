/**
 * A pane opened late in a long turn still shows the input box. Canon 03 revision 17.
 *
 * The owner, with a screenshot of a working Orchestrator whose pane showed the spinner and the status
 * row but no prompt box: "my terminal pane doesnt have input field, its empty. it did load after some
 * time". Claude draws its box once at the start of a turn and then repaints only its spinner, several
 * times a second. The snapshot a pane is built from was the last 256KB of bytes, and after about
 * eight minutes of spinner the bytes that drew the box had left it.
 *
 * The fixture does the same thing faster: takes over the screen, draws a box once, then rewrites one
 * spinner row in place until well past 256KB. The snapshot a pane would get is replayed into a
 * headless terminal at the geometry the server reports, and the box has to be on it. Its own Garden on
 * its own port and workspace, serving the BUILT app: run `npm run build` first.
 */
import xtermHeadless from '@xterm/headless'
import { openBoard } from './lib/board.mjs'

const Headless = xtermHeadless.Terminal
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// Box once, then about 400KB of spinner rewrites on one row, then a marker so the test knows it is done.
const TUI = `const w = (s) => process.stdout.write(s)
w('\\x1b[?1049h\\x1b[2J\\x1b[H')
w('\\x1b[20;1H' + '─'.repeat(60))
w('\\x1b[21;1H> the input box, drawn once')
w('\\x1b[22;1H' + '─'.repeat(60))
let n = 0
const frames = ['·', '✢', '✳', '✶', '✻', '✽']
const tick = () => {
  let chunk = ''
  for (let i = 0; i < 400; i++, n++) chunk += '\\x1b[18;1H\\x1b[2K' + frames[n % 6] + ' Working… (' + n + ')'
  w(chunk)
  if (n < 20000) setImmediate(tick)
  else w('\\x1b[17;1HSPIN-DONE')
}
tick()
process.stdin.resume()
`
const board = await openBoard({ projectName: 'late-pane', cards: [{ title: 'Spinner' }], files: { 'tui.mjs': TUI } })
const [card] = board.cards
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(5000)
// ConPTY holds the first input while it waits for an answer nobody here gives; this Enter is spent on it.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
await sleep(800)
board.ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols: 100, rows: 30 }))
await sleep(500)
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'node tui.mjs' + String.fromCharCode(13) }))

const snapshot = () =>
  new Promise((resolve) => {
    const on = (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t !== 'session.scrollback' || m.sessionId !== card.id) return
      board.ws.off('message', on)
      resolve(m)
    }
    board.ws.on('message', on)
    board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  })

let snap = null
let printed = 0
for (let i = 0; i < 120; i++) {
  await sleep(500)
  snap = await snapshot()
  printed = snap.seq
  if (snap.data.includes('SPIN-DONE')) break
}
check('the fixture printed well past the 256KB the server used to keep', printed > 300 * 1024, `${Math.round(printed / 1024)}KB`)

const term = new Headless({ cols: snap.cols, rows: snap.rows, scrollback: 500, allowProposedApi: true })
await new Promise((done) => term.write(snap.data, done))
const buf = term.buffer.active
const screen = []
for (let i = 0; i < buf.length; i++) screen.push(buf.getLine(i)?.translateToString(true) ?? '')
const text = screen.join('\n')
check('a pane built from the snapshot shows the input box', text.includes('> the input box, drawn once'))
check('and the rules around it', screen.filter((l) => l.startsWith('─'.repeat(60))).length >= 2)
check('and the spinner as it stands now', text.includes('SPIN-DONE') && /Working… \(\d+\)/.test(text))

board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
