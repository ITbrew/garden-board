/**
 * What a card is allowed to do, checked where it actually takes effect.
 *
 * The controls on the card are only worth anything if they reach the CLI, so this reads the
 * settings file Garden hands each session rather than the card's own state. That file is the
 * whole mechanism: Garden does not intercept a dispatch or argue with a permission decision, it
 * writes a deny entry and lets the CLI enforce its own rule.
 *
 * The tool names matter more than they look. An earlier version denied "Task" and three invented
 * team tools, which meant a card could say it was not allowed to hire while the CLI cheerfully
 * let it, and nothing anywhere would have said so.
 */
import WebSocket from 'ws'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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

const settingsFor = (id) => {
  const file = join(GARDEN_HOME, 'hooks', 'sessions', `${id}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const dir = mkdtempSync(join(tmpdir(), 'garden-powers-'))
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
  else if (m.t === 'wire.removed') st.wires = st.wires.filter((w) => w.id !== m.wireId)
  else if (m.t === 'error') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const stamp = Date.now().toString().slice(-5)
for (const n of ['Boss', 'Worker']) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: `${n} ${stamp}` }))
  await sleep(1800)
}
const boss = st.sessions.find((s) => s.title === `Boss ${stamp}`)
const worker = st.sessions.find((s) => s.title === `Worker ${stamp}`)
check('two cards to work with', !!boss && !!worker)
if (!boss || !worker) process.exit(1)
const cur = (id) => st.sessions.find((s) => s.id === id)

/*
 * A card created with a role launches with that role's denials on its FIRST turn.
 *
 * This is the hole the form would otherwise have walked into. The CLI reads its permissions once,
 * at launch, so a card created and then given a role ran its whole first session with none of
 * them, and nothing on screen said so: a manager made that way could edit files until it was next
 * turned off and on. The settings file is read here because that file is where enforcement lives.
 */
ws.send(JSON.stringify({
  t: 'session.create',
  projectId: project.id,
  adapterId: 'shell',
  /*
   * A reviewer, because the property under test is that a role's denials are already in the
   * settings file at the FIRST launch, and only a role that still denies something can show that.
   *
   * This used to create a boss and check for Write and Edit. The boss layer was removed on
   * 2026-08-12 and boss now denies nothing, so the assertion started passing an empty list against
   * an empty expectation, which proves nothing at all. A reviewer reads and reports and is denied
   * every writing tool, which is a denial that will still be there next year.
   */
  title: `Made a reviewer ${stamp}`,
  roleClass: 'reviewer',
  teamSize: 2,
  modelChoice: 'opus',
}))
await sleep(2000)
const born = st.sessions.find((s) => s.title === `Made a reviewer ${stamp}`)
check('a card can be created with its role', born?.roleClass === 'reviewer', String(born?.roleClass))
const bornSettings = settingsFor(born.id)
check('and it launched with that role denials already in place',
  ['Write', 'Edit', 'Bash'].every((t) => (bornSettings?.permissions?.deny ?? []).includes(t)),
  JSON.stringify(bornSettings?.permissions?.deny ?? []))
check('and its chosen model, from the same first launch', bornSettings?.model === 'opus',
  String(bornSettings?.model))

// A card can be laid out without spending anything on it yet.
ws.send(JSON.stringify({
  t: 'session.create',
  projectId: project.id,
  adapterId: 'shell',
  title: `Not yet ${stamp}`,
  roleClass: 'worker',
  reportsTo: born.id,
  start: false,
}))
await sleep(1400)
const idle = st.sessions.find((s) => s.title === `Not yet ${stamp}`)
check('a card can be created without starting it', idle?.pid === null && idle?.status === 'stopped',
  `${idle?.status}/${idle?.pid}`)
check('and it is already wired to the card it answers to',
  st.wires.some((w) => w.sourceId === born.id && w.targetId === idle?.id))

// --- who a card answers to ---

check('a card the owner started answers to him', cur(worker.id).reportsTo === null, String(cur(worker.id).reportsTo))

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: worker.id, reportsTo: boss.id }))
await sleep(700)
check('naming a boss records it', cur(worker.id).reportsTo === boss.id, String(cur(worker.id).reportsTo))
const wire = st.wires.find((w) => w.sourceId === boss.id && w.targetId === worker.id)
check('and draws the wire, since that is a thing on the board', !!wire, wire?.label)
check('marked as the owner\'s arrangement rather than an observed dispatch', wire?.kind === 'manual', String(wire?.kind))

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: worker.id, reportsTo: null }))
await sleep(700)
check('putting it back under the owner removes that wire',
  !st.wires.some((w) => w.sourceId === boss.id && w.targetId === worker.id))

// A card cannot answer to itself, which would make the hierarchy walk in a circle.
ws.send(JSON.stringify({ t: 'session.setRole', sessionId: worker.id, reportsTo: worker.id }))
await sleep(600)
check('a card cannot be made to answer to itself', cur(worker.id).reportsTo === null, String(cur(worker.id).reportsTo))

// --- what reaches the CLI ---

ws.send(JSON.stringify({
  t: 'session.setRole', sessionId: boss.id, teamSize: 3, modelChoice: 'opus[1m]', effortChoice: 'high',
}))
await sleep(700)
const s1 = settingsFor(boss.id)
check('a settings file is written for the card', !!s1, s1 ? 'present' : 'missing')
check('the chosen model is in it', s1?.model === 'opus[1m]', String(s1?.model))
check('so is the effort, under the key the CLI reads', s1?.effortLevel === 'high', String(s1?.effortLevel))
check('and team size becomes the concurrency cap the CLI enforces',
  s1?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === '3',
  String(s1?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS))
check('with hiring still allowed at that size', !(s1?.permissions?.deny ?? []).includes('Agent'),
  JSON.stringify(s1?.permissions?.deny ?? []))

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: boss.id, teamSize: 0 }))
await sleep(700)
const s2 = settingsFor(boss.id)
check('a team size of zero denies the tool outright', (s2?.permissions?.deny ?? []).includes('Agent'),
  JSON.stringify(s2?.permissions?.deny ?? []))
check('and stops claiming a concurrency cap it no longer needs',
  s2?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === undefined,
  String(s2?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS))

/*
 * Each role loses exactly what its job does not need.
 *
 * The owner's chain is orchestrator, managers, specialists, with a reviewer the orchestrator calls.
 * The boss layer between the first two was removed on 2026-08-12.
 *
 * The denials that remain are the ones where the job genuinely does not need the tool: a reviewer
 * reads and reports, so it writes nothing and runs nothing, and a worker does not hire. The ones
 * that went were doing something different, which was stopping a rung from doing the rung below's
 * job. That reasoning held while a card had a working way to hand work out and stopped holding when
 * it turned out it did not, because the result was not delegation, it was the owner at a terminal.
 *
 * Bash is still the entry that matters wherever a denial remains. A card denied Write and Edit can
 * still write a file through a shell, so a role with no sanctioned way to put bytes on disk loses
 * Bash as well. Garden used to deny the editing tools and then tell managers in writing that they
 * therefore could not change anything, which was false for every card that read it.
 */
const roleCases = [
  /*
   * The orchestrator is the deliberate exception and has nothing denied to it.
   *
   * It used to lose Edit and Bash, on the reasoning that canon is authored whole and the top of the
   * chain should not be doing the work itself. What that produced was the owner asking the one card
   * he talks to for a change and being told it could not make one, so every real edit landed back in
   * his own hands at a terminal while the board watched. The restriction only made sense while
   * hiring worked, and hiring did not.
   *
   * `kept` is checked rather than left implied, so this stays a positive assertion about what the
   * card can reach for rather than an empty list that would also pass if the table vanished.
   */
  { role: 'orchestrator', denied: [], kept: ['Write', 'Edit', 'Bash', 'Agent', 'Read'] },
  /*
   * Boss is a layer the owner removed on 2026-08-12, and this is that decision landing in the code
   * rather than only in canon, where it sat asserted and unimplemented for a day. The row survives
   * so a card already stored under that word keeps working, and it is run as a manager, which is
   * why its powers are the manager's rather than the restricted set it used to carry.
   */
  { role: 'boss', denied: [], kept: ['Write', 'Edit', 'Bash', 'Agent', 'Read'] },
  /*
   * A manager does its own work now as well as planning it. Losing Edit and Bash meant standing up
   * a specialist for a two-line change, which is most of what the owner meant by chaotic spawning:
   * the ceremony cost more than the work. Handing out what belongs to somebody else is still asked
   * of it in POWERS.md, as a request with a reason rather than a denial, because whether a piece of
   * work is somebody else's is a judgement and no denied tool can make it.
   */
  { role: 'manager', denied: [], kept: ['Write', 'Edit', 'Bash', 'Agent', 'Read'] },
  { role: 'worker', denied: ['Agent', 'SendMessage'], kept: ['Write', 'Edit', 'Bash', 'Read'] },
  { role: 'reviewer', denied: ['Write', 'Edit', 'Bash', 'Agent'], kept: ['Read'] },
]

for (const c of roleCases) {
  ws.send(JSON.stringify({ t: 'session.setRole', sessionId: boss.id, roleClass: c.role, teamSize: null }))
  await sleep(600)
  const deny = settingsFor(boss.id)?.permissions?.deny ?? []
  check(`a ${c.role} is denied ${c.denied.join(', ')}`, c.denied.every((t) => deny.includes(t)),
    JSON.stringify(deny))
  check(`and keeps ${c.kept.join(', ')}`, !c.kept.some((t) => deny.includes(t)), JSON.stringify(deny))
}

// Reading is never taken away, because a card that cannot read cannot brief anyone.
for (const c of roleCases) {
  ws.send(JSON.stringify({ t: 'session.setRole', sessionId: boss.id, roleClass: c.role }))
  await sleep(400)
  const deny = settingsFor(boss.id)?.permissions?.deny ?? []
  check(`a ${c.role} can still read`, !['Read', 'Grep', 'Glob'].some((t) => deny.includes(t)),
    JSON.stringify(deny))
}

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: boss.id, roleClass: null }))
await sleep(400)

ws.send(JSON.stringify({ t: 'session.setRole', sessionId: boss.id, teamSize: null, canUseTeams: false }))
await sleep(700)
const s3 = settingsFor(boss.id)
check('turning teams off denies the tools the CLI actually calls them',
  ['SendMessage', 'TaskCreate'].every((t) => (s3?.permissions?.deny ?? []).includes(t)),
  JSON.stringify(s3?.permissions?.deny ?? []))

// The hooks must survive all of this: a card with restrictions still has to be observable.
check('and the observer hooks are still installed alongside the restrictions',
  Object.keys(s3?.hooks ?? {}).length >= 10, `${Object.keys(s3?.hooks ?? {}).length} events`)

for (const s of [boss, worker]) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(400)
}
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
