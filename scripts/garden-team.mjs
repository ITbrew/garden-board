/*
 * garden-team: assemble, inspect and stand down a team of cards from one blueprint file.
 *
 * Written because the orchestrator card has no shell and cannot create cards itself, and because
 * doing it card by card meant a separate one-shot script every time. One blueprint, one command.
 *
 * It also holds the rules canon states and the server does not enforce yet, so they hold in
 * practice until they are real:
 *
 *   - Cards are created switched OFF and started as a second step, because a card created running
 *     never gets its PEERS.md: startSession calls refreshMail before the session row exists in the
 *     store, and refreshMail returns silently on a null lookup.
 *   - A card is never started without roots. Nothing writes a card's CLAUDE.md on the creation
 *     path, so an unbriefed card spends its first turn working out what it is from documents
 *     written for somebody else.
 *   - No more than MAX_RUNNING cards run at once, counting every role. Refusals say so.
 *
 * It never deletes anything. Standing a team down means stopping processes; the cards stay.
 *
 *   node scripts/garden-team.mjs plan     <blueprint>   what it would do, changes nothing
 *   node scripts/garden-team.mjs create   <blueprint>   create every missing card, switched off
 *   node scripts/garden-team.mjs roots    <blueprint>   report which cards have roots and which do not
 *   node scripts/garden-team.mjs start    <blueprint>   start cards that have roots, up to the ceiling
 *   node scripts/garden-team.mjs status   <blueprint>   one line per card
 *   node scripts/garden-team.mjs stop     <blueprint>   stop every card in the blueprint
 *
 * A blueprint is JSON:
 *
 *   {
 *     "project": "ebdcf976-968b-4d1a-941c-28b21f322483",
 *     "adapter": "claude",
 *     "cards": [
 *       { "title": "Fixer", "role": "worker", "reportsTo": "c9897606-...", "order": ".claude/work-orders/fixer-card-layout.md" }
 *     ]
 *   }
 *
 * `reportsTo` may be a card id or the title of another card in the same blueprint.
 * `order` is only printed, as a reminder of what that card is for.
 */
import WebSocket from 'ws'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.GARDEN_PORT ?? 5178)
const HOME = process.env.GARDEN_HOME ?? join(homedir(), '.garden')

/** The owner's ceiling, from docs/canonical/15-guardrails.md. His figure, not a tuning constant. */
const MAX_RUNNING = 5

const RUNNING = new Set(['working', 'idle', 'needs-input'])

const [, , cmd, blueprintPath] = process.argv
const COMMANDS = ['plan', 'create', 'roots', 'start', 'status', 'stop']

if (!COMMANDS.includes(cmd) || !blueprintPath) {
  console.log('usage: node scripts/garden-team.mjs <' + COMMANDS.join('|') + '> <blueprint.json>')
  process.exit(1)
}
if (!existsSync(blueprintPath)) {
  console.log(`no blueprint at ${blueprintPath}`)
  process.exit(1)
}

const bp = JSON.parse(readFileSync(blueprintPath, 'utf8'))
const PROJECT = bp.project
const ADAPTER = bp.adapter ?? 'claude'
if (!PROJECT) {
  console.log('blueprint needs a "project" id')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const st = { sessions: [] }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') st.sessions = m.sessions
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    const i = st.sessions.findIndex((s) => s.id === m.session.id)
    if (i >= 0) st.sessions[i] = m.session
  } else if (m.t === 'error') console.log(`   server said: ${m.message}`)
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(1200)

const onProject = () => st.sessions.filter((s) => s.projectId === PROJECT)
const byTitle = (title) => onProject().find((s) => s.title === title)
const runningCount = () => onProject().filter((s) => RUNNING.has(s.status)).length

/**
 * A card's own notes directory, found the way the server finds it: by the id suffix rather than by
 * the title, so a renamed card keeps what it learned.
 */
function memoryDirFor(cardId) {
  const projectDir = join(HOME, 'memory', 'garden')
  const suffix = `-${cardId.slice(0, 8)}`
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith(suffix)) return join(projectDir, name)
    }
  } catch {}
  return null
}

const hasRoots = (cardId) => {
  const dir = memoryDirFor(cardId)
  return !!dir && existsSync(join(dir, 'CLAUDE.md'))
}

/** `reportsTo` may name another card in the same blueprint rather than an id. */
function resolveReportsTo(value) {
  if (!value) return null
  if (value.includes('-') && value.length > 20) return value
  const other = byTitle(value)
  return other ? other.id : null
}

const line = (s) => {
  const roots = hasRoots(s.id) ? 'roots' : 'NO ROOTS'
  return `${String(s.title).padEnd(22)} ${String(s.roleClass ?? '-').padEnd(13)} ${String(s.status).padEnd(11)} ${roots.padEnd(9)} ${s.id}`
}

if (cmd === 'plan') {
  console.log(`project ${PROJECT}, ${onProject().length} cards on it, ${runningCount()} running, ceiling ${MAX_RUNNING}\n`)
  for (const c of bp.cards) {
    const existing = byTitle(c.title)
    if (!existing) console.log(`create  ${c.title.padEnd(22)} ${c.role}`)
    else console.log(`exists  ${line(existing)}`)
    if (c.order) console.log(`        order: ${c.order}`)
  }
  console.log('\nNothing was changed.')
}

if (cmd === 'status') {
  console.log(`project ${PROJECT}, ${runningCount()} running of ${MAX_RUNNING} allowed\n`)
  for (const c of bp.cards) {
    const s = byTitle(c.title)
    console.log(s ? line(s) : `${c.title.padEnd(22)} (does not exist)`)
  }
}

if (cmd === 'roots') {
  for (const c of bp.cards) {
    const s = byTitle(c.title)
    if (!s) {
      console.log(`${c.title.padEnd(22)} does not exist`)
      continue
    }
    const dir = memoryDirFor(s.id)
    console.log(`${c.title.padEnd(22)} ${hasRoots(s.id) ? 'roots written' : 'NO ROOTS'}`)
    console.log(`   ${dir ? join(dir, 'CLAUDE.md') : `no memory directory yet (id ${s.id})`}`)
  }
  console.log('\nThe orchestrator writes a card CLAUDE.md before that card is started.')
}

if (cmd === 'create') {
  let made = 0
  for (const c of bp.cards) {
    if (byTitle(c.title)) {
      console.log(`exists  ${c.title}`)
      continue
    }
    const reportsTo = resolveReportsTo(c.reportsTo)
    if (c.reportsTo && !reportsTo) {
      console.log(`skip    ${c.title}: reportsTo "${c.reportsTo}" is not an id and no card by that title exists yet`)
      continue
    }
    ws.send(JSON.stringify({
      t: 'session.create',
      projectId: PROJECT,
      adapterId: ADAPTER,
      title: c.title,
      roleClass: c.role,
      reportsTo,
      start: false,
    }))
    made++
    await sleep(1600)
    const now = byTitle(c.title)
    if (!now) {
      console.log(`FAILED  ${c.title}`)
      continue
    }
    const mail = join(HOME, 'mail', now.id)
    console.log(`created ${c.title.padEnd(22)} ${now.id}`)
    console.log(`        PEERS.md ${existsSync(join(mail, 'PEERS.md'))}  POWERS.md ${existsSync(join(mail, 'POWERS.md'))}`)
  }
  console.log(`\n${made} created, switched off. Write their roots, then: node scripts/garden-team.mjs start ${blueprintPath}`)
}

if (cmd === 'start') {
  for (const c of bp.cards) {
    const s = byTitle(c.title)
    if (!s) {
      console.log(`skip    ${c.title}: does not exist`)
      continue
    }
    if (RUNNING.has(s.status)) {
      console.log(`already ${c.title}: ${s.status}`)
      continue
    }
    if (!hasRoots(s.id)) {
      console.log(`REFUSED ${c.title}: no roots. Nothing writes a card CLAUDE.md on the creation path,`)
      console.log(`        so this card would start with no idea what it is. Write them first.`)
      continue
    }
    if (runningCount() >= MAX_RUNNING) {
      console.log(`REFUSED ${c.title}: ${runningCount()} cards already running, ceiling is ${MAX_RUNNING}.`)
      console.log(`        Stop something before starting anything else.`)
      continue
    }
    ws.send(JSON.stringify({ t: 'session.start', sessionId: s.id }))
    await sleep(2200)
    const now = byTitle(c.title)
    console.log(`started ${c.title.padEnd(22)} ${now.status} pid ${now.pid}`)
  }
  console.log(`\n${runningCount()} running of ${MAX_RUNNING}.`)
}

if (cmd === 'stop') {
  for (const c of bp.cards) {
    const s = byTitle(c.title)
    if (!s || !RUNNING.has(s.status)) continue
    ws.send(JSON.stringify({ t: 'session.stop', sessionId: s.id }))
    console.log(`stopped ${c.title}`)
    await sleep(250)
  }
  console.log('\nStopped, not deleted. Every card keeps its position, wires, history and memory.')
}

await sleep(600)
ws.close()
process.exit(0)
