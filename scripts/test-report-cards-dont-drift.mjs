/**
 * Proves task-completion reports no longer auto-open and no longer drift the board apart.
 *
 * Two bugs, found the same night. First: every "done" a worker sent its orchestrator used to shove
 * every earlier report card further away, unconditionally, forever — two survivors on the owner's
 * real board had ended up 36,412 pixels apart after 643 recorded turns. Second, once that was fixed:
 * the owner did not want reports appearing on their own at all — "i dont want it to auto open
 * history" — so they now work the same way a day of turns does, a "Reports" pill that draws nothing
 * until it is opened by hand.
 *
 * Fires a real "done" through the actual `/mail` endpoint N times for one orchestrator, the same
 * path a worker card uses, and checks: nothing is drawn while that happens, the pill promises the
 * right count, opening it draws a capped set, and opening/closing/reopening it repeatedly does not
 * drift the block — the same failure mode as before, just triggered by re-opening the pill instead
 * of by every completion.
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

const dir = mkdtempSync(join(tmpdir(), 'garden-reportdrift-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], docs: [], groups: null }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.updated') st.docs = st.docs.map((d) => (d.id === m.card.id ? m.card : d))
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'history.groups') st.groups = m
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('scratch project added', !!project)
if (!project) process.exit(1)

const stamp = Date.now().toString().slice(-5)
for (const n of ['Orchestrator', 'Worker']) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: `${n} ${stamp}` }))
  await sleep(1800)
}
const orch = st.sessions.find((s) => s.title === `Orchestrator ${stamp}`)
const worker = st.sessions.find((s) => s.title === `Worker ${stamp}`)
check('an orchestrator and a worker to wire together', !!orch && !!worker)
if (!orch || !worker) process.exit(1)

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: orch.id, roleClass: 'orchestrator' }))
await sleep(400)
ws.send(JSON.stringify({
  t: 'wire.create', projectId: project.id, sourceId: worker.id, targetId: orch.id, label: 'reports to',
}))
await sleep(700)

const reportCards = () => st.docs.filter((d) => d.ownerId === orch.id && d.web === 'history')

const send = async (i) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: worker.id,
      to: orch.id,
      kind: 'done',
      taskId: `drift-${stamp}-${i}`,
      text: `finished step ${i}`,
    }),
  })
  await res.text()
  await sleep(300)
}

const N = 15
for (let i = 0; i < N; i++) await send(i)

check(
  `${N} completions drew nothing on their own`,
  reportCards().length === 0,
  `${reportCards().length} cards appeared without the pill being opened`,
)

st.groups = null
ws.send(JSON.stringify({ t: 'history.groups', sessionId: orch.id }))
await sleep(1000)
const pill = st.groups?.groups?.find((g) => g.group === 'reports')
check('the pill promises every completion, not just the kept ones', pill?.count === N, JSON.stringify(pill))

// --- opening the pill draws a capped set ------------------------------------------------------

ws.send(JSON.stringify({ t: 'history.open', sessionId: orch.id, group: 'reports' }))
await sleep(1200)
check(
  'opening the pill draws a capped set',
  reportCards().length > 0 && reportCards().length <= 8, // REPORT_CAP (6) + the archive card + slack
  `${reportCards().length} cards`,
)

// --- opening it again and again must not drift the block --------------------------------------

const topY = () => Math.min(...reportCards().map((d) => d.y))
const yAtOpen = [topY()]
for (let round = 0; round < 5; round++) {
  ws.send(JSON.stringify({ t: 'history.open', sessionId: orch.id, group: 'reports' }))
  await sleep(1000)
  yAtOpen.push(topY())
}

const drift = Math.max(...yAtOpen) - Math.min(...yAtOpen)
check(
  're-opening the same pill repeatedly does not drift the block',
  drift < 50,
  `topmost y varied by ${drift}px across ${yAtOpen.length} opens: ${JSON.stringify(yAtOpen)}`,
)

// --- closing it takes the reports off the board, and it can be opened again -------------------

ws.send(JSON.stringify({ t: 'history.closeGroup', sessionId: orch.id, group: 'reports' }))
await sleep(1000)
check('folding the pill takes its cards off the board', reportCards().length === 0, `${reportCards().length} cards`)

ws.close()
await garden.stop?.()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
