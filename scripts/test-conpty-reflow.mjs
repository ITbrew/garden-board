/**
 * Does resizing a live ConPTY put copies into the stream that the program never sent?
 *
 * The owner photographed text drawn twice at two horizontal offsets, on top of itself. The
 * suspicion this file exists to settle: ConPTY reflows and re-emits its screen buffer when it is
 * resized, and Garden resizes a live PTY on nearly every interaction he has with the app. Opening a
 * second terminal pane resizes the first one. Every panel drag resizes every open pane. Starting or
 * stopping any session does it. So a fault that needs a resize to appear has a trigger he pulls
 * constantly, which is what "frequently" means here.
 *
 * WHY THIS ASSERTS ON RAW BYTES. `test-terminal-geometry-tui.mjs` reads rendered rows out of the
 * DOM, which mixes two different faults: "ConPTY sent garbage" and "xterm drew it at the wrong
 * width". They have different fixes and they have already been confused once. This reads the
 * server's own scrollback over the socket, which is the exact bytes the process emitted before
 * anything renders them.
 *
 * WHY IT CAN BE EXACT. `scripts/lib/alt-screen-tui.mjs` stamps a redraw number into every line it
 * writes, so the program's own count of how many screens it sent is knowable. A stream holding two
 * copies of `DRAW-7` holds one this program did not send. That is not an estimate of corruption, it
 * is corruption counted.
 *
 * A plain shell could not reproduce this because a shell sits on the main screen and repaints
 * nothing on resize. The fault is specific to the alternate screen buffer, which is what a
 * full-screen TUI uses, and which microsoft/terminal#4389 ("Alternate console buffers of different
 * sizes confuse ConPTY", open since January 2020) names directly.
 */
import WebSocket from 'ws'
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

const WIDE = 120
const NARROW = 96
const ROUNDS = 3
const BETWEEN_RESIZE_MS = 1000

const count = (haystack, needle) => haystack.split(needle).length - 1

const garden = await startInstance()
const dir = mkdtempSync(join(tmpdir(), 'garden-reflow-'))
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
  JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Reflow', start: true }),
)
await sleep(3500)
const card = state.sessions.find((s) => s.title === 'Reflow')
check('the shell card is running', !!card && card.pid !== null, card ? `pid ${card.pid}` : 'no card')
if (!card || card.pid === null) {
  await garden.stop()
  process.exit(1)
}

// Text and the carriage return go separately, which is the rule the rest of the server follows for
// writing into a live process.
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: `node "${FIXTURE}"` }))
await sleep(150)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
await sleep(4000)

async function snapshot() {
  const before = scroll.length
  ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  const deadline = Date.now() + 5000
  while (scroll.length === before && Date.now() < deadline) await sleep(50)
  const m = scroll[scroll.length - 1]
  if (!m) throw new Error('no scrollback answer')
  return { data: m.data ?? '', seq: m.seq, cols: m.cols, rows: m.rows }
}

const start = await snapshot()
check(
  'the fixture took over the screen',
  count(start.data, '\x1b[?1049h') >= 1 && count(start.data, 'DRAW-1') >= 1,
  `${start.data.length} bytes, alt-screen entries ${count(start.data, '\x1b[?1049h')}`,
)

// --- the resizes -------------------------------------------------------------------------------

for (let i = 0; i < ROUNDS * 2; i++) {
  const cols = i % 2 === 0 ? NARROW : WIDE
  ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols, rows: start.rows }))
  await sleep(BETWEEN_RESIZE_MS)
}
await sleep(1500)
const end = await snapshot()

/*
 * How many screens the program sent, and how many came out.
 *
 * `drew` counts distinct redraw numbers present. `copies` is the worst duplication of any single
 * one. A program that painted seven screens and a stream that holds seven is ConPTY passing bytes
 * through; a stream that holds two of screen four is ConPTY inventing one.
 */
let drew = 0
let total = 0
let worst = { n: 0, copies: 0 }
for (let n = 1; n <= 60; n++) {
  const c = count(end.data, `READY-${n}`)
  if (c === 0) continue
  drew++
  total += c
  if (c > worst.copies) worst = { n, copies: c }
}
const duplicates = total - drew

const alt = count(end.data, '\x1b[?1049h')
console.log(
  `\n  the program painted ${drew} distinct screens` +
    `\n  the stream holds ${total} of them, so ${duplicates} copies nobody sent` +
    `\n  the worst is DRAW-${worst.n}, present ${worst.copies} times` +
    `\n  alt-screen entries in the whole stream: ${alt}` +
    `\n  buffer ${end.data.length} bytes, geometry ${end.cols}x${end.rows}\n`,
)

/*
 * The attribution is the point, and it does not depend on whether the program redrew.
 *
 * Node does not raise `resize` on Windows under ConPTY, so on this machine the fixture paints once
 * and never again. That makes the arithmetic unambiguous rather than weaker: one screen was sent,
 * and every further copy in the stream came from somewhere else. If a future Windows does deliver
 * the event, `drew` rises with it and the subtraction still isolates what the program did not send.
 */
check(
  'no screen the program painted once appears in the stream twice',
  duplicates === 0,
  `${duplicates} copies nobody sent, worst DRAW-${worst.n} x${worst.copies}, after ${ROUNDS * 2} resizes`,
)

check(
  'the stream enters the alternate screen once, not once per resize',
  alt <= 1,
  `${alt} entries after ${ROUNDS * 2} resizes`,
)

check(
  'the geometry the server reports is the one it was last told',
  end.cols === WIDE,
  `reported ${end.cols}, last told ${WIDE}`,
)

if (process.env.GARDEN_REFLOW_VERBOSE) {
  const out = join(process.cwd(), 'docs', 'reflow-dump.txt')
  writeFileSync(out, end.data, 'utf8')
  console.log(`  wrote the raw buffer to ${out}`)
}

ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(1200)
ws.close()
await garden.stop()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
