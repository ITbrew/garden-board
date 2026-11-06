/**
 * A card's own answer about subagents beats the board's, in both directions.
 *
 * The owner asked for one board where one card has subagents and another does not: "make individual
 * card controls override the global cieling if the user wants one card to have sub agents/not the
 * other". The board's row on its own cannot express that, so the card carries an answer of its own
 * and this file is what says the two are actually wired together.
 *
 * What would go red before the change, which is the only reason to trust a green afterwards:
 *
 *   - `session.setRole` does not carry `subagentsAllowed`, so setting it reads back as undefined.
 *   - the dispatch door asks only the board, so the card set to yes on a board saying no is refused
 *     and the card set to no on a board saying yes is allowed. Both directions fail, separately.
 *   - the settings file is written from the board's answer alone, so a card set to no is launched
 *     without `Agent` on its deny list and can dispatch until somebody restarts it.
 *
 * The pairs matter more than any single check. Every assertion here is made against TWO cards on the
 * SAME board at the same moment, one with an answer and one without, because a door that ignored the
 * card and simply followed the board would satisfy half of them and a door that ignored the board
 * would satisfy the other half. Only the pair separates the two.
 *
 * Null is tested as a value rather than as an absence. A card that has never answered has to follow
 * the board, and a card that answered and then withdrew has to go back to following it, which is a
 * different code path: one is a column that was never written and the other is a null sent over the
 * wire on purpose.
 *
 * No terminals and no CLI. Cards are made switched off and the settings file is written by
 * `session.setRole` rather than by launching anything, so this spends no tokens.
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

const dir = mkdtempSync(join(tmpdir(), 'garden-card-override-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], errors: [], limits: null }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    const i = st.sessions.findIndex((s) => s.id === m.session.id)
    if (i >= 0) st.sessions[i] = m.session
  } else if (m.t === 'limits') st.limits = m
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

const setBoard = async (allowed) => {
  const held = await limits()
  ws.send(
    JSON.stringify({ t: 'limits.set', projectId: project.id, limits: { ...held, subagentsAllowed: allowed } }),
  )
  await sleep(400)
}

const make = async (title) => {
  const before = st.sessions.length
  ws.send(
    JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }),
  )
  await sleep(500)
  if (st.sessions.length === before) return null
  return st.sessions[st.sessions.length - 1]
}

/** The card's own answer. `null` is a value here and means it withdraws and follows the board. */
const setCard = async (id, allowed) => {
  ws.send(JSON.stringify({ t: 'session.setRole', sessionId: id, subagentsAllowed: allowed }))
  await sleep(400)
  return st.sessions.find((s) => s.id === id)
}

const tokenFor = async (id) => {
  st.token = null
  ws.send(JSON.stringify({ t: 'session.token', sessionId: id }))
  for (let i = 0; i < 20 && !st.token; i++) await sleep(100)
  return st.token
}

/** The question Garden's hook asks before a dispatch, asked exactly as the hook asks it. */
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

const alpha = await make('Alpha')
const bravo = await make('Bravo')
if (!alpha || !bravo) {
  console.log('FAIL  two cards')
  await stop(1)
}
const alphaToken = await tokenFor(alpha.id)
const bravoToken = await tokenFor(bravo.id)

// --- a card starts with no answer of its own ---

check('a fresh card has no answer of its own', alpha.subagentsAllowed === null, String(alpha.subagentsAllowed))

// --- the board says no, and one card says yes ---

await setBoard(false)
const alphaYes = await setCard(alpha.id, true)
check('the card takes yes and reads it back', alphaYes?.subagentsAllowed === true, String(alphaYes?.subagentsAllowed))

const yesOnNoBoard = await askDispatch(alpha, alphaToken)
check('a card set to yes dispatches on a board that says no', yesOnNoBoard.deny === null && yesOnNoBoard.ok,
  yesOnNoBoard.deny ?? `status ${yesOnNoBoard.status}`)

/*
 * The pair. Without this, a door that had simply stopped asking the board would pass the check
 * above and refuse nothing anywhere.
 */
const silentOnNoBoard = await askDispatch(bravo, bravoToken)
check('and the card beside it, which said nothing, is still refused',
  typeof silentOnNoBoard.deny === 'string' && !!silentOnNoBoard.deny,
  silentOnNoBoard.deny ?? `status ${silentOnNoBoard.status}`)

// --- the board says yes, and one card says no ---

await setBoard(true)
const alphaNo = await setCard(alpha.id, false)
check('the card takes no and reads it back', alphaNo?.subagentsAllowed === false, String(alphaNo?.subagentsAllowed))

const noOnYesBoard = await askDispatch(alpha, alphaToken)
check('a card set to no is refused on a board that says yes',
  typeof noOnYesBoard.deny === 'string' && !!noOnYesBoard.deny,
  noOnYesBoard.deny ?? `status ${noOnYesBoard.status}`)
check('and the refusal says the answer is the card\'s rather than the board\'s',
  /set not to use subagents/i.test(noOnYesBoard.deny ?? '') && /on the card/i.test(noOnYesBoard.deny ?? ''),
  noOnYesBoard.deny ?? '')

const silentOnYesBoard = await askDispatch(bravo, bravoToken)
check('and the card beside it, which said nothing, dispatches',
  silentOnYesBoard.deny === null && silentOnYesBoard.ok,
  silentOnYesBoard.deny ?? `status ${silentOnYesBoard.status}`)

// --- withdrawing the answer goes back to following the board ---

const alphaNull = await setCard(alpha.id, null)
check('a card can withdraw its answer', alphaNull?.subagentsAllowed === null, String(alphaNull?.subagentsAllowed))
const withdrawn = await askDispatch(alpha, alphaToken)
check('and follows the board again', withdrawn.deny === null && withdrawn.ok,
  withdrawn.deny ?? `status ${withdrawn.status}`)

await setBoard(false)
const withdrawnOnNo = await askDispatch(alpha, alphaToken)
check('in both directions', typeof withdrawnOnNo.deny === 'string' && !!withdrawnOnNo.deny,
  withdrawnOnNo.deny ?? `status ${withdrawnOnNo.status}`)

// --- the settings file the CLI reads, not only the door Garden answers ---

/*
 * The door is asked per dispatch and the settings file is read once at launch, and both have to
 * carry the same answer. A card launched with `Agent` allowed and a door that would refuse it is a
 * card whose owner sees a refusal he cannot explain from anything on the card.
 */
const settingsFor = (id) => {
  const p = join(GARDEN_HOME, 'hooks', 'sessions', `${id}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

await setBoard(true)
await setCard(alpha.id, false)
const denied = settingsFor(alpha.id)
check('a card set to no is launched with the dispatch tool denied',
  !!denied && (denied.permissions?.deny ?? []).includes('Agent'),
  JSON.stringify(denied?.permissions?.deny ?? null))

await setCard(alpha.id, true)
const allowed = settingsFor(alpha.id)
check('and set back to yes it is not', !!allowed && !(allowed.permissions?.deny ?? []).includes('Agent'),
  JSON.stringify(allowed?.permissions?.deny ?? null))

// --- and through the hook the CLI actually runs ---

const runHook = (card, token, toolName, n) =>
  new Promise((resolve) => {
    const child = spawnProcess(process.execPath, [join(ROOT, 'server', 'hooks', 'garden-hook.mjs')], {
      env: {
        ...process.env,
        GARDEN_PORT: String(PORT),
        GARDEN_SESSION_ID: card.id,
        GARDEN_SESSION_TOKEN: token,
        GARDEN_LAUNCH: undefined,
        GARDEN_MAIL_DIR: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
      resolve({ raw: out, decision: parsed?.hookSpecificOutput?.permissionDecision ?? null })
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

await setBoard(false)
await setCard(alpha.id, true)
const hookYes = await runHook(alpha, alphaToken, 'Task', 1)
check('the hook lets the yes card through on a board that says no', hookYes.decision !== 'deny',
  hookYes.decision ?? 'no decision')
const hookSilent = await runHook(bravo, bravoToken, 'Task', 2)
check('and denies the card beside it', hookSilent.decision === 'deny',
  hookSilent.decision ?? hookSilent.raw.slice(0, 120))

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
await stop(failures ? 1 : 0)
