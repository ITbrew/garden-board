/**
 * How a spawned agent lands on the board.
 *
 * The rule is the owner's: whoever dispatched sits to the left, whoever was dispatched sits to
 * the right, each step down the chain steps down the board, siblings stack rather than pile up,
 * and the wire between a parent and its child has a head at both ends because a dispatch is a
 * round trip. Position is meant to carry the hierarchy on its own, so this checks coordinates
 * rather than trusting that a wire exists.
 *
 * Every card must also own the notes directory that lets it get better at its particular job,
 * spawned agents included, which is the part that was missing entirely.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

const garden = await target()
const PORT = garden.port
/* The instance's own workspace, never the owner's ~/.garden. */
const GARDEN_HOME = garden.home ?? join(homedir(), '.garden')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(sessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(220)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-spawn-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'wire.added') st.wires.push(m.wire)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const title = `Spawn ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2000)
const lead = st.sessions.find((s) => s.title === title)
if (!lead) { console.log('FAIL  scratch card'); process.exit(1) }

const SID = `spawn-${Date.now()}`
await hook(lead.id, { hook_event_name: 'SessionStart', session_id: SID })

// One agent hiring three at once.
const spawn = async (parentId, tu, ag, type, desc) => {
  await hook(parentId, {
    hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p1',
    tool_name: 'Task', tool_use_id: tu, tool_input: { description: desc, subagent_type: type },
  })
  await hook(parentId, {
    hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p1',
    tool_use_id: tu, agent_id: ag, agent_type: type,
  })
  await sleep(300)
}

const kids = [
  ['tu-a', 'ag-a', 'Explore', 'map the call sites'],
  ['tu-b', 'ag-b', 'Plan', 'write the coding plan'],
  ['tu-c', 'ag-c', 'blind-reviewer', 'review the screen'],
]
for (const [tu, ag, type, desc] of kids) {
  await hook(lead.id, {
    hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p1',
    tool_name: 'Task', tool_use_id: tu, tool_input: { description: desc, subagent_type: type },
  })
  await hook(lead.id, {
    hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p1',
    tool_use_id: tu, agent_id: ag, agent_type: type,
  })
}

const children = st.sessions.filter((s) => s.parentId === lead.id)
check('three dispatches make three cards', children.length === 3, `${children.length} cards`)
check('each is wired to the agent that made it',
  children.every((c) => st.wires.some((w) => w.sourceId === lead.id && w.targetId === c.id)),
  `${st.wires.filter((w) => w.sourceId === lead.id).length} wires from the lead`)
check('and every one of those wires points both ways',
  children.every((c) => st.wires.find((w) => w.sourceId === lead.id && w.targetId === c.id)?.bidirectional === true),
  'a dispatch is a round trip')

check('children sit to the right of whoever made them',
  children.every((c) => c.x >= lead.x + lead.width),
  children.map((c) => `${c.title}@${Math.round(c.x)}`).join(' '))

const ys = children.map((c) => Math.round(c.y)).sort((a, b) => a - b)
check('siblings stack instead of landing on each other', new Set(ys).size === 3, ys.join(','))

// A subagent of a subagent: one step further right, and further down again.
const first = children.find((c) => c.role === 'Explore')
await hook(first.id, { hook_event_name: 'SessionStart', session_id: `sub-${Date.now()}` })
await hook(first.id, {
  hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p2',
  tool_name: 'Task', tool_use_id: 'tu-d', tool_input: { description: 'read the loader', subagent_type: 'Explore' },
})
await hook(first.id, {
  hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p2',
  tool_use_id: 'tu-d', agent_id: 'ag-d', agent_type: 'Explore',
})
const grandchild = st.sessions.find((s) => s.parentId === first.id)
check('a subagent can hire its own subagent', !!grandchild, grandchild?.title)
check('which lands further right again', grandchild && grandchild.x >= first.x + first.width,
  `${Math.round(grandchild?.x)} vs parent at ${Math.round(first.x)}`)
check('and further down, so depth reads top to bottom', grandchild && grandchild.y > first.y,
  `${Math.round(grandchild?.y)} vs parent at ${Math.round(first.y)}`)

/*
 * A card appears on the side it was summoned from.
 *
 * The rule generalises the blips: whichever dot a thing came out of decides which way it goes.
 * Roots open below, history opens above, and an agent appears on the side of its maker that faces
 * away from ITS maker, so a department growing leftward keeps growing leftward instead of doubling
 * back across itself. Checked by putting a card to the left of its maker and watching where its
 * own hire lands.
 */
const leftward = children.find((c) => c.role === 'Plan')
ws.send(JSON.stringify({
  t: 'session.move',
  sessionId: leftward.id,
  x: lead.x - leftward.width - 300,
  y: lead.y,
}))
await sleep(700)
const movedTo = st.sessions.find((s) => s.id === leftward.id)
check('a card can sit to the left of its maker', movedTo.x < lead.x, `${Math.round(movedTo.x)} vs ${Math.round(lead.x)}`)

await spawn(leftward.id, 'tu-l', 'ag-l', 'Explore', 'read the left branch')
const leftChild = st.sessions.find((s) => s.parentId === leftward.id)
check('and its own hire carries on in that direction', leftChild && leftChild.x < movedTo.x,
  `${Math.round(leftChild?.x)} vs its maker at ${Math.round(movedTo.x)}`)

// No card may cover another, which outranks every placement rule above.
const boxes = st.sessions.filter((s) => s.projectId === project.id)
  .map((s) => ({ t: s.title, x: s.x, y: s.y, w: s.width, h: s.collapsed ? 38 : s.height }))
const collisions = []
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) collisions.push(`${a.t}/${b.t}`)
  }
}
check('and nothing overlaps anything', collisions.length === 0, collisions.join(' '))

// Every card, spawned ones included, owns the directory it learns in.
const memRoot = join(GARDEN_HOME, 'memory')
/*
 * The project's exact slug, not a prefix match.
 *
 * Matching on a prefix found a directory left by an earlier run of this same test, since every
 * run is named garden-spawn-something, and then reported that cards had no memory when what had
 * actually happened was that it looked in the wrong folder. Check the harness before believing a
 * failure.
 */
const projSlug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
const memDirs = projSlug ? readdirSync(join(memRoot, projSlug)) : []
const hasMemory = (card) => {
  const d = memDirs.find((n) => n.endsWith(`-${card.id.slice(0, 8)}`))
  return !!d && existsSync(join(memRoot, projSlug, d, 'PLAYBOOK.md'))
}
check('the session has somewhere to keep what it learns', hasMemory(lead), memDirs.join(' '))
check('so does every agent it hired', children.every(hasMemory), `${memDirs.length} directories`)
check('and the agent that one hired', grandchild ? hasMemory(grandchild) : false)

for (const s of [lead]) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(500)
}
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
