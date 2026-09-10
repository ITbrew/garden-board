/**
 * The complaint this whole app exists to answer, tested for real.
 *
 * The owner ran two agents concurrently and could not tell they were working, or that they had
 * ever existed. Everything else in the suite proves the machinery with synthetic payloads. This
 * proves the thing itself: a Claude session launched by Garden, given a prompt that makes it hire
 * an agent, and a card appearing on the board for that agent, from the CLI's own events, with no
 * payload posted by hand anywhere in the path.
 *
 * It costs one real dispatch on the bound account, so it is not part of the fast suite. Run it
 * after any change to the adapter, the hook installer, the receiver or the ingest.
 */
import WebSocket from 'ws'
import { target } from './lib/target.mjs'
import { seedRealProject } from './lib/live.mjs'

const garden = await target()
const PORT = garden.port
/*
 * A real folder and a real account, on this instance rather than on the owner's board.
 *
 * This test drives an actual Claude CLI, which the server refuses to launch without an account
 * bound to the project. It used to get that by connecting to his live board, where he had set it
 * up by hand, which is why it was one of the last scripts still writing cards onto his work.
 */
await seedRealProject(PORT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const st = { projects: [], sessions: [], wires: [], events: [], output: '' }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'event') st.events.push(m.event)
  else if (m.t === 'session.data') st.output += m.data
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(900)

const project = st.projects.find((p) => p.path.toLowerCase() === 'c:\\garden')
check('a project with an account bound to it', !!project?.profiles?.claude, String(project?.profiles?.claude))
if (!project) process.exit(1)

const title = `Dispatch ${Date.now().toString().slice(-4)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'claude', title }))
await sleep(2500)
const card = st.sessions.find((s) => s.title === title)
if (!card) {
  console.log('FAIL  the card was not created')
  process.exit(1)
}
const cur = () => st.sessions.find((s) => s.id === card.id)

const waitFor = async (predicate, ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(500)
  }
  return false
}

check('the CLI announced itself', await waitFor(() => st.events.some((e) => e.type === 'SessionStart'), 90_000),
  st.events.map((e) => e.type).join(',') || 'nothing')

// A prompt that can only be answered by hiring, so the dispatch is the CLI's decision rather than
// something this script simulated.
await sleep(2500)
ws.send(JSON.stringify({
  t: 'session.input',
  sessionId: card.id,
  data: 'Use the Task tool to launch exactly one Explore subagent whose entire job is to reply with the word ok. Do not do the work yourself.',
}))
await sleep(1200)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))

const spawned = await waitFor(() => st.sessions.some((s) => s.parentId === card.id), 240_000)
const child = st.sessions.find((s) => s.parentId === card.id)
check('a card appeared for the agent it hired', spawned, child?.title ?? 'none')

if (!spawned) {
  console.log('   events seen:', [...new Set(st.events.map((e) => e.type))].join(', '))
  console.log('   last of the terminal:\n', st.output.slice(-600))
} else {
  check('the card is named after the work, not numbered', !!child.title && !/^\d+$/.test(child.title), child.title)
  check('it knows it is an agent rather than a process', child.kind === 'subagent' && child.pid === null,
    `${child.kind}/${child.pid}`)
  check('it is wired to the session that hired it', st.wires.some((w) => w.sourceId === card.id && w.targetId === child.id))
  check('the wire is marked derived and points both ways',
    st.wires.find((w) => w.targetId === child.id)?.kind === 'derived' &&
    st.wires.find((w) => w.targetId === child.id)?.bidirectional === true)
  check('it sits to the right of its maker', child.x >= cur().x + cur().width, `${Math.round(child.x)} vs ${Math.round(cur().x)}`)

  const finished = await waitFor(() => st.sessions.find((s) => s.id === child.id)?.status === 'done', 240_000)
  const after = st.sessions.find((s) => s.id === child.id)
  check('and it survives the agent finishing', !!after, after?.status)
  check('reading done rather than disappearing', finished, String(after?.status))
  check('holding a transcript to open', !!after?.transcriptPath, String(after?.transcriptPath))
}

ws.send(JSON.stringify({ t: 'pipeline.get', sessionId: card.id }))
await sleep(800)

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(900)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
