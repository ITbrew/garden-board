/**
 * A send says what became of it, and "delivered" has to mean delivered.
 *
 * The failure this exists for: `POST /mail` appended to the inbox, wrote SENT.md, answered the
 * sender "delivered to X", and only then tried to wake the card. So the word meant "a file was
 * written", which is not what it means to the agent reading it. A card with no process, a card
 * mid-restart, and a card that read the message and replied all produced the same sentence and the
 * same permanent record, so a card reviewing its own SENT.md to work out whether it had been
 * answered could not tell them apart.
 *
 * Underneath it, `ptys.write` was a bare optional chain with no return value and no try/catch. A
 * write to a session that was not live vanished silently, which is the exact shape of failure this
 * app exists to refuse, sitting in the one function every delivery goes through.
 *
 * Checked against a stopped card rather than a mocked one, because the interesting case is the one
 * the owner actually hit: a card that is on the board, wired, and not running.
 *
 * Runs against a server of its own, on its own port with its own workspace.
 */
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const mailFile = (id, name) => join(garden.home, 'mail', id, name)
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

function shimFromPeers(sessionId) {
  const peers = readIf(mailFile(sessionId, 'PEERS.md'))
  const m = peers.match(/node "([^"]+garden-send\.mjs)"/)
  return m ? m[1] : null
}

/**
 * The card's own token, asked for the way the board asks for it.
 *
 * Garden puts this in the environment of a card it starts, and `garden-send.mjs` sends it as a bearer
 * header so the server resolves the sender from the token rather than from the `from` field in the
 * body. The cards here are created switched off on purpose, so nothing hands them one and this asks.
 * Without it every message below is an unverified sender: accepted while the board is in `shadow`,
 * refused the moment anything enforces.
 */
const tokens = new Map()
async function tokenOf(id) {
  if (tokens.has(id)) return tokens.get(id)
  ws.send(JSON.stringify({ t: 'session.token', sessionId: id }))
  for (let i = 0; i < 20 && !tokens.has(id); i++) await sleep(100)
  return tokens.get(id) ?? ''
}

/*
 * Exactly as an agent runs it, with the message on stdin so no quote can truncate it.
 *
 * Spawned rather than execFile'd because execFile has no `input` option: that belongs to the sync
 * variant, and passing it to the async one is silently ignored, so the shim sat waiting on a pipe
 * nothing ever wrote to and timed out after ten seconds.
 */
async function send(fromId, to, text, shim) {
  const token = await tokenOf(fromId)
  return new Promise((done) => {
    const child = spawn(process.execPath, [shim, '--to', to, '--kind', 'question'], {
      env: {
        ...process.env,
        GARDEN_SESSION_ID: fromId,
        GARDEN_SESSION_TOKEN: token,
        GARDEN_PORT: String(PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (err += b))
    child.on('close', (code) =>
      done({ ok: code === 0, message: String(code === 0 ? out : err || out).trim() }),
    )
    child.stdin.end(text)
  })
}

const dir = mkdtempSync(join(tmpdir(), 'garden-wake-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    const i = st.sessions.findIndex((s) => s.id === m.session.id)
    if (i >= 0) st.sessions[i] = m.session
  } else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
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

const make = async (title, roleClass, reportsTo) => {
  ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: project.id,
      adapterId: 'shell',
      title,
      roleClass,
      reportsTo,
      start: false,
    }),
  )
  await sleep(700)
  return st.sessions.find((s) => s.title === title)
}

const manager = await make('Manager', 'manager', null)
const worker = await make('Worker', 'worker', manager.id)
check('two cards, wired by the reporting line', !!manager && !!worker && st.wires.length > 0)

const shim = shimFromPeers(manager.id)
check('the manager is told how to send', !!shim)
if (!shim) {
  await garden.stop()
  process.exit(1)
}

// --- a send to a card with no process ---

const cold = await send(manager.id, 'Worker', 'Can you take the loader?', shim)
check('the send itself succeeds', cold.ok, cold.message)
check('and it landed in the inbox', readIf(mailFile(worker.id, 'INBOX.md')).includes('loader'))

/*
 * The heart of it. The old answer was the single word "delivered to Worker" for every case. A
 * `shell` card can be started, so this one is honestly reported as started rather than as read: the
 * point is that the sender is never told a stopped card has been told something.
 */
check(
  'the answer says what actually happened rather than "delivered"',
  !/^delivered to Worker$/.test(cold.message),
  cold.message,
)
check(
  'and names the real state of the other card',
  /(starting|filed|not running|inbox|busy)/i.test(cold.message),
  cold.message,
)

const sent = readIf(mailFile(manager.id, 'SENT.md'))
check('the sender own record carries the outcome too', /card was|filed in|nothing is reading|busy/i.test(sent), sent.split('\n').find((l) => /kind `question`/.test(l)) ?? sent.slice(0, 160))
check(
  'so a card reading its own SENT.md can tell told from merely written',
  !/kind `question`\.\s*$/m.test(sent),
)

// --- a send to a card the owner has closed ---

await sleep(2500)
ws.send(JSON.stringify({ t: 'session.close', sessionId: worker.id }))
await sleep(800)

const closed = await send(manager.id, 'Worker', 'And the second one?', shim)
check('a send to a closed card still succeeds', closed.ok, closed.message)
check('but says plainly that nobody is reading', /closed|nobody is reading/i.test(closed.message), closed.message)
check('and the message is still filed rather than dropped', readIf(mailFile(worker.id, 'INBOX.md')).includes('second one'))

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
