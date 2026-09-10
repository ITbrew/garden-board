/**
 * The chain as a conversation rather than a conveyor belt.
 *
 * What the owner asked for after watching the first version: a wire that says two-way should be two
 * ways for real, so a manager and its worker can talk before the work is finished rather than only
 * handing a parcel down and a parcel back. And nothing should travel up the chain unread, so a
 * manager confirms its worker before it speaks for that worker, and a boss confirms its manager,
 * and what reaches him at the end is the summary plus the reviewer's notes plus how the work
 * measures against what he actually asked for.
 *
 * Two things this proves that are easy to fake. A wire he draws by hand, that no spawn created,
 * permits conversation immediately, because the wire is the permission and nothing else is. And an
 * agent can find out how to send at all: the command is read out of the file Garden writes for the
 * session rather than hardcoded here, since for a while the shim existed, worked, and was mentioned
 * in no file any agent could read.
 *
 * Runs against a server of its own, on its own port with its own workspace, so it cannot touch the
 * board the owner is using.
 */
import WebSocket from 'ws'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startInstance } from './lib/instance.mjs'

const run = promisify(execFile)
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
const inboxOf = (id) => readIf(mailFile(id, 'INBOX.md'))

/**
 * Find the shim the way an agent would: by reading its own PEERS.md.
 *
 * If this ever comes back empty the chain is unwalkable no matter what the endpoint does, because
 * nothing else tells a session that sending is possible.
 */
function shimFromPeers(sessionId) {
  const peers = readIf(mailFile(sessionId, 'PEERS.md'))
  const m = peers.match(/node "([^"]+garden-send\.mjs)"/)
  return m ? m[1] : null
}

/** Run it exactly as an agent would, from inside a session's environment. */
async function send(fromId, to, kind, task, text, shim) {
  try {
    const { stdout } = await run(
      process.execPath,
      [shim, '--to', to, '--kind', kind, ...(task ? ['--task', task] : []), '--text', text],
      { env: { ...process.env, GARDEN_SESSION_ID: fromId, GARDEN_PORT: String(PORT) } },
    )
    return { ok: true, message: String(stdout).trim() }
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message).trim() }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'garden-chain-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [], docs: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'error') console.log('   server said:', m.message)
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
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, roleClass, reportsTo, start: false }))
  await sleep(700)
  return st.sessions.find((s) => s.title === title)
}

const orch = await make('Orchestrator', 'orchestrator', null)
const boss = await make('Boss', 'boss', orch.id)
const manager = await make('Manager', 'manager', boss.id)
const worker = await make('Worker', 'worker', manager.id)
const reviewer = await make('Reviewer', 'reviewer', boss.id)
const chain = [orch, boss, manager, worker, reviewer]
check('the chain exists as five cards', chain.every(Boolean))
check('and each is wired to the one above it', [boss, manager, worker, reviewer].every((c) => st.wires.some((w) => w.targetId === c.id)))

// --- an agent can find out how to send at all ---

const shim = shimFromPeers(manager.id)
check('a card is told how to send, in the file it can read', !!shim, shim ?? 'PEERS.md names no command')
if (!shim) {
  await garden.stop()
  process.exit(1)
}
const peersText = readIf(mailFile(manager.id, 'PEERS.md'))
check('and what the kinds mean', /`confirm`/.test(peersText) && /`assessment`/.test(peersText))
check('and that a two-way wire runs both ways', /both ways/.test(peersText), peersText.match(/both ways.*/)?.[0] ?? '')

const T = `T-${Date.now().toString().slice(-5)}`

// --- work goes down ---

const down1 = await send(orch.id, boss.title, 'work', T, 'Goal: the loader must stop reading twice.', shim)
check('the orchestrator can hand a goal to the boss', down1.ok, down1.message)
check('and it lands in the boss inbox', inboxOf(boss.id).includes('stop reading twice'))
check('the boss can hand a departmental task to the manager', (await send(boss.id, manager.title, 'work', T, 'Your department: fix the loader.', shim)).ok)
check('the manager can hand the work to its specialist', (await send(manager.id, worker.title, 'work', T, 'Refactor loadOnce and add the guard.', shim)).ok)

// --- and they can talk while it is in flight, in both directions ---

const ask = await send(worker.id, manager.title, 'question', T, 'Should the guard throw or return early?', shim)
check('a worker can ask its manager a question mid-task', ask.ok, ask.message)
const reply = await send(manager.id, worker.title, 'answer', T, 'Return early. Throwing changes the caller.', shim)
check('and the manager can answer on the same wire', reply.ok, reply.message)
check('the answer really arrived', inboxOf(worker.id).includes('Return early'))

const upAsk = await send(manager.id, boss.title, 'question', T, 'Is the guard in scope for this task?', shim)
check('a manager can ask its boss a question', upAsk.ok, upAsk.message)
check('and the boss can answer back down', (await send(boss.id, manager.title, 'answer', T, 'Yes, it is in scope.', shim)).ok)
check('a boss can ask the orchestrator', (await send(boss.id, orch.title, 'question', T, 'Does canon allow a behaviour change here?', shim)).ok)
check('and the orchestrator can answer', (await send(orch.id, boss.title, 'answer', T, 'Canon allows it if the caller is unchanged.', shim)).ok)

// --- a wire nobody spawned works the moment it is drawn ---

const blocked = await send(worker.id, reviewer.title, 'question', T, 'did you see the guard', shim)
check('with no wire, a worker cannot reach the reviewer', !blocked.ok, blocked.message)
ws.send(JSON.stringify({ t: 'wire.create', projectId: project.id, sourceId: worker.id, targetId: reviewer.id }))
await sleep(600)
const drawn = await send(worker.id, reviewer.title, 'question', T, 'Anything you want changed before I finish?', shim)
check('a wire drawn by hand permits it immediately', drawn.ok, drawn.message)
check('and the reviewer can reply along it', (await send(reviewer.id, worker.title, 'answer', T, 'Name the guard for what it prevents.', shim)).ok)

// --- the chain still refuses a shortcut ---

const skip = await send(worker.id, orch.title, 'done', T, 'all finished, boss', shim)
check('a worker still cannot report straight to the orchestrator', !skip.ok, skip.message)
check('and the refusal names the missing wire', /no wire from you/i.test(skip.message), skip.message)
check('nothing was delivered by the attempt', !inboxOf(orch.id).includes('all finished, boss'))

// --- back up, and nothing passes unread ---

check('the specialist reports to its manager', (await send(worker.id, manager.title, 'done', T, 'Done. Guard added, tests pass locally.', shim)).ok)

const unread = await send(manager.id, boss.title, 'done', T, 'Department reports the loader work complete.', shim)
check('the manager cannot pass that up unread', !unread.ok, unread.message)
check('and is told who is waiting and what to send', /Worker/.test(unread.message) && /confirm/.test(unread.message), unread.message)
check('nothing reached the boss', !inboxOf(boss.id).includes('Department reports'))

check('the manager confirms its worker', (await send(manager.id, worker.title, 'confirm', T, 'Read the diff. The guard is where I asked.', shim)).ok)
const afterConfirm = await send(manager.id, boss.title, 'done', T, 'Department reports the loader work complete.', shim)
check('and then it may pass it up', afterConfirm.ok, afterConfirm.message)

const bossUnread = await send(boss.id, orch.title, 'done', T, 'all done', shim)
check('the boss cannot pass it up unread either', !bossUnread.ok, bossUnread.message)
check('the boss confirms its manager', (await send(boss.id, manager.title, 'confirm', T, 'Checked the department report against the goal.', shim)).ok)

// --- one review, then it goes to him ---

check('the boss may call the reviewer', (await send(boss.id, reviewer.title, 'review', T, 'Look at the loader change.', shim)).ok)
check('the reviewer reports what it found', (await send(reviewer.id, boss.title, 'answer', T, 'The guard is correct. The name reads as a cache flag.', shim)).ok)

const rev2 = await send(boss.id, reviewer.title, 'review', T, 'Look again.', shim)
check('a second review round is refused', !rev2.ok, rev2.message)
check('and it says to send it up instead', /owner decides|send it up/i.test(rev2.message), rev2.message)
check('so is sending it back down after review', !(await send(boss.id, manager.title, 'remediation', T, 'go round again', shim)).ok)

// --- what comes home ---

check('the boss writes its assessment against what was asked', (await send(boss.id, orch.title, 'assessment', T, 'Asked for: stop reading twice. Delivered: a guard in loadOnce. The double read is gone; the rename the reviewer wanted was not done.', shim)).ok)
check('and brings the work home', (await send(boss.id, orch.title, 'done', T, 'Loader work complete. One reviewer note outstanding.', shim)).ok)
await sleep(900)

/*
 * Reports no longer draw themselves the moment a task comes home — the owner asked for that to
 * stop ("i dont want it to auto open history"), so a report now shows up the same way a day of
 * turns does, behind a pill opened by hand. Nothing on the board should exist yet at this point.
 */
check(
  'nothing is drawn until the pill is opened',
  !st.docs.some((d) => d.ownerId === orch.id && d.title.includes(T)),
)
ws.send(JSON.stringify({ t: 'history.open', sessionId: orch.id, group: 'reports' }))
await sleep(1200)

const report = st.docs.find((d) => d.ownerId === orch.id && d.title.includes(T))
check('opening the reports pill draws the card beside the orchestrator', !!report, report?.title)
const text = report ? readFileSync(report.relPath, 'utf8') : ''
check('it carries what was reported done', text.includes('Loader work complete'))
check('and how it measures against what he asked for', text.includes('The double read is gone'))
check('and what the reviewer actually found, not just that one was asked', text.includes('reads as a cache flag'))
check('and who confirmed whom on the way up', /Manager\*\* accepted \*\*Worker/.test(text) && /Boss\*\* accepted \*\*Manager/.test(text))
check('and the questions they asked each other', text.includes('Should the guard throw'))
check('and it still refuses to say the work is right', !/passed|approved|looks good/i.test(text), 'the report drew a conclusion it cannot support')

// --- an unknown kind is refused with the list ---

const bogus = await send(manager.id, worker.title, 'escalate', T, 'hello', shim)
check('a kind Garden does not know is refused', !bogus.ok, bogus.message)
check('and the refusal lists the kinds that exist', /assessment/.test(bogus.message) && /confirm/.test(bogus.message), bogus.message)

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
