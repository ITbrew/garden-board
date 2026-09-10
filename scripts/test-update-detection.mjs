/**
 * What Garden knows about a card running an old CLI, and nothing it does about it.
 *
 * The stage under test only knows and answers. Nothing in the server ends, starts, restarts or
 * resumes a card because of anything measured here, and this script asserts that separately rather
 * than trusting it: the only thing that stops or starts a card below is this script, by hand, to
 * make a generation change happen.
 *
 * Its own instance, its own port, its own GARDEN_HOME, its own database, its own CLAUDE_CONFIG_DIR
 * and its own CODEX_HOME. Nothing it does can reach the owner's board, and the two config
 * directories matter as much as the workspace: the version read walks the CLI's session registry
 * and the Codex read opens `version.json`, so a test pointed at the real ones would be asserting
 * against whatever the owner happens to have running.
 *
 * Two of the assertions here were watched fail first, against a build with the guard removed, and
 * the failure each one catches is named where it is made.
 *
 * Needs `npm run build` first: the instance launches the built server, not the TypeScript.
 */
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let skipped = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + String(d).replace(/\s+/g, ' ').slice(0, 170) : ''}`)
  if (!ok) failures++
}
const skip = (n, why) => {
  console.log(`SKIP  ${n}  -- ${why}`)
  skipped++
}

/*
 * Set before the instance is started, because the server reads all three out of its environment and
 * `startInstance` hands it whatever this process has. The delay is the one that decides how long
 * after the text an automatic Enter follows: five seconds rather than sixty milliseconds so the
 * generation guard below is watched rather than raced. A test that has to restart a card inside
 * sixty milliseconds passes or fails on scheduling, and this board has already shipped one
 * assertion that passed for the wrong reason.
 */
const CLI_HOME = mkdtempSync(join(tmpdir(), 'garden-upd-cli-'))
const CODEX_HOME = mkdtempSync(join(tmpdir(), 'garden-upd-codex-'))
const TRANSCRIPTS = mkdtempSync(join(tmpdir(), 'garden-upd-tx-'))
mkdirSync(join(CLI_HOME, 'sessions'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = CLI_HOME
process.env.CODEX_HOME = CODEX_HOME
process.env.GARDEN_INPUT_DELAY_MS = '5000'

const { startInstance } = await import('./lib/instance.mjs')
const { boundaryFrom, updateStateFor, codexUpdateState } = await import('../server/dist/update.js')

const home = mkdtempSync(join(tmpdir(), 'garden-upd-home-'))
const dir = mkdtempSync(join(tmpdir(), 'garden-upd-proj-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const garden = await startInstance({ home })
const PORT = garden.port

const keyFile = join(home, 'owner.key')
let ownerKey = ''
for (let i = 0; i < 40 && !ownerKey; i++) {
  try {
    ownerKey = readFileSync(keyFile, 'utf8').trim()
  } catch {
    await sleep(100)
  }
}
if (!ownerKey) {
  console.log('FAIL  the scratch server never wrote an owner key')
  process.exit(1)
}

/**
 * What the executables on this machine actually say, asked without going through the code under
 * test. The reference value has to come from the machine, or the assertion is the feature agreeing
 * with itself.
 *
 * Windows makes that more work than it should be. `where claude` lists an extensionless shim first
 * and a `.cmd` second, and node will run neither: no executable extension for the first, and
 * spawning `.cmd` without a shell has been refused since CVE-2024-27980 was closed. So: the real
 * executable if there is one, and a batch shim through `cmd.exe` if there is not.
 */
function versionOf(command) {
  let hits = []
  try {
    hits = execFileSync('where', [command], { encoding: 'utf8', timeout: 5000 })
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && existsSync(s))
  } catch {
    return null
  }
  const exe = hits.find((h) => /\.(exe|com)$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h))
  if (!exe) return null
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' }
  try {
    const out = /\.(cmd|bat)$/i.test(exe)
      ? execFileSync('cmd.exe', ['/d', '/c', exe, '--version'], { encoding: 'utf8', timeout: 20000, env })
      : execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000, env })
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    return m ? m[1] : null
  } catch {
    return null
  }
}
const CLAUDE_VERSION = versionOf('claude')
const CODEX_VERSION = versionOf('codex')
console.log(`      claude on this machine: ${CLAUDE_VERSION ?? 'not on PATH'}; codex: ${CODEX_VERSION ?? 'not on PATH'}`)

// ---------------------------------------------------------------------------
// A connection, and a way to read the board back with the update state on it
// ---------------------------------------------------------------------------

const seen = { events: [], answers: [] }
let ws

async function connect(collect) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const state = { sessions: [], projects: [], channels: [] }
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      state.sessions = m.sessions
      state.projects = m.projects
      state.channels = m.channels ?? []
    } else if (m.t === 'session.added') state.sessions.push(m.session)
    else if (m.t === 'session.updated') {
      state.sessions = state.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    } else if (m.t === 'channel.added') state.channels.push(m.channel)
    else if (m.t === 'event' && collect) seen.events.push(m.event)
    else if (collect) seen.answers.push(m)
  })
  await new Promise((r) => socket.on('open', r))
  socket.send(JSON.stringify({ t: 'hello', key: ownerKey }))
  await sleep(600)
  return { socket, state }
}

/**
 * The board as a client sees it, on a connection of its own.
 *
 * A fresh connection rather than the long-lived one, because the version state is attached on the
 * way out and never stored, so the only way to see it change is to be sent the board again.
 */
async function readBoard() {
  const { socket, state } = await connect(false)
  await sleep(200)
  socket.close()
  return state
}

const main = await connect(true)
ws = main.socket

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const board0 = await readBoard()
const project = board0.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  the scratch project was not added')
  process.exit(1)
}

const stamp = Date.now().toString().slice(-5)
const CARDS = [
  { title: `Ver ${stamp}`, adapterId: 'claude', roleClass: 'worker', start: false },
  { title: `Cod ${stamp}`, adapterId: 'codex', roleClass: 'worker', start: false },
  { title: `Off ${stamp}`, adapterId: 'shell', roleClass: 'worker', start: false },
  { title: `Chief ${stamp}`, adapterId: 'shell', roleClass: 'orchestrator', start: false },
  { title: `Hand ${stamp}`, adapterId: 'shell', roleClass: 'worker', start: true },
]
for (const spec of CARDS) {
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: spec.adapterId,
    title: spec.title,
    roleClass: spec.roleClass,
    start: spec.start,
  }))
  await sleep(1200)
}
let board = await readBoard()
const byTitle = (t) => board.sessions.find((s) => s.title === t)
const ver = byTitle(CARDS[0].title)
const cod = byTitle(CARDS[1].title)
const off = byTitle(CARDS[2].title)
const chief = byTitle(CARDS[3].title)
const hand = byTitle(CARDS[4].title)
if (!ver || !cod || !off || !chief || !hand) {
  console.log('FAIL  the five cards were not created')
  process.exit(1)
}

const db = new Database(join(home, 'garden.db'))

/** A conversation on disk under this card's name, which is what makes a card resumable. */
function giveConversation(card) {
  const id = randomUUID()
  const path = join(TRANSCRIPTS, `${id}.jsonl`)
  writeFileSync(path, '{"type":"summary"}\n', 'utf8')
  db.prepare('UPDATE sessions SET claudeSessionId = ?, transcriptPath = ? WHERE id = ?')
    .run(id, path, card.id)
  return id
}

/**
 * One entry in the CLI's own registry, written the way the CLI writes it.
 *
 * The pid is this test's own, because the read only counts an entry whose process is alive and the
 * one process this script can be certain about is itself. Nothing here opens or writes the
 * `<pid>.<hash>.key` that sits beside a real entry: that file holds a peer token, and the point of
 * this whole feature is that nothing Garden reads or writes ever carries one.
 */
function writeRegistryEntry(conversationId, version) {
  writeFileSync(
    join(CLI_HOME, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: conversationId,
      version,
      cwd: dir,
      status: 'running',
      updatedAt: Date.now(),
    }),
    'utf8',
  )
}

/** The read is cached for three seconds, so a change has to be given longer than that to be seen. */
const pastCache = () => sleep(3400)

// ---------------------------------------------------------------------------
// 1. The two versions, and what "pending" is allowed to mean
// ---------------------------------------------------------------------------

if (!CLAUDE_VERSION) {
  skip('the installed version is read off the executable', 'claude is not on PATH on this machine')
} else {
  const card = board.sessions.find((s) => s.id === ver.id)
  check('the installed version is read off the executable', card.installedVersion === CLAUDE_VERSION,
    `card says ${card.installedVersion}, the executable says ${CLAUDE_VERSION}`)
}

check('a card with no conversation has no running version and is not pending',
  ver.runningVersion === null && ver.updatePending === false,
  `running ${JSON.stringify(ver.runningVersion)} pending ${ver.updatePending}`)

const verConversation = giveConversation(ver)
writeRegistryEntry(verConversation, '0.0.1')
await pastCache()
board = await readBoard()
let verNow = board.sessions.find((s) => s.id === ver.id)

/*
 * The whole feature in one assertion. A process that recorded 0.0.1 for itself, an executable on
 * disk that says something else, and a card that says so without anything having read a word of
 * terminal output. The failure it catches is the one this replaces: a card left running an old
 * build for nine hours with the only notice of it drawn in a status line nothing can read.
 */
if (!CLAUDE_VERSION) {
  skip('a running version older than the installed one is pending', 'claude is not on PATH')
} else {
  check('a running version older than the installed one is pending',
    verNow.runningVersion === '0.0.1' && verNow.installedVersion === CLAUDE_VERSION && verNow.updatePending === true,
    `${verNow.runningVersion} vs ${verNow.installedVersion}, pending ${verNow.updatePending}`)
  check('a pending card with a conversation on disk is eligible',
    verNow.updateEligible === true && verNow.updateReason === null,
    `eligible ${verNow.updateEligible} reason ${JSON.stringify(verNow.updateReason)}`)

  writeRegistryEntry(verConversation, CLAUDE_VERSION)
  await pastCache()
  board = await readBoard()
  verNow = board.sessions.find((s) => s.id === ver.id)
  check('a card running the installed version is not pending',
    verNow.runningVersion === CLAUDE_VERSION && verNow.updatePending === false,
    `${verNow.runningVersion} vs ${verNow.installedVersion}, pending ${verNow.updatePending}`)
}

/*
 * Unknown is never pending, in either direction, and both directions are checked because they come
 * from different nulls: a registry with nothing live in it, and an executable that will not answer.
 * The second cannot be produced on a machine where the CLI works, so it is asserted against the
 * function that decides, which is where the rule actually lives.
 */
check('an unknown running version is not pending',
  updateStateFor({ adapterId: 'claude', runningVersion: null, installedVersion: '9.9.9', resumeId: 'x' }).updatePending === false)
check('an unknown installed version is not pending',
  updateStateFor({ adapterId: 'claude', runningVersion: '1.0.0', installedVersion: null, resumeId: 'x' }).updatePending === false)
check('two versions that differ are pending',
  updateStateFor({ adapterId: 'claude', runningVersion: '1.0.0', installedVersion: '1.0.1', resumeId: 'x' }).updatePending === true)

check('a card with no conversation to reopen is not eligible, and says why',
  off.updateEligible === false && off.updateReason === 'no conversation to resume',
  `${off.updateEligible} ${JSON.stringify(off.updateReason)}`)

// ---------------------------------------------------------------------------
// 2. Codex, which is never pending whatever its versions say
// ---------------------------------------------------------------------------

/*
 * Watched fail first. With `updatePending` computed from the versions alone, a Codex card whose
 * recorded version differs reads as pending, which on a board that later acts on the flag would
 * restart a card Garden cannot resume and lose the whole conversation. The build with that one
 * ternary removed fails this assertion and only this one.
 */
check('a Codex card whose two versions differ is still not pending',
  updateStateFor({ adapterId: 'codex', runningVersion: '0.1.0', installedVersion: '0.2.0', resumeId: null }).updatePending === false,
  JSON.stringify(updateStateFor({ adapterId: 'codex', runningVersion: '0.1.0', installedVersion: '0.2.0', resumeId: null })))

/*
 * The same rule on the board, and it is worth saying what this one does and does not prove. A Codex
 * card has no running version at all, because the registry the running version is read from is the
 * Claude CLI's and Codex does not keep one. So this assertion would hold even with the rule above
 * deleted, which is why the rule is asserted against the function that carries it as well.
 */
const codNow = board.sessions.find((s) => s.id === cod.id)
check('a Codex card on the board is not pending', codNow.updatePending === false,
  `pending ${codNow.updatePending}, running ${codNow.runningVersion}, installed ${codNow.installedVersion}`)
check('a Codex card is not eligible, because there is no conversation to reopen',
  codNow.updateEligible === false && String(codNow.updateReason).startsWith('no conversation to resume'),
  JSON.stringify(codNow.updateReason))

if (!CODEX_VERSION) {
  skip('Codex\'s own record of an available update is carried into the reason', 'codex is not on PATH')
} else {
  writeFileSync(
    join(CODEX_HOME, 'version.json'),
    JSON.stringify({ latest_version: '99.0.0', last_checked_at: new Date().toISOString() }),
    'utf8',
  )
  const readBack = codexUpdateState(CODEX_HOME)
  check('Codex\'s own version file is read for what it records',
    readBack.latestVersion === '99.0.0' && readBack.dismissedVersion === null,
    JSON.stringify(readBack))

  board = await readBoard()
  const withLatest = board.sessions.find((s) => s.id === cod.id)
  check('Codex\'s own record of an available update is carried into the reason',
    withLatest.updateReason === 'no conversation to resume, and Codex records 99.0.0 as available',
    JSON.stringify(withLatest.updateReason))

  writeFileSync(
    join(CODEX_HOME, 'version.json'),
    JSON.stringify({ latest_version: '99.0.0', dismissed_version: '99.0.0' }),
    'utf8',
  )
  board = await readBoard()
  const dismissed = board.sessions.find((s) => s.id === cod.id)
  check('a version the owner has dismissed is reported as dismissed rather than offered again',
    dismissed.updateReason === 'no conversation to resume, and Codex records 99.0.0 as available and dismissed',
    JSON.stringify(dismissed.updateReason))
}

// ---------------------------------------------------------------------------
// 3. The policy, and the door it comes through
// ---------------------------------------------------------------------------

const token = async (id) => {
  seen.answers.length = 0
  ws.send(JSON.stringify({ t: 'session.token', sessionId: id }))
  await sleep(400)
  return seen.answers.find((m) => m.t === 'session.token' && m.sessionId === id)?.token ?? null
}
const handToken = await token(hand.id)
const chiefToken = await token(chief.id)

/** The shim, run the way a card runs it, with only what a card would have in its environment. */
function shim(args, env) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'server', 'bin', 'garden-task.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 20000,
      env: { GARDEN_PORT: String(PORT), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    })
    return { ok: true, text: out.trim() }
  } catch (err) {
    return { ok: false, text: String(err.stdout ?? '').trim() + String(err.stderr ?? '').trim() }
  }
}

const asOwner = { GARDEN_HOME: home }
// A card has no owner key to read, so GARDEN_HOME points at a directory with no key in it.
const noKey = mkdtempSync(join(tmpdir(), 'garden-upd-nokey-'))
const asWorker = { GARDEN_HOME: noKey, GARDEN_SESSION_ID: hand.id, GARDEN_SESSION_TOKEN: handToken }
const asChief = { GARDEN_HOME: noKey, GARDEN_SESSION_ID: chief.id, GARDEN_SESSION_TOKEN: chiefToken }

const readDefault = shim(['update-policy'], asOwner)
check('the policy starts at manual, and says nothing acts on it',
  readDefault.ok && /is manual/.test(readDefault.text) && /Nothing acts on it yet/.test(readDefault.text),
  readDefault.text)

const set = shim(['update-policy', 'when-safe'], asOwner)
check('the owner can set the policy', set.ok && /is now when-safe/.test(set.text), set.text)

const readBackPolicy = shim(['update-policy'], asOwner)
check('what was set is what is read back', readBackPolicy.ok && /is when-safe/.test(readBackPolicy.text), readBackPolicy.text)

const boardLimits = db.prepare('SELECT updatePolicy FROM limits WHERE projectId = ?').get(project.id)
check('the policy is stored on the project rather than held in memory',
  boardLimits?.updatePolicy === 'when-safe', JSON.stringify(boardLimits))

const refusedWorker = shim(['update-policy', 'manual'], asWorker)
check('a worker cannot set the policy, and is told who can',
  !refusedWorker.ok && /orchestrator/.test(refusedWorker.text), refusedWorker.text)

const stillWhenSafe = db.prepare('SELECT updatePolicy FROM limits WHERE projectId = ?').get(project.id)
check('a refused attempt changes nothing', stillWhenSafe?.updatePolicy === 'when-safe', JSON.stringify(stillWhenSafe))

const chiefSets = shim(['update-policy', 'manual'], asChief)
check('an orchestrator can set the policy', chiefSets.ok && /is now manual/.test(chiefSets.text), chiefSets.text)

const nonsense = shim(['update-policy', 'whenever'], asOwner)
check('a policy that is not one of the two is refused before anything is written',
  !nonsense.ok && /not a policy/.test(nonsense.text), nonsense.text)

// ---------------------------------------------------------------------------
// 4. The generation, and the input that is dropped because of it
// ---------------------------------------------------------------------------

board = await readBoard()
let handNow = board.sessions.find((s) => s.id === hand.id)
check('a card that has been launched once is on generation 1', handNow.generation === 1, `generation ${handNow.generation}`)

// A message card wired to the card, which is the shortest path to an input Garden schedules itself.
ws.send(JSON.stringify({ t: 'channel.create', projectId: project.id, x: 0, y: 0 }))
await sleep(700)
board = await readBoard()
const channel = board.channels[board.channels.length - 1]
ws.send(JSON.stringify({ t: 'wire.create', projectId: project.id, sourceId: channel.id, targetId: hand.id }))
await sleep(700)

seen.events.length = 0
ws.send(JSON.stringify({ t: 'channel.send', channelId: channel.id, text: 'something for you to read' }))
await sleep(300)
// The Enter is now five seconds out, under generation 1. Restart inside that window.
ws.send(JSON.stringify({ t: 'session.stop', sessionId: hand.id }))
await sleep(1200)
ws.send(JSON.stringify({ t: 'session.start', sessionId: hand.id }))
await sleep(1500)
board = await readBoard()
handNow = board.sessions.find((s) => s.id === hand.id)
check('a relaunch moves the card to the next generation', handNow.generation === 2, `generation ${handNow.generation}`)

await sleep(5000)
const dropped = seen.events.find((e) => e.type === 'InputDropped' && e.sessionId === hand.id)
/*
 * Watched fail first. With the generation comparison removed from `writeLater`, no `InputDropped`
 * is ever written and the Enter is typed into a process that never saw the sentence it was meant to
 * submit: a keystroke nobody sent, in a conversation nobody chose. That build fails this assertion
 * and the one under it, and nothing else in this file.
 */
check('an input scheduled under one generation is dropped after a relaunch', !!dropped,
  dropped ? JSON.stringify(dropped.payload) : `no InputDropped among ${seen.events.length} events`)
check('the drop is recorded with which generation it was for and which one is there now',
  !!dropped && dropped.payload.scheduledUnder === 1 && dropped.payload.nowAt === 2 && dropped.payload.text === '\r',
  dropped ? JSON.stringify(dropped.payload) : 'no event')

seen.events.length = 0
ws.send(JSON.stringify({ t: 'channel.send', channelId: channel.id, text: 'and this one is not interrupted' }))
await sleep(6000)
check('an input whose card was not relaunched is not dropped',
  !seen.events.some((e) => e.type === 'InputDropped' && e.sessionId === hand.id),
  `${seen.events.filter((e) => e.type === 'InputDropped').length} drops`)

// ---------------------------------------------------------------------------
// 5. The boundary, which only ever answers
// ---------------------------------------------------------------------------

/*
 * Every reason, against the function that decides, because three of the seven need a state the
 * board cannot be put into on demand and a reason that has never been produced is a sentence
 * nobody has read. The four underneath this are then produced end to end, so the gathering is
 * proved as well as the deciding.
 */
const base = {
  pid: 1234, children: [], lastInputAt: null, lastStopAt: null,
  openTools: 0, claims: [], composerDirty: false, promptOpen: false,
}
const reasons = [
  ['not-running', { ...base, pid: null }],
  ['prompt-open', { ...base, promptOpen: true, composerDirty: true, openTools: 3 }],
  ['composer-dirty', { ...base, composerDirty: true, openTools: 3 }],
  ['tool-open', { ...base, openTools: 1, lastInputAt: 5, lastStopAt: 9 }],
  ['mid-turn', { ...base, lastInputAt: 9, lastStopAt: 5 }],
  ['child-running', { ...base, children: [4321] }],
  ['claim-held', { ...base, claims: ['server/src/index.ts'] }],
]
for (const [blocker, facts] of reasons) {
  const answer = boundaryFrom(facts)
  check(`the boundary reports ${blocker}`,
    answer.blocker === blocker && answer.safe === false && typeof answer.reason === 'string' && answer.reason.length > 20,
    `${answer.blocker}: ${answer.reason}`)
}
check('a card with nothing in the way is safe, and says so', (() => {
  const answer = boundaryFrom(base)
  return answer.safe === true && answer.blocker === null && answer.reason === 'nothing is in the way.'
})())
check('a turn that was never started is not a turn to be mid-way through',
  boundaryFrom({ ...base, lastInputAt: null, lastStopAt: null }).safe === true)
check('a card that has been given input and has not stopped is mid-turn',
  boundaryFrom({ ...base, lastInputAt: Date.now(), lastStopAt: null }).blocker === 'mid-turn')

/**
 * Wait for the answer rather than for a fixed moment.
 *
 * The boundary read walks the process table, which on Windows means starting PowerShell, so it
 * takes a second or more on a machine that is busy. A fixed sleep shorter than that does not fail
 * the assertion honestly: the answer arrives into the buffer afterwards and is picked up by the
 * NEXT question, so every reply is one behind and each check is answered about the wrong state.
 * That is exactly what the first run of this file did, and it is the shape of a test passing for
 * the wrong reason.
 */
async function waitFor(match, ms = 25000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = seen.answers.find(match)
    if (hit) return hit
    await sleep(150)
  }
  return null
}

const askBoundary = async (id) => {
  seen.answers.length = 0
  ws.send(JSON.stringify({ t: 'update.boundary', sessionId: id }))
  const hit = await waitFor((m) => (m.t === 'update.boundary' || m.t === 'error') && (m.sessionId === id || m.t === 'error'))
  if (hit?.t === 'error') {
    console.log(`      the server refused the boundary read: ${hit.message}`)
    return null
  }
  return hit?.result ?? null
}

const offBoundary = await askBoundary(off.id)
check('a card with no process is not running, end to end',
  offBoundary?.blocker === 'not-running' && offBoundary.checked.pid === null,
  JSON.stringify(offBoundary))

ws.send(JSON.stringify({ t: 'session.input', sessionId: hand.id, data: 'a half typed thought' }))
await sleep(400)
const dirtyBoundary = await askBoundary(hand.id)
check('keystrokes with no submit after them read as a dirty composer, end to end',
  dirtyBoundary?.blocker === 'composer-dirty', JSON.stringify(dirtyBoundary?.blocker))

// Clearing it, so the checks under this one are not answered by the composer.
ws.send(JSON.stringify({ t: 'session.input', sessionId: hand.id, data: '\r' }))
await sleep(600)

const now = Date.now()
const insert = db.prepare('INSERT INTO events (id,sessionId,ts,type,provenance,payload) VALUES (?,?,?,?,?,?)')
insert.run(randomUUID(), hand.id, now, 'UserPromptSubmit', 'hook', '{}')
const midBoundary = await askBoundary(hand.id)
check('a card whose CLI has not said the turn is over is mid-turn, end to end',
  midBoundary?.blocker === 'mid-turn' && midBoundary.checked.lastInputAt === now && midBoundary.checked.lastStopAt === null,
  JSON.stringify(midBoundary?.checked))

insert.run(randomUUID(), hand.id, now + 1, 'PreToolUse', 'hook', '{}')
const toolBoundary = await askBoundary(hand.id)
check('a tool call with no result recorded is an open tool, end to end',
  toolBoundary?.blocker === 'tool-open' && toolBoundary.checked.openTools === 1,
  JSON.stringify(toolBoundary?.checked))

insert.run(randomUUID(), hand.id, now + 2, 'PostToolUse', 'hook', '{}')
insert.run(randomUUID(), hand.id, now + 3, 'Stop', 'hook', '{}')
const settled = await askBoundary(hand.id)
check('a finished turn with a closed tool is no longer either of those',
  settled?.blocker !== 'mid-turn' && settled?.blocker !== 'tool-open',
  JSON.stringify(settled?.blocker))

/*
 * Something the card started, found in the process table rather than inferred from the terminal
 * going quiet. Canon 21 is explicit that silence is not a boundary, and this is the case that shows
 * why: a card that has printed nothing for ten seconds because a build is running underneath it.
 */
ws.send(JSON.stringify({
  t: 'session.input',
  sessionId: hand.id,
  data: 'node -e "setTimeout(function(){}, 20000)"\r',
}))
await sleep(4000)
const childBoundary = await askBoundary(hand.id)
check('a live child of the card blocks the boundary, end to end',
  childBoundary?.blocker === 'child-running' && childBoundary.checked.children.length > 0,
  JSON.stringify(childBoundary?.checked?.children))

check('the boundary never reports on a card it did not look at',
  childBoundary?.checked?.pid === handNow.pid || childBoundary?.checked?.pid === board.sessions.find((s) => s.id === hand.id)?.pid,
  `${childBoundary?.checked?.pid} vs ${handNow.pid}`)

// ---------------------------------------------------------------------------
// 6. The checkpoint
// ---------------------------------------------------------------------------

seen.answers.length = 0
seen.events.length = 0
ws.send(JSON.stringify({ t: 'update.checkpoint', sessionId: hand.id }))
const answered = await waitFor((m) => m.t === 'update.checkpoint' || m.t === 'error', 15000)
if (answered?.t === 'error') console.log(`      the server refused the checkpoint: ${answered.message}`)
const written = answered?.t === 'update.checkpoint' ? answered : null
check('the checkpoint is written and its path is reported back', !!written && existsSync(written.path),
  written ? written.path : 'no answer')

if (written && existsSync(written.path)) {
  const body = readFileSync(written.path, 'utf8')
  /*
   * Every field canon 21 names, checked by name rather than by counting. A checkpoint that is
   * missing one is a card that comes back not knowing something it was in the middle of, and which
   * one is missing is the whole of what matters.
   */
  const CANON_FIELDS = [
    'card', 'generation', 'conversation', 'transcript', 'adapter', 'executable',
    'running version', 'installed version', 'config directory', 'working directory',
    'task', 'stage', 'measured against', 'next action',
    'changed paths', 'claims held', 'operations in flight', 'mail waiting',
    'input whose acceptance is uncertain',
  ]
  const missing = CANON_FIELDS.filter((f) => !new RegExp(`^#*\\s*-?\\s*${f}`, 'im').test(body))
  check('the checkpoint carries every field canon 21 names', missing.length === 0, `missing: ${missing.join(', ')}`)
  check('what it reports as written is what it wrote',
    CANON_FIELDS.every((f) => written.fields.includes(f)) && written.fields.length === CANON_FIELDS.length,
    JSON.stringify(written.fields))
  check('the checkpoint names the card and the generation it was written under',
    body.includes(hand.id) && /generation: 2/.test(body), body.split('\n').slice(0, 14).join(' | '))

  /*
   * No secret, and this is the assertion the whole writer was shaped around. The CLI keeps a peer
   * token in a file beside the registry entry a card's running version is read from, so the one
   * place a secret could get in is the one place this writer reads.
   */
  const carriesSecret =
    body.includes(ownerKey) ||
    (handToken && body.includes(handToken)) ||
    /\b(sk-ant|ghp_|bearer\s|api[_-]?key|password)\b/i.test(body)
  check('the checkpoint carries no token, key or secret', !carriesSecret,
    carriesSecret ? 'something in it matched' : `${body.length} bytes, none of them a credential`)

  check('it references the transcript rather than copying it',
    !body.includes('{"type":"summary"}'), 'no transcript content in the file')

  const twin = db
    .prepare("SELECT payload FROM events WHERE sessionId = ? AND type = 'CheckpointWritten' ORDER BY ts DESC LIMIT 1")
    .get(hand.id)
  const record = twin ? JSON.parse(twin.payload) : null
  check('a JSON twin of the same facts is recorded in the store',
    !!record && record.cardId === hand.id && record.path === written.path && record.generation === 2,
    record ? `${Object.keys(record).length} fields` : 'no CheckpointWritten event')
  check('the twin carries no credential either',
    !!record && !JSON.stringify(record).includes(ownerKey) && !(handToken && JSON.stringify(record).includes(handToken)))
}

// ---------------------------------------------------------------------------
// 7. What this stage must not have done
// ---------------------------------------------------------------------------

/*
 * Nothing above asked for a restart, so nothing may have happened. `Ver` was pending and eligible
 * for most of this run, which is exactly the state a later stage will act on, and it must still be
 * switched off and on generation 0.
 */
board = await readBoard()
const verEnd = board.sessions.find((s) => s.id === ver.id)
const codEnd = board.sessions.find((s) => s.id === cod.id)
check('a pending, eligible card is not restarted by anything in this stage',
  verEnd.generation === 0 && verEnd.pid === null,
  `generation ${verEnd.generation}, pid ${verEnd.pid}`)
check('a card that is only read about is not started',
  codEnd.generation === 0 && codEnd.pid === null,
  `generation ${codEnd.generation}, pid ${codEnd.pid}`)
check('nothing recorded a restart, an exit or an update being installed',
  !seen.events.some((e) => /Update|Restart|Relaunch/i.test(e.type)),
  seen.events.map((e) => e.type).join(', ') || 'no events at all')

db.close()
main.socket.close()
await garden.stop()

console.log(`\n${failures ? `${failures} failed` : 'all passed'}${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(failures ? 1 : 0)
