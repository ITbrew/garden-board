/**
 * A buffer holding screens drawn at two different widths: does replaying it show the older one?
 *
 * Garden keeps 256 KB of everything a card printed and labels the whole thing with ONE geometry, so
 * a pane that attaches later replays bytes computed for a 260-column screen onto whatever grid it
 * has now. The proposed fix was to cut the buffer into segments and resize between them on replay,
 * which is real work in five files. This decides whether that work is needed, because a full-screen
 * program repaints its entire screen after a resize, and a repaint that lands last may simply cover
 * everything drawn before it.
 *
 * `scripts/lib/alt-screen-tui.mjs` is the program: it takes over the screen, draws a box sized to
 * the current width, stamps each redraw with its own number, and repaints when anything arrives on
 * stdin. So the buffer can be made to hold a wide screen followed by a narrow one on purpose, which
 * is exactly the case a dragged dock produces.
 *
 * The replay is done here with the same headless xterm the card miniature uses, at the same
 * geometry the server reports, so what is measured is what a card would draw.
 */
import WebSocket from 'ws'
// CommonJS in Node's eyes, so the named export is not reachable directly.
import xtermHeadless from '@xterm/headless'
const Headless = xtermHeadless.Terminal
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInstance } from './lib/instance.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, 'lib', 'alt-screen-tui.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const WIDE = 200
const NARROW = 90
const ROWS = 30

const garden = await startInstance()
const dir = mkdtempSync(join(tmpdir(), 'garden-replay-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const state = { projects: [], sessions: [] }
const scroll = []
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'session.scrollback') scroll.push(m)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('the scratch project was added', !!project)
if (!project) {
  await garden.stop()
  process.exit(1)
}

ws.send(
  JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Replay', start: true }),
)
await sleep(3500)
const card = state.sessions.find((s) => s.title === 'Replay')
check('the shell card is running', !!card && card.pid !== null)
if (!card || card.pid === null) {
  await garden.stop()
  process.exit(1)
}

// Wide first, so the screen that goes into the buffer first is one the replay grid cannot hold.
ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols: WIDE, rows: ROWS }))
await sleep(600)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: `node "${FIXTURE}"` }))
await sleep(150)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
await sleep(4000)

// Then narrow, and ask the program to repaint, which is what a real CLI does on a resize.
ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols: NARROW, rows: ROWS }))
await sleep(800)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: ' ' }))
await sleep(2000)

const before = scroll.length
ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
const deadline = Date.now() + 5000
while (scroll.length === before && Date.now() < deadline) await sleep(50)
const snap = scroll[scroll.length - 1]
check('the server answered with a buffer', !!snap && snap.data.length > 0, `${snap?.data?.length} bytes`)

check(
  'the buffer really does hold two screens drawn at different widths',
  snap.data.includes('READY-1') && snap.data.includes('READY-2'),
  `DRAW-1 present: ${snap.data.includes('READY-1')}, DRAW-2 present: ${snap.data.includes('READY-2')}`,
)
check('the server reports the narrow geometry', snap.cols === NARROW, `${snap.cols}x${snap.rows}`)

// --- replay it the way a card does -------------------------------------------------------------

const term = new Headless({ cols: snap.cols, rows: snap.rows, scrollback: 200, allowProposedApi: true })
await new Promise((done) => term.write(snap.data, done))

const buf = term.buffer.active
const lines = []
for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')

if (process.env.GARDEN_REPLAY_DEBUG) {
  console.log(`  buffer type ${term.buffer.active.type}, length ${buf.length}, cursorY ${buf.cursorY}`)
  console.log(lines.map((l, i) => `${String(i).padStart(3)}| ${l.slice(0, 80)}`).join('\n'))
}

/*
 * What "smeared" would look like as a number.
 *
 * Every row the fixture draws carries the number of the paint that drew it. The last paint is the
 * narrow one, so a screen in a consistent state carries exactly one number. A row still stamped with
 * an earlier paint is a row the newer one did not cover, which is what a mixed-geometry replay was
 * expected to leave behind.
 */
const generations = new Set()
for (const l of lines) {
  const m = l.match(/(?:ROW|DRAW|READY)-(\d+)\b/)
  if (m) generations.add(Number(m[1]))
}
const newest = generations.size ? Math.max(...generations) : 0
const stale = [...generations].filter((g) => g !== newest)
const longRows = lines.filter((l) => l.length > snap.cols).length

console.log(
  `\n  replayed at ${snap.cols}x${snap.rows}` +
    `\n  paint generations visible on the final screen: ${[...generations].join(', ') || 'none'}` +
    `\n  rows wider than the grid: ${longRows}\n`,
)

check('the replayed screen has content', newest > 0, `generations seen: ${[...generations].join(', ') || 'none'}`)
check(
  'the final screen carries one paint, not a mix of the two widths',
  stale.length === 0,
  `newest is ${newest}, also present: ${stale.join(', ')}`,
)
check(
  'and no row is wider than the grid it was replayed onto',
  longRows === 0,
  `${longRows} rows longer than ${snap.cols} columns`,
)

ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(1200)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
