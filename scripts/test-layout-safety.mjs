/**
 * A hand-built board cannot be lost to one button press.
 *
 * The owner said plainly that he was afraid to arrange a board he had arranged himself, and he was
 * right to be: the way back lived in the browser tab that pressed the button, so a reload lost it.
 * This test therefore reconnects as a fresh client before restoring, because surviving that is the
 * whole point and a test that reused the same socket would have passed against the broken version.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

const garden = await target()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

function connect() {
  const st = { projects: [], sessions: [], layouts: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    else if (m.t === 'layouts') st.layouts = m.layouts
    else if (m.t === 'error') console.log('   server said:', m.message)
  })
  return { ws, st, ready: new Promise((r) => ws.on('open', r)) }
}

const dir = mkdtempSync(join(tmpdir(), 'garden-layout-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const a = connect()
await a.ready
a.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)
a.ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = a.st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const stamp = Date.now().toString().slice(-5)
for (const n of ['One', 'Two', 'Three']) {
  a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: `${n} ${stamp}` }))
  await sleep(1700)
}
const mine = () => a.st.sessions.filter((s) => s.projectId === project.id)
check('three cards to arrange', mine().length === 3, `${mine().length}`)

// A layout the owner built by hand, which is the thing that must not be lost.
const byHand = [
  { x: 100, y: 100 },
  { x: 900, y: 420 },
  { x: 1700, y: 60 },
]
mine().forEach((s, i) => a.ws.send(JSON.stringify({ t: 'session.move', sessionId: s.id, x: byHand[i].x, y: byHand[i].y })))
await sleep(900)
const handMade = JSON.stringify(mine().map((s) => [s.title, Math.round(s.x), Math.round(s.y)]).sort())

a.ws.send(JSON.stringify({ t: 'layout.save', projectId: project.id, name: `mine ${stamp}` }))
await sleep(700)
check('the layout can be saved by name', a.st.layouts.some((l) => l.name === `mine ${stamp}`),
  a.st.layouts.map((l) => l.name).join(', '))

// Now the thing he is afraid of.
a.ws.send(JSON.stringify({
  t: 'board.arrange',
  positions: mine().map((s, i) => ({ id: s.id, x: i * 700, y: 40 })),
}))
await sleep(900)
const arranged = JSON.stringify(mine().map((s) => [s.title, Math.round(s.x), Math.round(s.y)]).sort())
check('an arrangement really does move everything', arranged !== handMade)

// A fresh client, which is what a reload looks like from the server's side.
a.ws.close()
await sleep(400)
const b = connect()
await b.ready
b.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(900)
b.ws.send(JSON.stringify({ t: 'layout.list', projectId: project.id }))
await sleep(600)

const auto = b.st.layouts.find((l) => l.automatic)
check('a fresh client is still offered the way back', !!auto, auto ? auto.name : 'none')

b.ws.send(JSON.stringify({ t: 'layout.restore', layoutId: auto.id }))
await sleep(1000)
const restored = JSON.stringify(
  b.st.sessions.filter((s) => s.projectId === project.id).map((s) => [s.title, Math.round(s.x), Math.round(s.y)]).sort(),
)
check('and it puts every card back where it was', restored === handMade,
  restored === handMade ? '' : `\n           wanted ${handMade}\n           got    ${restored}`)

// The named one must survive too, and restoring it must not need the automatic one.
b.ws.send(JSON.stringify({
  t: 'board.arrange',
  positions: b.st.sessions.filter((s) => s.projectId === project.id).map((s, i) => ({ id: s.id, x: 50, y: i * 400 })),
}))
await sleep(900)
const named = b.st.layouts.find((l) => l.name === `mine ${stamp}`)
b.ws.send(JSON.stringify({ t: 'layout.restore', layoutId: named.id }))
await sleep(1000)
const fromNamed = JSON.stringify(
  b.st.sessions.filter((s) => s.projectId === project.id).map((s) => [s.title, Math.round(s.x), Math.round(s.y)]).sort(),
)
check('a layout saved by name restores the same board', fromNamed === handMade,
  fromNamed === handMade ? '' : `\n           wanted ${handMade}\n           got    ${fromNamed}`)

for (const s of b.st.sessions.filter((s) => s.projectId === project.id)) {
  b.ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(350)
}
b.ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
b.ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
