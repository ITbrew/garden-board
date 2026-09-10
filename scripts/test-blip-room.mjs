/**
 * Opening a blip inserts space into the board, and closing it takes that space back.
 *
 * The webs belong directly under and over the card they came from, so the board has to make room
 * rather than the web going hunting for it. What is checked here is both halves: a card standing
 * where the block needs to go moves aside, and it comes back when the blip folds away. A version
 * that only did the first half would slowly push a board apart every time a blip was opened.
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

const dir = mkdtempSync(join(tmpdir(), 'garden-room-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
writeFileSync(join(dir, 'AGENTS.md'), '# agents\n')

const st = { projects: [], sessions: [], docs: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const stamp = Date.now().toString().slice(-5)
for (const n of ['Top', 'Below']) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: `${n} ${stamp}` }))
  await sleep(1800)
}
const top = st.sessions.find((s) => s.title === `Top ${stamp}`)
const below = st.sessions.find((s) => s.title === `Below ${stamp}`)
check('two cards to work with', !!top && !!below)
if (!top || !below) process.exit(1)

// Put the second card directly beneath the first, which is exactly where the file web wants to go.
ws.send(JSON.stringify({ t: 'session.move', sessionId: below.id, x: top.x, y: top.y + top.height + 60 }))
await sleep(700)
const cur = (id) => st.sessions.find((s) => s.id === id)
const parkedAt = cur(below.id).y
check('the second card sits under the first', parkedAt > cur(top.id).y, `${Math.round(parkedAt)}`)

ws.send(JSON.stringify({ t: 'context.open', sessionId: top.id }))
await sleep(2500)
const web = st.docs.filter((d) => d.ownerId === top.id && d.web === 'context')
check('the file web opened', web.length > 0, `${web.length} files`)

const pushedTo = cur(below.id).y
check('the card in the way was pushed down to make room', pushedTo > parkedAt,
  `${Math.round(parkedAt)} -> ${Math.round(pushedTo)}`)

// The block must sit under its owner, not wherever the board had space.
const nearest = Math.min(...web.map((d) => d.y))
check('and the files landed directly under their own card',
  nearest > cur(top.id).y && nearest < pushedTo,
  `files at ${Math.round(nearest)}, owner at ${Math.round(cur(top.id).y)}, neighbour at ${Math.round(pushedTo)}`)

// Nothing may overlap while the band is open.
const boxes = st.sessions.filter((s) => s.projectId === project.id).map((s) => ({ t: s.title, x: s.x, y: s.y, w: s.width, h: s.collapsed ? 38 : s.height }))
  .concat(st.docs.filter((d) => d.projectId === project.id).map((d) => ({ t: d.title, x: d.x, y: d.y, w: d.width, h: d.collapsed ? 38 : d.height })))
const collisions = []
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) collisions.push(`${a.t}/${b.t}`)
  }
}
check('nothing overlaps while the web is open', collisions.length === 0, collisions.slice(0, 3).join(' '))

/*
 * Adjacent, not merely somewhere free.
 *
 * The owner's words: a blip should expand directly above or below its card rather than landing
 * randomly far from it. A block that is technically placed and two screens away tells him nothing
 * about which card owns it, so the distance is what is checked here, not just the ordering.
 */
const ownerBottom = cur(top.id).y + cur(top.id).height
const gap = Math.min(...web.map((d) => d.y)) - ownerBottom
check('the block opens directly beneath its own card', gap >= 0 && gap < 200, `${Math.round(gap)}px below it`)
const widest = Math.max(...web.map((d) => Math.abs(d.x + d.width / 2 - (cur(top.id).x + cur(top.id).width / 2))))
check('and is centred on it rather than drifting sideways', widest < 2000, `${Math.round(widest)}px off centre`)

ws.send(JSON.stringify({ t: 'context.close', sessionId: top.id }))
await sleep(1200)
check('folding it away removed the files', st.docs.filter((d) => d.ownerId === top.id).length === 0)
check('and gave the space back', Math.abs(cur(below.id).y - parkedAt) < 2,
  `${Math.round(parkedAt)} -> ${Math.round(cur(below.id).y)}`)

for (const s of [top, below]) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(400)
}
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
