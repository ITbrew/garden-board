/**
 * A card starts knowing what its creator wrote for it, and nothing else.
 *
 * The owner's complaint, in his words: "i want each card to load with an empty set of roots that its
 * creator writes for them. currently each claude session gets every .md ever created." He was right,
 * and it was worse than it looked. The CLI walks from a session's working directory to the
 * filesystem root loading every `CLAUDE.md` it passes, plus the user-level one, and every Garden
 * card is spawned in the same project root. So every card on a board loaded the same instructions.
 * Meanwhile the one file written specifically for that card, its own `CLAUDE.md` in its memory
 * directory, was never loaded at all, because a memory directory is not on that path.
 *
 * Three things have to hold, and they are checked separately because they fail separately:
 *
 *   1. The per-card settings file turns the shared instructions off.
 *   2. The card's own brief actually reaches the session.
 *   3. The roots a creator writes survive being handed to a card that starts immediately.
 *
 * What is NOT checked here is that the CLI honours the settings, because that is the CLI's
 * behaviour rather than Garden's and it costs a real session to ask. It was verified by hand against
 * claude 2.1.232: asked to list its loaded instruction files, a plain run named
 * the user-level `~/.claude/CLAUDE.md` and the project's own `CLAUDE.md`; the same run with these settings
 * answered "NONE". The note is here rather than in a commit message so the next person knows which
 * half has a test and which half has a measurement.
 */
import WebSocket from 'ws'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInstance } from './lib/instance.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(HERE, '..', 'server', 'hooks', 'garden-hook.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const dir = mkdtempSync(join(tmpdir(), 'garden-roots-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# The project\n\nShared by every card. Should not reach one.\n')

const state = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    const i = state.sessions.findIndex((s) => s.id === m.session.id)
    if (i >= 0) state.sessions[i] = m.session
  }
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('the scratch project was added', !!project)
if (!project) {
  await garden.stop()
  process.exit(1)
}

/*
 * A card that starts immediately, which is the case that used to drop its roots on the floor.
 * `roots` were only written in the branch for a card created switched off, so a card created and
 * started in one call had its creator's brief accepted and then discarded. A shell adapter, because
 * what is being checked is what Garden writes and hands over, not what a CLI does with it.
 */
const ROOTS = [
  '## Who you are',
  '',
  'You are the Loader specialist. You own `src/loader` and nothing else.',
  'You answer to Manager B. Report there and nowhere else.',
  'MARKER-ROOTS-REACHED-THE-CARD',
].join('\n')

const title = `Roots ${Date.now().toString().slice(-6)}`
ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title,
    roots: ROOTS,
    start: true,
  }),
)
await sleep(4000)
const card = state.sessions.find((s) => s.title === title)
check('the card was created and started', !!card && card.pid !== null, card ? `pid ${card.pid}` : 'no card')
if (!card) {
  await garden.stop()
  process.exit(1)
}

// --- 1. the settings file the card is launched with ---------------------------------------------

const settingsPath = join(garden.home, 'hooks', 'sessions', `${card.id}.json`)
check('the card has a settings file of its own', existsSync(settingsPath), settingsPath)
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
check(
  'it turns off the shared instruction files',
  Array.isArray(settings.claudeMdExcludes) && settings.claudeMdExcludes.includes('**/CLAUDE.md'),
  JSON.stringify(settings.claudeMdExcludes ?? null),
)
check(
  'and the shared auto-memory, which is keyed to the working directory every card shares',
  settings.autoMemoryEnabled === false,
  String(settings.autoMemoryEnabled),
)

// --- 2. the roots the creator wrote, on disk and reaching the session ----------------------------

const memoryDir = join(garden.home, 'memory')
let briefPath = null
const walk = (d) => {
  for (const e of readdirSyncSafe(d)) {
    const p = join(d, e)
    if (e === 'CLAUDE.md' && p.includes(card.id.slice(0, 8))) briefPath = p
    else if (!e.includes('.')) walk(p)
  }
}
function readdirSyncSafe(d) {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
walk(memoryDir)
check('the card has a brief of its own on disk', !!briefPath, briefPath ?? 'not found')
const brief = briefPath ? readFileSync(briefPath, 'utf8') : ''
check(
  'and it holds what the creator wrote, even though the card started immediately',
  brief.includes('MARKER-ROOTS-REACHED-THE-CARD'),
  brief.slice(0, 90).replace(/\s+/g, ' '),
)

/*
 * The hook is run for real, with the environment a launched card gets, and its answer is read off
 * stdout. This is the door the brief actually arrives through, so testing anything else would be
 * testing a different thing that happens to be nearby.
 */
const mailDir = join(garden.home, 'mail', card.id)
const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test' })
const run = spawnSync(process.execPath, [HOOK], {
  input: payload,
  encoding: 'utf8',
  env: {
    ...process.env,
    GARDEN_SESSION_ID: card.id,
    GARDEN_CARD: title,
    GARDEN_MAIL_DIR: mailDir,
    GARDEN_MEMORY_DIR: dirname(briefPath ?? ''),
    GARDEN_PORT: String(garden.port),
  },
})
check('the hook answered', run.status === 0, `exit ${run.status}: ${(run.stderr || '').slice(0, 120)}`)
let injected = ''
try {
  const out = JSON.parse(run.stdout || '{}')
  injected =
    out?.hookSpecificOutput?.additionalContext ?? out?.additionalContext ?? JSON.stringify(out)
} catch {
  injected = run.stdout || ''
}
/*
 * The brief POINTS AT the card's roots now; it does not paste them in.
 *
 * This asserted that the marker text from the card's own CLAUDE.md appeared in the injected
 * context, which was true when the brief inlined it and stopped being true when the startup brief
 * changed to naming the directory and saying to read from it when the task calls for it, on the
 * reasoning that a card reading everything up front to feel prepared cancels the point of the
 * board. That is a deliberate design and the marker will never appear again.
 *
 * What still has to hold, and is what this file exists for, is that the session is told where ITS
 * OWN roots are rather than somebody else's. So the directory is the thing to assert.
 */
const ownRoots = dirname(briefPath ?? '')
const named = injected.replace(/\\/g, '/').includes(ownRoots.replace(/\\/g, '/'))
check(
  "the session is pointed at the card's own roots directory at startup",
  named,
  named ? ownRoots : `${ownRoots} is not named in: ${injected.slice(0, 120).replace(/\s+/g, ' ')}`,
)
check(
  'and the project instructions are not smuggled in with it',
  !injected.includes('Shared by every card'),
  'the shared project CLAUDE.md text is absent',
)

// --- 3. the two tiers above the card's own ------------------------------------------------------

/*
 * The tier the owner actually asked for: "i want them to have discrete roots for their roles is main
 * thing to help with focus/context improved results instead of so many general agent cards". So the
 * check is not only that a role file arrives, but that a card gets ITS role's file and not another's.
 */
const rootsDirPath = join(garden.home, 'roots')
check('the shared root exists', existsSync(join(rootsDirPath, 'ALL.md')))
check('and a file for each role', existsSync(join(rootsDirPath, 'roles', 'worker.md')))
const roleInjected = (roleFile) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      GARDEN_SESSION_ID: card.id,
      GARDEN_CARD: title,
      GARDEN_MAIL_DIR: mailDir,
      GARDEN_MEMORY_DIR: dirname(briefPath ?? ''),
      GARDEN_ROOTS_ALL: join(rootsDirPath, 'ALL.md'),
      GARDEN_ROOTS_ROLE: join(rootsDirPath, 'roles', `${roleFile}.md`),
      GARDEN_PORT: String(garden.port),
    },
  })
  try {
    const o = JSON.parse(r.stdout || '{}')
    return o?.hookSpecificOutput?.additionalContext ?? o?.additionalContext ?? ''
  } catch {
    return r.stdout || ''
  }
}

const asReviewer = roleInjected('reviewer')
const asWorker = roleInjected('worker')
check(
  'a reviewer is told the reviewer job',
  asReviewer.includes('Reading is the whole job'),
  asReviewer.slice(0, 80).replace(/\s+/g, ' '),
)
check(
  'and is not told the worker one',
  !asReviewer.includes('You do the work. You hire nobody'),
  'no worker text in a reviewer brief',
)
check(
  'a worker is told the worker job',
  asWorker.includes('You do the work. You hire nobody'),
  asWorker.slice(0, 80).replace(/\s+/g, ' '),
)
check(
  'and is not told the reviewer one',
  !asWorker.includes('Reading is the whole job'),
  'no reviewer text in a worker brief',
)

// The whole brief has to fit under the CLI's ceiling, or it is spilled to a file and stops being a
// brief without anything failing.
check(
  'the shared root reaches the session too, under the role one',
  asWorker.includes('Every card reads this'),
  asWorker.slice(0, 80).replace(/\s+/g, ' '),
)
check(
  'the whole startup brief fits inside what the CLI will carry',
  asWorker.length <= 9000,
  `${asWorker.length} characters`,
)

// --- 4. two cards of the same role do not end up with the same roots ----------------------------

/*
 * The owner's question, asked directly: "if i ask orchestrator to make a new manager with custom
 * roots is it going to make a custom set of roots like im expecting or inherit exact same roots
 * again". Two managers, made the same way, with different briefs. The role file they share is
 * supposed to be identical; the brief is supposed not to be.
 */
const makeManager = (t, roots) =>
  ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: project.id,
      adapterId: 'shell',
      title: t,
      roleClass: 'manager',
      roots,
      start: false,
    }),
  )

const loaderTitle = `Loader dept ${Date.now().toString().slice(-5)}`
const renderTitle = `Render dept ${Date.now().toString().slice(-5)}`
makeManager(loaderTitle, 'You own src/loader. Your specialists are Ana and Bo. MARKER-LOADER-DEPT')
await sleep(1400)
makeManager(renderTitle, 'You own src/render. Your specialist is Cy. MARKER-RENDER-DEPT')
await sleep(1800)

const briefOf = (t) => {
  const c = state.sessions.find((x) => x.title === t)
  if (!c) return null
  let hit = null
  const look = (d) => {
    for (const e of readdirSyncSafe(d)) {
      const p2 = join(d, e)
      if (e === 'CLAUDE.md' && p2.includes(c.id.slice(0, 8))) hit = p2
      else if (!e.includes('.')) look(p2)
    }
  }
  look(memoryDir)
  return hit ? readFileSync(hit, 'utf8') : null
}

const loaderBrief = briefOf(loaderTitle)
const renderBrief = briefOf(renderTitle)
check('both managers got a brief of their own', !!loaderBrief && !!renderBrief)
check(
  'and each one holds what it was told, not what the other was told',
  !!loaderBrief &&
    !!renderBrief &&
    loaderBrief.includes('MARKER-LOADER-DEPT') &&
    !loaderBrief.includes('MARKER-RENDER-DEPT') &&
    renderBrief.includes('MARKER-RENDER-DEPT') &&
    !renderBrief.includes('MARKER-LOADER-DEPT'),
  'each brief carries only its own marker',
)
check(
  'so two managers do not end up with the same roots',
  loaderBrief !== renderBrief,
  loaderBrief === renderBrief ? 'identical briefs' : 'the briefs differ',
)
check(
  'while the role file they share is the same one',
  existsSync(join(rootsDirPath, 'roles', 'manager.md')),
  'one manager.md, shared by every manager',
)

ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(1200)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
