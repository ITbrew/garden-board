/**
 * The ceiling is five rows, every one of them settable, and one of them refuses.
 *
 * The owner's order was "make sure all of the cieling buttons function properly", which is a
 * different assertion from "the panel renders five rows". A row works when the setting reaches the
 * server, comes back changed on the next `limits` message, and the thing it governs behaves
 * differently afterwards. The first two are checked for all five here; the third is checked for
 * `subagentsAllowed`, because that is the row whose mechanism is Garden's own.
 *
 * That row is a yes or no rather than a figure, which changes how this file has to be written. A
 * boolean that defaults to yes reads back as yes whether or not the server took the message, so
 * every check here sets it to NO first and reads that back. A test that set it to yes and found yes
 * would pass against a server that dropped the field on the floor.
 *
 * What would go red before the change, which is the only reason to trust a green afterwards:
 *
 *   - `subagentsAllowed` does not exist, so setting it to no reads back as undefined.
 *   - `/dispatch` is not a door, so a card on a board that says no is not refused and the check
 *     that it is refused fails against a 404.
 *   - a door that always denies passes the refusal checks, which is what the two controls below
 *     catch: a board set back to yes lets the same card through, at the door and at the hook.
 *
 * No terminals and no CLI anywhere in here. Cards are made switched off, subagents are born from
 * hook payloads the way the CLI makes them, and the settings file is written by `session.setRole`
 * rather than by launching anything, so this spends no tokens.
 *
 * Runs against a server of its own: its own port, its own workspace, its own database. It reads
 * `server/dist`, so build before running it or it will measure the previous change.
 */
import WebSocket from 'ws'
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInstance } from './lib/instance.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}


const garden = await startInstance()
const PORT = garden.port
const GARDEN_HOME = garden.home

const dir = mkdtempSync(join(tmpdir(), 'garden-five-rows-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], errors: [], limits: null, events: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'limits') st.limits = m
  else if (m.t === 'event') st.events.push(m.event)
  else if (m.t === 'session.token') st.token = m.token
  else if (m.t === 'error') st.errors.push(m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

const stop = async (code) => {
  ws.close()
  await garden.stop()
  process.exit(code)
}

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await stop(1)
}

const limits = async () => {
  st.limits = null
  ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
  for (let i = 0; i < 20 && !st.limits; i++) await sleep(100)
  return st.limits?.limits ?? null
}

const setLimits = async (patch) => {
  st.errors.length = 0
  const held = await limits()
  ws.send(JSON.stringify({ t: 'limits.set', projectId: project.id, limits: { ...held, ...patch } }))
  await sleep(400)
  return st.errors[0] ?? null
}

const make = async (title) => {
  const before = st.sessions.length
  st.errors.length = 0
  ws.send(
    JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }),
  )
  await sleep(500)
  if (st.sessions.length === before) return null
  return st.sessions[st.sessions.length - 1]
}

const tokenFor = async (id) => {
  st.token = null
  ws.send(JSON.stringify({ t: 'session.token', sessionId: id }))
  for (let i = 0; i < 20 && !st.token; i++) await sleep(100)
  return st.token
}

const hook = async (sessionId, event) =>
  fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })

/** A subagent born the way the CLI reports one, so the row is the same row his board gets. */
const spawn = async (parent, n) => {
  const toolUseId = `tu-${parent.id}-${n}`
  await hook(parent.id, {
    hook_event_name: 'PreToolUse',
    session_id: `cli-${parent.id}`,
    tool_name: 'Task',
    tool_use_id: toolUseId,
    tool_input: { description: `thing ${n}`, subagent_type: 'general-purpose' },
  })
  await hook(parent.id, {
    hook_event_name: 'SubagentStart',
    session_id: `cli-${parent.id}`,
    tool_use_id: toolUseId,
    agent_id: `agent-${parent.id}-${n}`,
    agent_type: 'general-purpose',
  })
  await sleep(250)
}

/** The question the hook asks before a dispatch, asked exactly as the hook asks it. */
const askDispatch = async (card, token) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/dispatch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ gardenSessionId: card.id }),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, deny: body?.deny ?? null, ok: body?.ok === true }
}

// --- every row takes a number ---

/*
 * No rather than yes for the subagent row, and that is the whole reason this bundle can fail. It
 * defaults to yes, so setting yes and reading yes would be satisfied by a server that ignored the
 * field entirely. The four numbers are all different from their defaults for the same reason.
 */
const wanted = {
  cardsPerProject: 9,
  running: 8,
  subagentsAllowed: false,
  subagents: 7,
  childrenPerCard: 6,
}
const said = await setLimits(wanted)
check('the server took all five figures at once', said === null, said ?? 'no refusal')

const read = await limits()
for (const [field, value] of Object.entries(wanted)) {
  check(`${field} reads back as what was set`, read?.[field] === value, `${read?.[field]}`)
}

/*
 * The row that is edited alone must not reset the four beside it.
 *
 * This is the failure mode the panel actually has: it sends the whole `limits` object on every
 * commit, so a field the server defaulted rather than kept would silently undo a number the owner
 * set a minute earlier, and nothing on screen would say so.
 */
await setLimits({ running: 11 })
const afterOne = await limits()
check('editing one row keeps the other four', afterOne?.subagentsAllowed === false &&
  afterOne?.subagents === 7 && afterOne?.cardsPerProject === 9 && afterOne?.childrenPerCard === 6,
  JSON.stringify(afterOne))
check('and the edited row changed', afterOne?.running === 11, String(afterOne?.running))

// --- the row that refuses ---

const alpha = await make('Alpha')
const bravo = await make('Bravo')
if (!alpha || !bravo) {
  console.log('FAIL  two cards')
  await stop(1)
}
const alphaToken = await tokenFor(alpha.id)
const bravoToken = await tokenFor(bravo.id)

/*
 * A card with subagents of its own, because the shape of what this row governs changed on
 * 2026-09-09 and this is where it would show. It was a lifetime count, so three spawns mattered;
 * it is a yes or no now, so they must not. A card that has already spawned is refused on exactly
 * the same terms as one that never has, and if some count survived the change these two cards
 * would answer differently.
 */
for (let i = 1; i <= 3; i++) await spawn(alpha, i)

const over = await askDispatch(alpha, alphaToken)
check('a card on a board that says no is refused', typeof over.deny === 'string' && !!over.deny,
  over.deny ?? `status ${over.status}, ok ${over.ok}`)
check('and names the card', (over.deny ?? '').includes('Alpha'), over.deny ?? '')
check('and says where the answer is changed', /ceiling/i.test(over.deny ?? ''), over.deny ?? '')
check('and says nothing running is stopped', /nothing already running is stopped/i.test(over.deny ?? ''),
  over.deny ?? '')

const other = await askDispatch(bravo, bravoToken)
check('and so is a card that has spawned none of its own', typeof other.deny === 'string' && !!other.deny,
  other.deny ?? `status ${other.status}`)

const refusals = st.events.filter((e) => String(e.type).startsWith('subagent.refused'))
check('the refusal is on the board as an event, not only in a log', refusals.length >= 2,
  `${refusals.length} events`)

/*
 * The control, and it is doing more work than a control usually does here. Everything above passes
 * against a door that denies every dispatch it is ever asked about. Only turning the row back to
 * yes and watching the same card go through says the door is reading the setting.
 *
 * Nothing that already exists is removed either way, which canon 15 forbids in as many words, so
 * the subagent rows are counted on both sides of the change.
 */
const rowsBefore = st.sessions.filter((s) => s.parentId === alpha.id && s.kind === 'subagent').length
await setLimits({ subagentsAllowed: true })
check('and yes reads back as yes', (await limits())?.subagentsAllowed === true)
const afterYes = await askDispatch(alpha, alphaToken)
check('a board set back to yes lets the same card dispatch', afterYes.deny === null && afterYes.ok,
  afterYes.deny ?? `status ${afterYes.status}`)
const rowsAfter = st.sessions.filter((s) => s.parentId === alpha.id && s.kind === 'subagent').length
check('and nothing was removed by either answer', rowsAfter === rowsBefore, `${rowsBefore} then ${rowsAfter}`)

// --- the hook itself, not only the door it asks ---

/*
 * Everything above tests the server's answer. This tests the thing that acts on it, which is what
 * the owner actually depends on: the CLI asks `garden-hook.mjs` before a dispatch, and a deny has
 * to come back out of it as the JSON shape the CLI reads. A door that refuses correctly behind a
 * hook that never asks would pass every check above and refuse nothing on his board.
 *
 * The hook is run as its own process with the card's own environment, exactly as the CLI runs it.
 * `isOwnSession` waves it through because `GARDEN_LAUNCH` and `GARDEN_MAIL_DIR` are unset, which is
 * the ordinary state of a hook invoked outside a launched card.
 */
const runHook = (card, token, toolName, n) =>
  new Promise((resolve) => {
    const child = spawnProcess(
      process.execPath,
      [join(ROOT, 'server', 'hooks', 'garden-hook.mjs')],
      {
        env: {
          ...process.env,
          GARDEN_PORT: String(PORT),
          GARDEN_SESSION_ID: card.id,
          GARDEN_SESSION_TOKEN: token,
          GARDEN_LAUNCH: undefined,
          GARDEN_MAIL_DIR: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', () => {})
    child.on('close', () => {
      let parsed = null
      try {
        parsed = JSON.parse(out)
      } catch {
        parsed = null
      }
      resolve({
        raw: out,
        decision: parsed?.hookSpecificOutput?.permissionDecision ?? null,
        reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? null,
      })
    })
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: `cli-hook-${card.id}`,
        tool_name: toolName,
        tool_use_id: `hook-${card.id}-${n}`,
        tool_input: { description: 'a thing', subagent_type: 'general-purpose' },
      }),
    )
  })

// The control above left the board saying yes, so turn it back to no to make the hook refuse.
await setLimits({ subagentsAllowed: false })

const denied = await runHook(alpha, alphaToken, 'Task', 1)
check('the hook denies a dispatch when the board says no', denied.decision === 'deny',
  denied.decision ?? denied.raw.slice(0, 120))
check('and hands the CLI the sentence rather than an empty deny',
  typeof denied.reason === 'string' && denied.reason.includes('Alpha'),
  denied.reason ?? '')

/*
 * The other name for the same tool. `hooks-install.ts` records that this project has been wrong
 * about which of the two arrives, so both are matched and both are checked; matching one and
 * guessing wrong would leave the panel showing a limit that refuses nothing.
 */
const deniedAgent = await runHook(alpha, alphaToken, 'Agent', 2)
check('and denies it under the other name the dispatch tool goes by',
  deniedAgent.decision === 'deny', deniedAgent.decision ?? deniedAgent.raw.slice(0, 120))

/*
 * The control that keeps this honest: a tool that is not a dispatch must pass through untouched,
 * or the check above would be satisfied by a hook that denies everything.
 */
const untouched = await runHook(alpha, alphaToken, 'Read', 3)
check('a tool that is not a dispatch is not denied', untouched.decision !== 'deny',
  untouched.decision ?? 'no decision')

/*
 * And the same dispatch, through the same hook, on a board that says yes. Without this the two
 * denies above are also satisfied by a hook that denies every Task it ever sees, which is a
 * different bug wearing the same green.
 */
await setLimits({ subagentsAllowed: true })
const allowedThrough = await runHook(alpha, alphaToken, 'Task', 4)
check('and the same dispatch passes the hook once the board says yes',
  allowedThrough.decision !== 'deny', allowedThrough.decision ?? 'no decision')

// --- the row that is held somewhere else entirely ---

/*
 * `subagents` is the CLI's figure and Garden only writes it down. `session.setRole` is what rewrites
 * a card's settings file, so this reaches the same file a launch would write without launching
 * anything. A card with its own team size is held to that instead, which is why this one is given
 * none.
 */
ws.send(JSON.stringify({ t: 'session.setRole', sessionId: bravo.id, roleClass: 'specialist' }))
await sleep(900)
const file = join(GARDEN_HOME, 'hooks', 'sessions', `${bravo.id}.json`)
const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
check('a settings file is written for the card', !!settings, settings ? 'present' : 'missing')
check('and the board figure reaches the CLI as its concurrency cap',
  settings?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === '7',
  String(settings?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS))

// --- and the three rows the server holds, refusing the thing each one governs ---

/*
 * The owner's instruction was "make sure all of the cieling buttons function properly", and a row
 * that stores a number is not yet a row that works. The three rows below are held by `overCeiling`,
 * which is old code this change does not touch, so this is a check that they still hold rather than
 * a check of anything new. Reporting five working rows without having watched three of them refuse
 * anything would be reporting a green nobody saw.
 *
 * Terminals are started here, which nothing above does. They are shells on a scratch board in a
 * temporary directory, so they spend no tokens and touch nothing of the owner's.
 */
/*
 * `reportsTo`, not `parentId`. The first draft of this said `parentId`, the server ignored it, no
 * card had a parent, and the spawn limit correctly refused nothing, which read exactly like the row
 * being broken. The check that saved it is the one immediately below the refusal: a refusal has to
 * name the parent, and an unnamed parent cannot be named.
 */
const createUnder = async (title, reportsTo, start = false) => {
  const before = st.sessions.length
  st.errors.length = 0
  ws.send(JSON.stringify({
    t: 'session.create', projectId: project.id, adapterId: 'shell', title, start, reportsTo,
  }))
  await sleep(700)
  return { made: st.sessions.length > before, said: st.errors[0] ?? null }
}

await setLimits({ childrenPerCard: 1 })
const firstChild = await createUnder('Child one', alpha.id)
check('a card may be given to a parent under its spawn limit', firstChild.made, firstChild.said ?? '')
const secondChild = await createUnder('Child two', alpha.id)
check('and the orchestrator spawn limit refuses the next one', !secondChild.made && !!secondChild.said,
  secondChild.said ?? 'it was made')
check('naming the parent and the figure',
  (secondChild.said ?? '').includes('Alpha') && (secondChild.said ?? '').includes('1'),
  secondChild.said ?? '')

await setLimits({ running: 1 })
const runningOne = await createUnder('Runner one', null, true)
check('a card may be started under the running limit', runningOne.made, runningOne.said ?? '')
await sleep(1200)
const runningTwo = await createUnder('Runner two', null, true)
check('and the running limit refuses the next start', !runningTwo.made && !!runningTwo.said,
  runningTwo.said ?? 'it was started')
check('naming the figure it refused against', /limit is 1|allowed 1|of 1/.test(runningTwo.said ?? ''),
  runningTwo.said ?? '')

const held = st.sessions.filter((s) => s.kind !== 'subagent' && !s.closedAt).length
await setLimits({ cardsPerProject: held })
const oneTooMany = await createUnder('One too many', null)
check('and the agent cards limit refuses a card past the ceiling',
  !oneTooMany.made && !!oneTooMany.said, oneTooMany.said ?? 'it was made')
check('naming what the board holds and what it allows',
  (oneTooMany.said ?? '').includes(String(held)), oneTooMany.said ?? '')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
await stop(failures === 0 ? 0 : 1)
