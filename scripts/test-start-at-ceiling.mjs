/*
 * Switching on a card that is already on the board is not a hire.
 *
 * On 23 September .5Orche2 could not start three stopped cards with `garden-hire.mjs --start`: the
 * board held 25 of its 25 and the start was refused with the card-count sentence, although starting
 * a card cannot change how many there are. The board's own Turn on went through the whole time.
 *
 * Checked here: at the card ceiling, a start is allowed; at the running ceiling it is still refused;
 * and a new card at the card ceiling is still refused. Runs against a server of its own, on its own
 * port with its own workspace.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const PORT = garden.port
const dir = mkdtempSync(join(tmpdir(), 'garden-startceiling-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], errors: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'error') st.errors.push(m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await garden.stop()
  process.exit(1)
}
const setLimits = async (limits) => {
  ws.send(JSON.stringify({ t: 'limits.set', projectId: project.id, limits }))
  await sleep(400)
}
const make = async (title, roleClass) => {
  const before = st.sessions.length
  st.errors.length = 0
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, roleClass, start: false }))
  await sleep(450)
  return { made: st.sessions.length > before, said: st.errors[0] ?? null }
}
const start = async (from, cardId) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/hire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, action: 'start', cardId }),
  })
  return { code: res.status, text: await res.text() }
}

await setLimits({ running: 6, cardsPerProject: 3, childrenPerCard: 4 })
await make('Orchestrator', 'orchestrator')
await make('Worker A', 'worker')
await make('Worker B', 'worker')
const orch = st.sessions.find((s) => s.title === 'Orchestrator')
const a = st.sessions.find((s) => s.title === 'Worker A')
const b = st.sessions.find((s) => s.title === 'Worker B')
check('the board is full: three of three', !!(orch && a && b))

const extra = await make('Worker C', 'worker')
check('a new card at the ceiling is still refused', !extra.made, extra.said ?? 'it was created')

const started = await start(orch.id, a.id)
check('a stopped card on a full board can be started', started.code === 200, `${started.code} ${started.text}`)
check('and the answer is not the card-count refusal', !/at its limit of/.test(started.text), started.text)

await setLimits({ running: 1, cardsPerProject: 3, childrenPerCard: 4 })
const blocked = await start(orch.id, b.id)
check('the running ceiling still applies to a start', blocked.code === 409 && /already running/.test(blocked.text), `${blocked.code} ${blocked.text}`)

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
