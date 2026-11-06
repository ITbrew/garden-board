/**
 * An agent can bring a card into existence, and only one card decides.
 *
 * The failure this exists for, in the owner's words: "agents cant create cards, like if they need to
 * hire a card they ask me to do it or create wrong card type". `session.create` arrived only over
 * the WebSocket, which only his hands reach, so a card told to hire had nothing to call. What it did
 * instead was reach for the CLI's own Agent tool, which produces an untitled helper that lives
 * inside one turn and is gone when it ends, standing in for the full card he had asked for.
 *
 * The funnel is the other half. Every card that could hire was deciding its own fan-out and nothing
 * counted the total, so one request produced thirty-eight cards. Now exactly one card creates and
 * everything else asks it, which makes the asking visible on the board instead of happening in five
 * places that do not count each other.
 *
 * What is checked, and the middle one is the point: a worker's request creates NOTHING. If that ever
 * passes by creating a card, the funnel is decorative.
 *
 * Runs against a server of its own, on its own port with its own workspace, so it cannot touch the
 * owner's board.
 */
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

/** Found by the id suffix, the way the server finds it, so a renamed card keeps its directory. */
function briefOf(id) {
  const root = join(garden.home, 'memory')
  const suffix = id.slice(0, 8)
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name)
    for (const card of readdirSync(dir)) {
      if (card.endsWith(suffix)) return join(dir, card, 'CLAUDE.md')
    }
  }
  return join(root, `no-directory-ending-in-${suffix}`)
}

/**
 * Find the shim the way an agent would: by reading its own POWERS.md.
 *
 * Hardcoding the path here would hide the failure that actually matters. The send shim existed and
 * worked for a while and no agent ever used it, because nothing any agent could read said it was
 * there. A capability nobody is told about is the same as one that does not exist.
 */
function hireShimFromPowers(sessionId) {
  const powers = readIf(mailFile(sessionId, 'POWERS.md'))
  const m = powers.match(/node "([^"]+garden-hire\.mjs)"/)
  return m ? m[1] : null
}

/**
 * The card's own token, asked for the way the board asks for it.
 *
 * Garden puts this in the environment of a card it starts, and the shims send it as a bearer header
 * so the server resolves the sender from it rather than from the `from` field in the body. These
 * cards are created switched off and never start, so nothing hands them one and the test has to ask.
 * Without it every `hire` here is an unverified sender, which is accepted while the board is in
 * `shadow` and refused the moment anything enforces.
 */
const tokens = new Map()
async function tokenOf(id) {
  if (tokens.has(id)) return tokens.get(id)
  ws.send(JSON.stringify({ t: 'session.token', sessionId: id }))
  for (let i = 0; i < 20 && !tokens.has(id); i++) await sleep(100)
  return tokens.get(id) ?? ''
}

/** Run it exactly as an agent would, from inside a session's environment, roots on stdin. */
async function hire(fromId, args, roots) {
  const token = await tokenOf(fromId)
  return new Promise((done) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
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
    child.on('close', (code) => done({ ok: code === 0, message: String(code === 0 ? out : err || out).trim() }))
    child.stdin.end(roots ?? '')
  })
}

const dir = mkdtempSync(join(tmpdir(), 'garden-hire-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [], events: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
  else if (m.t === 'event') st.events.push(m.event)
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

const make = async (title, roleClass, reportsTo = null) => {
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

// --- a board with nobody who may create ---

/*
 * Checked first, before an orchestrator exists, because this is the state every board starts in and the
 * one the owner will meet if he sets up a chain and forgets the card at the top of it. The refusal
 * has to say what to do about it, not merely that it did not work: an agent reading "refused" with
 * no remedy will go and improvise one, which is how the CLI's own Agent tool ends up standing in for
 * a card again.
 */
const lonely = await make('Lonely manager', 'manager')

/*
 * The shim is found by reading the card's own POWERS.md rather than being hardcoded here.
 *
 * Hardcoding it would hide the failure that actually matters. The send shim existed and worked for
 * a while and no agent ever used it, because nothing any agent could read said it was there. A
 * capability nobody is told about is the same as one that does not exist.
 */
const SHIM = hireShimFromPowers(lonely.id)
check('a card is told how to ask for a card, in a file it can read', !!SHIM, SHIM ?? 'POWERS.md names no command')
if (!SHIM) {
  await garden.stop()
  process.exit(1)
}

const nobody = await hire(
  lonely.id,
  ['--title', 'Anyone', '--role', 'worker'],
  'A card that owns the import path.',
)
await sleep(400)
check('with no orchestrator on the board, a hire is refused', !nobody.ok, nobody.message)
check('and the refusal says an orchestrator is what is missing', /orchestrator/i.test(nobody.message), nobody.message)
check('and nothing was created', !st.sessions.some((s) => s.title === 'Anyone'))

const orchestrator = await make('Orchestrator', 'orchestrator')
const worker = await make('Worker', 'worker', orchestrator.id)
check('an orchestrator and a worker', !!orchestrator && !!worker)

// --- a worker asks, and nothing is created ---

const before = st.sessions.length
const asked = await hire(
  worker.id,
  ['--title', 'Loader specialist', '--role', 'worker'],
  'You own src/loader and nothing else. Defer anything about the parser to the Parser card.',
)
await sleep(600)
check('a worker may run the command at all', asked.ok, asked.message)
check('and is told plainly that nothing was created', /filed|nothing has been created/i.test(asked.message), asked.message)
check('NOTHING was created', st.sessions.length === before, `${st.sessions.length} cards, was ${before}`)
check('the request reached the orchestrator inbox', readIf(mailFile(orchestrator.id, 'INBOX.md')).includes('Loader specialist'))
check('carrying the roots it asked for', readIf(mailFile(orchestrator.id, 'INBOX.md')).includes('src/loader'))
check('and the worker own record shows it asked', readIf(mailFile(worker.id, 'SENT.md')).includes('Loader specialist'))
/*
 * This worker already reports to the orchestrator, so the reporting wire carries the request and no
 * second line is drawn between the same two cards. Four siblings drawing six wires between agents
 * that never spoke is the mess the owner watched happen, so reusing what is there is the point.
 */
const between = (a, b) => st.wires.some((w) => (w.sourceId === a && w.targetId === b) || (w.sourceId === b && w.targetId === a))
check('the request travelled on a wire that already existed', between(worker.id, orchestrator.id))
check('and no duplicate line was drawn beside it', st.wires.filter((w) => between(worker.id, orchestrator.id) && (w.sourceId === worker.id || w.targetId === worker.id)).length === 1)
check('and the request is recorded as structured', st.events.some((e) => e.type === 'hire.requested' && e.provenance === 'structured'))

// --- a card with no line to the orchestrator gets one, so the asking is visible ---

const stranger = await make('Stranger', 'manager')
check('a card wired to nobody', !!stranger && !between(stranger.id, orchestrator.id))
const strangerAsked = await hire(
  stranger.id,
  ['--title', 'Someone else', '--role', 'worker'],
  'A card that owns the export path.',
)
await sleep(600)
check('it can still ask', strangerAsked.ok, strangerAsked.message)
check('and a wire is drawn for the request to travel on', st.wires.some((w) => w.label === 'hire request'))
check('but still nothing was created', !st.sessions.some((s) => s.title === 'Someone else'))

// --- the orchestrator asks, and a card exists ---

const granted = await hire(
  orchestrator.id,
  ['--title', 'Loader specialist', '--role', 'worker', '--reports-to', worker.id, '--owns', 'src/loader'],
  'You own src/loader and nothing else. Defer anything about the parser to the Parser card.',
)
await sleep(900)
check('the orchestrator may create', granted.ok, granted.message)

const made = st.sessions.find((s) => s.title === 'Loader specialist')
check('and the card is really on the board', !!made)
check('created switched off, so hiring never quietly spends a window', made?.status === 'stopped', made?.status)
check('with the role it was hired as', made?.roleClass === 'worker', String(made?.roleClass))
check('answering to the card it was given', made?.reportsTo === worker.id)
check('and recorded as that card child, so the count can find it', made?.parentId === worker.id)
check('owning only what it was given', JSON.stringify(made?.ownedPaths) === JSON.stringify(['src/loader']), JSON.stringify(made?.ownedPaths))

// --- and it starts life knowing what it is ---

const brief = readIf(briefOf(made.id))
check('the new card has a CLAUDE.md of its own', brief.length > 0)
check('holding the roots the hirer wrote for it', brief.includes('You own src/loader'), brief.slice(-160))
check('under the line Garden maintains, not over it', brief.indexOf('Below this line is yours') < brief.indexOf('You own src/loader'))
check('and Garden half still states the role', /\*\*worker\*\*/.test(brief))
check('its powers and peers landed too', readIf(mailFile(made.id, 'POWERS.md')).length > 0 && readIf(mailFile(made.id, 'PEERS.md')).length > 0)

// --- roots are not optional, because a card without them answers as the project ---

const rootless = await hire(orchestrator.id, ['--title', 'Nobody', '--role', 'worker'], '')
check('a hire with no roots is refused', !rootless.ok, rootless.message)
check('and says why rather than just failing', /roots/i.test(rootless.message), rootless.message.split('\n')[0])
check('and created nothing', !st.sessions.some((s) => s.title === 'Nobody'))

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
