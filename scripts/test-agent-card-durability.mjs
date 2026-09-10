/**
 * A spawned agent's card is a card, with everything that implies.
 *
 * The owner's complaint, twice over: agents that vanish when they finish, and cards that are
 * second class because they came from an event rather than from him. So this checks the two
 * things that would make a subagent card a lie. It has to outlive its agent, its process, and a
 * client reconnect, and it has to carry its own two blips: the files it works from below it and
 * what it did above it. A card you cannot ask those questions of is a label, not a card.
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

async function hook(sessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(200)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-durable-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
writeFileSync(join(dir, 'AGENTS.md'), '# agents\n')

function connect() {
  const st = { projects: [], sessions: [], docs: [], wires: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    else if (m.t === 'session.removed') st.sessions = st.sessions.filter((s) => s.id !== m.sessionId)
    else if (m.t === 'doc.added') st.docs.push(m.card)
    else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
    // Held onto because opening history takes two steps: the days first, then one day by name.
    else if (m.t === 'history.groups') st.groups = m.groups
  })
  return { ws, st, ready: new Promise((r) => ws.on('open', r)) }
}

const a = connect()
await a.ready
a.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

a.ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = a.st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const title = `Durable ${Date.now().toString().slice(-5)}`
a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2000)
const parent = a.st.sessions.find((s) => s.title === title)
if (!parent) { console.log('FAIL  scratch card'); process.exit(1) }

const SID = `dur-${Date.now()}`
await hook(parent.id, { hook_event_name: 'SessionStart', session_id: SID })
await hook(parent.id, {
  hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p1',
  tool_name: 'Task', tool_use_id: 'tu-dur', tool_input: { description: 'audit the loader', subagent_type: 'Explore' },
})
await hook(parent.id, {
  hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p1',
  tool_use_id: 'tu-dur', agent_id: 'ag-dur', agent_type: 'Explore',
})
const child = a.st.sessions.find((s) => s.parentId === parent.id)
check('the agent got a card', !!child, child?.title)
if (!child) process.exit(1)

// --- its own two blips ---

a.ws.send(JSON.stringify({ t: 'context.open', sessionId: child.id }))
await sleep(2500)
const files = a.st.docs.filter((d) => d.ownerId === child.id && d.web === 'context')
check('it has its own bottom blip, holding the files it works from', files.length > 0, `${files.length} files`)
check('and they sit below it', files.every((d) => d.y > child.y), 'a file landed above its own card')

/*
 * Two steps: a bare `history.open` answers with the days the card has and draws nothing, and a day
 * is unfolded by name. See the `history.open` case in server/src/index.ts. Asking once and then
 * counting cards reported zero turns for a card that had taken one.
 */
a.st.groups = []
a.ws.send(JSON.stringify({ t: 'history.open', sessionId: child.id }))
await sleep(800)
for (const g of a.st.groups ?? []) {
  if (!g.group || g.group === 'conversation' || g.group === 'reports') continue
  a.ws.send(JSON.stringify({ t: 'history.open', sessionId: child.id, group: g.group }))
  await sleep(700)
}
await sleep(1600)
const history = a.st.docs.filter((d) => d.ownerId === child.id && d.web === 'history')
check('it has its own top blip, holding what it did', history.length > 0, `${history.length} turns`)
check('and that sits above it', history.every((d) => d.y < child.y), 'history landed below its own card')

// The two webs are independent: folding one must not disturb the other.
a.ws.send(JSON.stringify({ t: 'context.close', sessionId: child.id }))
await sleep(1200)
check('folding the files away leaves the history alone',
  a.st.docs.filter((d) => d.ownerId === child.id && d.web === 'history').length === history.length &&
  a.st.docs.filter((d) => d.ownerId === child.id && d.web === 'context').length === 0)

// --- it outlives the agent ---

await hook(parent.id, {
  hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag-dur',
  agent_transcript_path: 'C:/nonexistent/agent.jsonl',
})
const afterStop = a.st.sessions.find((s) => s.id === child.id)
check('the card is still there once the agent has finished', !!afterStop, afterStop?.status)
check('reading done rather than gone', afterStop?.status === 'done', String(afterStop?.status))

// --- and it outlives the client ---

a.ws.close()
await sleep(400)
const b = connect()
await b.ready
b.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(1200)
const reloaded = b.st.sessions.find((s) => s.id === child.id)
check('a fresh client is still handed the card', !!reloaded, reloaded?.title)
check('with its parent, its type and its transcript intact',
  reloaded?.parentId === parent.id && reloaded?.kind === 'subagent' && !!reloaded?.transcriptPath,
  `${reloaded?.kind}, transcript ${reloaded?.transcriptPath}`)
check('and its history web came back with it',
  b.st.docs.filter((d) => d.ownerId === child.id && d.web === 'history').length === history.length,
  `${b.st.docs.filter((d) => d.ownerId === child.id).length} cards`)
check('and the wire to whoever hired it',
  b.st.wires.some((w) => w.sourceId === parent.id && w.targetId === child.id))

b.ws.send(JSON.stringify({ t: 'session.delete', sessionId: parent.id }))
await sleep(700)
b.ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
b.ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
