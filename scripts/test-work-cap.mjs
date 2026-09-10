/**
 * How many cards may be WORKING at once, and what happens to mail that would start one more.
 *
 * Written before the cap exists, and it fails today on purpose. That is the point of it: it is the
 * red half of the evidence, so when the cap is built the same file is what says the cap does
 * something. A test written afterwards, that has only ever been green, proves nothing about the
 * behaviour it claims to guard.
 *
 * What is being capped is work, not wakefulness. The board already counts cards that are switched
 * on, and the owner's position is that a card sitting there awake costs nothing worth limiting: what
 * costs money and machine is how many are mid-turn at the same moment. So the enforcement point is
 * `flushMailWake` in `server/src/index.ts`, at the quiet check, immediately before the line that
 * types a message into a card and thereby makes it work.
 *
 * The rule that shapes every assertion below is canon `15-guardrails.md`: a guardrail must never
 * stop mail, in those words, and nothing in this project gates `/mail`. So the cap is a delay and
 * never a refusal. The message is still accepted, still lands in the recipient's INBOX.md, and is
 * still typed in later when a slot frees. A queue that never drains would be worse than a refusal,
 * because a refusal is at least visible; that is why the draining assertion carries the most weight
 * here rather than the queueing one.
 *
 * Runs against a server of its own, on its own port, with its own workspace and its own database.
 * Nothing here can reach the owner's board.
 *
 *   npm run build && node scripts/test-work-cap.mjs
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/**
 * How many cards may be mid-turn at once, for this test.
 *
 * Two, because the interesting cases need a board that is at the ceiling while a card that is NOT
 * at it sits there idle and reachable. It is sent as `working` alongside the three limits that
 * exist today; `limits.set` copies out the fields it knows by name, so an unknown one is dropped
 * rather than rejected, and this line starts meaning something the moment the field exists.
 *
 * If the cap ends up reading `limits.running` instead of a field of its own, change WORK_FIELD and
 * nothing else. It cannot be both: `running` is what the create and start paths already check, so
 * a board of four live cards under a work ceiling of two could not be built in the first place.
 */
const WORK_CEILING = 2
const WORK_FIELD = 'working'

const garden = await startInstance()
const PORT = garden.port
const HOME = garden.home
const mailFile = (id, name) => join(HOME, 'mail', id, name)
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

const dir = mkdtempSync(join(tmpdir(), 'garden-workcap-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

/*
 * The wake line, which is the only honest evidence that a card was actually made to work.
 *
 * Read off the byte stream rather than off a status or a return value: the server types this line
 * into the card's terminal and presses Enter, and the terminal echoing it back is the card really
 * being interrupted rather than the board saying it was.
 *
 * One wake produces several matches, because a shell card echoes the line and then complains that
 * no such command exists, quoting it back. So only whether this number CHANGED is ever read here,
 * never the number itself.
 */
const WAKE = /just arrived on (?:one of your wires|your wires)/g
const stream = new Map()
const wakes = (id) => (String(stream.get(id) ?? '').match(WAKE) ?? []).length

/**
 * How long to wait before believing that nothing happened.
 *
 * Typing is not instant: the server writes the line, presses Enter sixty milliseconds later, and the
 * terminal echoes it back over the socket after that. An assertion that "the card was not made to
 * work" taken the moment the send returns is measuring the round trip rather than the cap, and it
 * passes whether the cap exists or not. That mistake was in the first version of this file and every
 * queueing assertion in it was green against a server with no cap in it at all.
 */
const SETTLE = 3000

const st = { projects: [], sessions: [], wires: [], errors: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'session.data') stream.set(m.sessionId, (stream.get(m.sessionId) ?? '') + m.data)
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

/*
 * The three existing limits are set out of the way on purpose. This test is about the work ceiling
 * and nothing else, and a board that refused to start its fourth card would fail here for a reason
 * that has nothing to do with what is being measured.
 */
ws.send(
  JSON.stringify({
    t: 'limits.set',
    projectId: project.id,
    limits: { running: 30, cardsPerProject: 40, childrenPerCard: 10, [WORK_FIELD]: WORK_CEILING },
  }),
)
await sleep(400)

// --- the board ---

const make = async (title) => {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
  await sleep(1500)
  const card = st.sessions.find((s) => s.title === title)
  if (!card) {
    console.log(`FAIL  could not create "${title}"`)
    await stop(1)
  }
  return card
}

/*
 * Live shells rather than cards that merely hold a status. The cap has to survive an implementation
 * that only counts cards with a process attached, and a synthetic board of status rows would pass
 * against that implementation while proving nothing.
 */
const busyA = await make('Busy A')
const busyB = await make('Busy B')
const reader = await make('Reader')
const sender = await make('Sender')

ws.send(
  JSON.stringify({
    t: 'wire.create',
    projectId: project.id,
    sourceId: sender.id,
    targetId: reader.id,
    label: 'work orders',
  }),
)
await sleep(600)
check('a wire from the sender to the reader', st.wires.some((w) => w.sourceId === sender.id && w.targetId === reader.id))

// --- driving status the way the CLI does, through the hook spine ---

const hook = async (sessionId, event) =>
  fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })

/*
 * Real hook payloads, not a back door. `UserPromptSubmit` is what puts a card into `working` in
 * `ingest.ts` and `Stop` is what takes it out, so a card driven this way is in the same state by
 * the same path as a card the owner typed into. Anything that reached into the database directly
 * would be testing the test.
 */
const startWorking = (card, ask) =>
  hook(card.id, {
    hook_event_name: 'UserPromptSubmit',
    session_id: `cli-${card.id}`,
    prompt_id: `p-${card.id}`,
    prompt: ask,
  })
const goQuiet = (card) =>
  hook(card.id, { hook_event_name: 'Stop', session_id: `cli-${card.id}`, prompt_id: `p-${card.id}` })
const askForInput = (card) =>
  hook(card.id, { hook_event_name: 'Notification', session_id: `cli-${card.id}`, message: 'permission prompt' })

/*
 * One SessionStart for the reader, and it is load-bearing rather than decoration.
 *
 * `flushMailWake` will not type into a card until it has seen a hook event newer than the moment
 * the card came up, because stamping "idle" when the shell spawns is not evidence that a CLI is
 * listening yet. Without this the reader would queue every message for a reason that has nothing
 * to do with the ceiling, and the whole run would be red for the wrong cause.
 */
await hook(reader.id, { hook_event_name: 'SessionStart', session_id: `cli-${reader.id}` })
await sleep(2000)

const post = async (text, kind = 'work') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: sender.id, to: reader.id, text, kind, taskId: 'cap-test-2026-08-13' }),
  })
  return { status: res.status, said: await res.text() }
}

/** Wait for the reader's terminal to show one more wake line than it did, or give up saying so. */
const waitForWake = async (was, ms = 12_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (wakes(reader.id) > was) return true
    await sleep(400)
  }
  return false
}

// --- the control: under the ceiling, a message is typed in ---

/*
 * This one exists so a green queueing assertion cannot be mistaken for a working cap. Without a
 * control, a board that had simply stopped delivering mail altogether would pass every other check
 * in this file.
 */
const before = wakes(reader.id)
const under = await post('message one, sent with the board quiet')
check('a message sent while the board is under the ceiling is accepted', under.status === 200, `${under.status} ${under.said}`)
check('and the card is actually made to work', await waitForWake(before), under.said)
check('and the sender is told it was told on screen', /told on screen/.test(under.said), under.said)

// The reader's shell echoed the line it was sent, so let the stream go quiet before measuring again.
await sleep(SETTLE)

// --- at the ceiling: accepted, queued, and the reason is the board rather than the card ---

await startWorking(busyA, 'a long refactor')
await startWorking(busyB, 'a long review')
await sleep(600)
const working = st.sessions.filter((s) => s.status === 'working').length
check(`${WORK_CEILING} cards are working, so the board is at its ceiling`, working === WORK_CEILING, `${working} working`)

/*
 * Nothing in the message text may contain a word this file greps for. An earlier version said "at
 * the ceiling" in the body, the body is copied into SENT.md under the entry, and the check that the
 * SENT.md note names the ceiling then matched the test's own words rather than anything the server
 * wrote. It was green against a server with no cap in it.
 */
const atCeiling = wakes(reader.id)
const queued = await post('message two, sent with two cards mid-turn')
await sleep(SETTLE)

/*
 * Canon 15 again: whatever else a guardrail does, it does not stop mail. If this ever goes red the
 * cap has been built as a refusal and it is the cap that is wrong, not this line.
 */
check('a message sent at the ceiling is not refused', queued.status === 200, `${queued.status} ${queued.said}`)
check(
  'and it is in the recipient\'s inbox all the same',
  readIf(mailFile(reader.id, 'INBOX.md')).includes('message two'),
  readIf(mailFile(reader.id, 'INBOX.md')).trim().slice(-60),
)
check(
  'but the card is not made to work while the board is full',
  wakes(reader.id) === atCeiling,
  `${wakes(reader.id)} wake lines, was ${atCeiling}`,
)
check(
  'the sender is told the BOARD is at its work ceiling',
  /ceiling|work limit|working limit/i.test(queued.said),
  queued.said,
)
/*
 * Two things this answer must not be, and the second is why "told on screen" is forbidden here as
 * well as the busy wording. Today the answer is a delivery, so this line is red for the same reason
 * as the one above it rather than for a reason of its own.
 */
check(
  'and not that the card is busy, which is a different fact',
  !/mid-turn|is busy|told on screen/i.test(queued.said),
  queued.said,
)
const noted = (readIf(mailFile(sender.id, 'SENT.md')).match(/^kind `.*$/gm) ?? []).pop() ?? ''
check('the sender\'s own record says the same thing', /ceiling|work limit|working limit/i.test(noted), noted)

// --- and it drains, which is the assertion that matters most ---

/*
 * A queue that never empties is worse than a refusal: the sender was told to wait, so it waits, and
 * the work stops with nothing on the board saying why. The slot is freed by a card finishing its
 * turn, and nothing new is sent here. The message already sitting in the queue is the one that has
 * to arrive.
 */
const beforeDrain = wakes(reader.id)
await goQuiet(busyA)
check(
  'a working card going quiet frees a slot',
  await waitForWake(beforeDrain),
  `still ${wakes(reader.id)} wake lines`,
)

await sleep(SETTLE)

// --- needs-input is not work, and must not hold a slot ---

/*
 * A card sitting on a permission prompt is spending nothing and doing nothing. If it counted, the
 * board would deadlock in the one situation where the owner most needs another card to be able to
 * reach him: everything blocked, waiting on him, and nothing able to say so.
 */
await startWorking(busyA, 'back to work')
await sleep(600)
const full = st.sessions.filter((s) => s.status === 'working').length
check(`the board is back at ${WORK_CEILING}`, full === WORK_CEILING, `${full} working`)

const beforeInput = wakes(reader.id)
const held = await post('message three, sent with both cards mid-turn again')
await sleep(SETTLE)
check('a message sent while it is full is accepted again', held.status === 200, `${held.status} ${held.said}`)
check('and holds', wakes(reader.id) === beforeInput, `${wakes(reader.id)} wake lines, was ${beforeInput}`)

/*
 * Snapshotted again here rather than reusing the count from before the send. If the message was
 * typed in the moment it arrived, which is what happens today, the earlier number is already stale
 * and waiting for it to rise would return true instantly and call a delivery that happened before
 * the permission prompt evidence that it happened because of it.
 */
const beforeRelease = wakes(reader.id)
await askForInput(busyB)
await sleep(600)
const stillWorking = st.sessions.filter((s) => s.status === 'working').length
check('a card on a permission prompt is not counted as working', stillWorking === WORK_CEILING - 1, `${stillWorking} working`)
check('so the queued message is typed in', await waitForWake(beforeRelease), `no new wake line in ${12} seconds`)

for (const s of [busyA, busyB, reader, sender]) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(300)
}
console.log(failures ? `\n${failures} failed` : '\nall good')
await stop(failures ? 1 : 0)
