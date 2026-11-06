/**
 * The acceptance test for the whole spine: a Claude session launched by Garden, driven the way
 * the owner drives it, watched through the board.
 *
 * Everything else stubs something. This stubs nothing: a real PTY, the real account shim, the
 * real CLI, real hooks, and a prompt typed into the terminal rather than posted at an endpoint.
 * If this passes, the app does what it claims when a person uses it.
 *
 * It costs one small prompt on the bound account. It runs in the owner's Garden project, since
 * that is where an account is already bound, and it deletes the card it created.
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

const st = { projects: [], sessions: [], events: [], output: '' }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'event') st.events.push(m.event)
  else if (m.t === 'session.data') st.output += m.data
  else if (m.t === 'error') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(900)

const project = st.projects.find((p) => p.path.toLowerCase() === 'c:\\garden')
check('the Garden project is on the board', !!project, project?.path)
if (!project) process.exit(1)
check('with an account bound to it, so nothing has to ask', !!project.profiles?.claude, String(project.profiles?.claude))

const title = `LiveClaude ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'claude', title }))
await sleep(2000)
const card = st.sessions.find((s) => s.title === title)
check('the card exists', !!card)
if (!card) process.exit(1)
const cur = () => st.sessions.find((s) => s.id === card.id)

const waitFor = async (label, predicate, ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(400)
  }
  return false
}

const started = await waitFor('start', () => st.events.some((e) => e.sessionId === card.id && e.type === 'SessionStart'), 60_000)
check('the CLI announced itself through the hooks', started, st.events.map((e) => e.type).join(',') || 'nothing')
if (!started) {
  console.log('   last 400 chars of the terminal:\n', st.output.slice(-400))
}

check('the card holds the CLI session id', !!cur()?.claudeSessionId, String(cur()?.claudeSessionId))
check('and the account it is actually running as', !!cur()?.profileId, String(cur()?.profileId))

// Type a prompt the way a person would, into the real terminal.
await sleep(2500)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'reply with the single word: ok' }))
await sleep(900)
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))

const working = await waitFor('working', () => cur()?.status === 'working', 45_000)
check('typing a prompt turns the card to working', working, `status ${cur()?.status}`)

const submitted = st.events.find((e) => e.sessionId === card.id && e.type === 'UserPromptSubmit')
check('the prompt itself was recorded', !!submitted, submitted ? 'recorded' : 'missing')

const settled = await waitFor('idle', () => cur()?.status === 'idle' || cur()?.status === 'needs-input', 120_000)
check('and the card settles when the turn ends', settled, `status ${cur()?.status}, waiting for ${cur()?.waitingFor}`)

/*
 * The context gauge, and the one thing this whole app refuses to do.
 *
 * The CLI publishes token counts in its transcript and nowhere else Garden can reach, and an
 * interactive session's transcript is not on disk when the turn ends. Measured here across three
 * live runs: the path the CLI itself reported still did not exist seventy seconds after Stop.
 *
 * So the gauge stays blank on a live session, and that is the correct behaviour rather than a
 * bug to paper over. What is tested is the rule: the number is either real or absent, never
 * estimated. A gauge that guessed how full a context was would be worse than no gauge, because
 * deciding when a session is too full to trust is the only reason to look at it.
 */
const gauge = cur()?.contextUsed
const honest = gauge === null || (typeof gauge === 'number' && gauge > 0 && gauge <= 1)
check('the gauge is either real or blank, never invented', honest,
  `contextUsed ${gauge}, tokens ${cur()?.tokensUsed}`)
if (gauge === null) {
  console.log('   NOTE: gauge blank, as expected on a live session. The transcript at')
  console.log(`   ${cur()?.transcriptPath}`)
  console.log('   had not been written yet. It fills once the CLI flushes that file.')
}

ws.send(JSON.stringify({ t: 'work.list', sessionId: card.id }))
await sleep(500)

console.log('   events seen:', [...new Set(st.events.filter((e) => e.sessionId === card.id).map((e) => e.type))].join(', '))

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(800)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
