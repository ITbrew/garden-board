/**
 * Shots of a working card and of a message travelling a wire, on a scratch board.
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md, both asserted
 * before anything touches the socket. Nothing here reaches the owner's board.
 *
 * What it is for. The owner said the working card and the travelling message were too subtle, and
 * both are now louder. A screenshot can show a glow; it cannot show that the idle card beside it
 * stayed dark, that the glow is actually breathing rather than stuck, or that the wire is still lit
 * three seconds after the message went. So the run measures those from `getComputedStyle` and
 * prints what it measured, and the shots are for a reader who has not seen the code.
 *
 * The card is made to work the way a real card does, by posting the hook events the CLI posts, and
 * the wire carries a real message through `wire.send`. Nothing here reaches into the page to fake a
 * state.
 *
 *   npm run build
 *   node scripts/capture-glow.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const require = createRequire('C:/Garden/package.json')
const WebSocket = require('ws')
const puppeteer = require('puppeteer-core').default ?? require('puppeteer-core')

const OUT = 'C:\\Garden\\docs\\shots'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDE = 1440
const TALL = 950
const LIVE_PORT = 5178
/** What the app holds a pulse for, from `state.ts`. The run checks either side of it. */
const PULSE_MS = 3500

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const note = (s) => console.log(s)
const warnings = []
const warn = (s) => {
  warnings.push(s)
  console.log(`  WARNING: ${s}`)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-glow-shots-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch board for the glow shots\n')
mkdirSync(join(dir, 'docs'), { recursive: true })

const home = mkdtempSync(join(tmpdir(), 'garden-glow-home-'))
const st = { projects: [], sessions: [], wires: [], limits: null }
let ws = null
const say = (msg) => ws.send(JSON.stringify(msg))
const cardNamed = (title) => st.sessions.find((s) => s.title === title)

async function connect(port, key) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires ?? [] })
    } else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') {
      const i = st.sessions.findIndex((s) => s.id === m.session.id)
      if (i >= 0) st.sessions[i] = m.session
    } else if (m.t === 'wire.added') st.wires.push(m.wire)
    else if (m.t === 'error') note(`  server refused ${m.forT}: ${m.message}`)
  })
  await new Promise((r) => sock.on('open', r))
  ws = sock
  say({ t: 'hello', key })
  await sleep(600)
  return sock
}

/** A hook event, posted exactly as the CLI posts it. This is what makes a card working. */
async function hook(gardenSessionId, event) {
  const res = await fetch(`http://127.0.0.1:${garden.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })
  await res.text()
  await sleep(250)
}

// ---------------------------------------------------------------------------
// The board: one card working, one idle, one wire that will carry a message and one that will not
// ---------------------------------------------------------------------------

const garden = await startInstance({ home })
if (garden.port === LIVE_PORT) throw new Error(`refusing to run: the scratch port is ${LIVE_PORT}, the live one`)
const health = await (await fetch(`http://127.0.0.1:${garden.port}/health`)).json()
if (health.sessions !== 0) throw new Error(`refusing to run: ${health.sessions} sessions already on the scratch port`)
if (!health.app) throw new Error('the built app is not there. Run npm run build first.')
note(`scratch backend on ${garden.port}, home ${home}`)

const key = readFileSync(join(home, 'owner.key'), 'utf8').trim()
await connect(garden.port, key)

say({ t: 'project.add', path: dir.replace(/\\/g, '/') })
await sleep(1600)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) throw new Error('the scratch project was not added')

/*
 * Three cards, not two, so that a shot can hold a lit wire and an unlit one at the same moment.
 * Two would prove the wire changed; three prove the change is the pulse and not the whole board
 * getting brighter, which is the thing canon says must not happen.
 */
for (const [title, roleClass, adapterId] of [
  // A Claude card for the working one, because that is what a working card on the owner's board is,
  // and its role colour is the violet he actually sees. Shell cards are grey, which would have made
  // the glow look like a grey smudge that no real card wears.
  ['Ink', 'worker', 'claude'],
  ['Plumb', 'verifier', 'shell'],
  ['Quill', 'reviewer', 'shell'],
]) {
  say({
    t: 'session.create',
    projectId: project.id,
    adapterId,
    title,
    roleClass,
    reportsTo: null,
    start: false,
  })
  await sleep(500)
}
const ink = cardNamed('Ink')
const plumb = cardNamed('Plumb')
const quill = cardNamed('Quill')
if (!ink || !plumb || !quill) throw new Error('the scratch cards were not created')

say({ t: 'wire.create', projectId: project.id, sourceId: ink.id, targetId: plumb.id, bidirectional: true })
await sleep(500)
say({ t: 'wire.create', projectId: project.id, sourceId: plumb.id, targetId: quill.id, bidirectional: true })
await sleep(500)
const liveWire = st.wires.find((w) => w.sourceId === ink.id && w.targetId === plumb.id)
const quietWire = st.wires.find((w) => w.sourceId === plumb.id && w.targetId === quill.id)
if (!liveWire || !quietWire) throw new Error('the scratch wires were not created')

/*
 * Ink is made to work the way a card really does: the CLI posts SessionStart and then
 * UserPromptSubmit, and the second of those is what sets the status to working.
 *
 * The other two are given the SessionStart alone, which leaves them idle. That matters for the
 * comparison: a card created and never started reads `stopped`, and a stopped card is drawn dimmed
 * as switched off, so it would have been quieter than an idle card for a reason that has nothing to
 * do with this change. Idle is the state the owner's board is mostly in.
 */
await hook(ink.id, {
  hook_event_name: 'SessionStart',
  session_id: `glow-${Date.now()}`,
  transcript_path: 'C:/nonexistent/transcript.jsonl',
  cwd: dir,
})
await hook(ink.id, {
  hook_event_name: 'UserPromptSubmit',
  prompt_id: `glow-prompt-${Date.now()}`,
  prompt: 'make the working cards louder',
})
for (const card of [plumb, quill]) {
  await hook(card.id, {
    hook_event_name: 'SessionStart',
    session_id: `glow-idle-${card.id.slice(0, 8)}`,
    transcript_path: 'C:/nonexistent/transcript.jsonl',
    cwd: dir,
  })
}
await sleep(500)
const statuses = [ink, plumb, quill].map((c) => `${c.title}=${st.sessions.find((s) => s.id === c.id)?.status}`)
note(`card status: ${statuses.join(', ')}`)
if (st.sessions.find((s) => s.id === ink.id)?.status !== 'working') {
  warn('Ink is not working, so there is nothing to photograph')
}

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDE, height: TALL },
  args: [`--window-size=${WIDE},${TALL}`],
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

const shots = []
async function shoot(name, box, least = 28) {
  const view = page.viewport()
  const clipped = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
  clipped.width = Math.min(clipped.width, view.width - clipped.x)
  clipped.height = Math.min(clipped.height, view.height - clipped.y)
  const file = join(OUT, name)
  await page.screenshot({ path: file, clip: clipped })
  shots.push(file)
  note(`shot: ${name} at ${clipped.x},${clipped.y} ${clipped.width}x${clipped.height}, ${statSync(file).size} bytes`)
  if (clipped.height < least) warn(`${name} is ${clipped.height}px tall, which cannot hold what it is meant to show`)
  return clipped
}

async function rectOf(selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, selector)
}

/** The board itself, which is what every shot here is of. */
async function boardShot(name) {
  const box = await rectOf('.canvas')
  if (!box) {
    warn(`no shot ${name}: the canvas was not drawn`)
    return
  }
  return await shoot(name, box)
}

await page.goto(`http://127.0.0.1:${garden.port}/#key=${key}`, { waitUntil: 'networkidle2' })
await sleep(3000)
const opened = await page.evaluate(() => ({
  identity: document.querySelector('.app')?.getAttribute('data-identity') ?? 'no app element',
  cards: document.querySelectorAll('.node').length,
  busy: document.querySelectorAll('.node.is-busy').length,
  zoom: document.querySelector('.react-flow__viewport')?.style.transform ?? 'none',
}))
note(`owner page: identity=${opened.identity}, ${opened.cards} cards drawn, ${opened.busy} of them busy`)
note(`board transform, left at whatever the app chose: ${opened.zoom}`)
if (opened.identity !== 'owner') warn(`the page opened with the key is "${opened.identity}", not the owner`)
if (opened.busy !== 1) warn(`${opened.busy} cards are drawn busy, and exactly one should be`)

/*
 * What the browser actually computed, which is the only claim worth making about a glow.
 *
 * `box-shadow` is read twice about a second apart on purpose: the working card's glow breathes, so
 * two different radii are the evidence that it is animating rather than sitting at one value, and a
 * pair of identical readings is worth a warning.
 */
async function cardGlow() {
  return await page.evaluate(() => {
    const pick = (el) => (el ? getComputedStyle(el).boxShadow : null)
    return {
      busy: pick(document.querySelector('.node.is-busy')),
      idle: pick(document.querySelector('.node:not(.is-busy)')),
      dot: pick(document.querySelector('.node.is-busy .dot--working')),
      ring: (() => {
        const el = document.querySelector('.node.is-busy')
        if (!el) return null
        const s = getComputedStyle(el, '::before')
        return { padding: s.padding, animation: s.animationName }
      })(),
    }
  })
}

const first = await cardGlow()
await sleep(1000)
const second = await cardGlow()
note(`working card box-shadow, first reading:  ${first.busy}`)
note(`working card box-shadow, second reading: ${second.busy}`)
note(`idle card box-shadow:                    ${first.idle}`)
note(`working status dot box-shadow:           ${first.dot}`)
note(`working ring: padding ${first.ring?.padding}, animation ${first.ring?.animation}`)
if (first.busy === second.busy) warn('the working card glow read the same twice, so it may not be breathing')
if (!first.busy || first.busy.split('rgb').length < 3) {
  warn('the working card has no second shadow layer, so there is no glow outside it')
}
if (first.idle && first.idle.split('rgb').length > 2) {
  warn(`the idle card has more than the plain lift on it: ${first.idle}`)
}

/** Every wire on the board, with what it is drawing right now. */
async function wireLook() {
  return await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.react-flow__edge-path')]
    return {
      strokes: paths.map((p) => {
        const s = getComputedStyle(p)
        return { width: s.strokeWidth, stroke: s.stroke, filter: s.filter, pulsing: p.classList.contains('wire-pulse') }
      }),
      travellers: document.querySelectorAll('.react-flow__edge circle').length,
      motions: document.querySelectorAll('animateMotion').length,
    }
  })
}

const atRest = await wireLook()
note(`wires at rest: ${atRest.strokes.map((s) => `${s.width} ${s.stroke}`).join(' | ')}`)
if (atRest.strokes.some((s) => s.pulsing)) warn('a wire was already pulsing before anything was sent')
if (atRest.travellers) warn(`${atRest.travellers} travelling dots exist on a board where nothing has been sent`)

/*
 * A real message on a real wire. `wire.send` is the same route the board uses when one card writes
 * to another, so the pulse the page receives is the pulse the owner sees, not one this script drew.
 */
say({ t: 'wire.send', wireId: liveWire.id, text: 'a message that should be visible from across the room' })
await sleep(400)

const at400 = await wireLook()
const lit = at400.strokes.find((s) => s.pulsing)
note(`400ms after the message, the pulsed wire: width ${lit?.width}, stroke ${lit?.stroke}`)
note(`  its glow: ${lit?.filter}`)
note(`  travelling dots on the board: ${at400.travellers}, with ${at400.motions} motion animations`)
const quiet = at400.strokes.filter((s) => !s.pulsing)
note(`  the other wire, untouched: ${quiet.map((s) => `${s.width} ${s.stroke}`).join(' | ')}`)
if (!lit) warn('no wire is drawing the pulse 400ms after the message was sent')
if (at400.travellers !== 1) warn(`${at400.travellers} travelling dots, and exactly one should be running`)
if (quiet.some((s) => s.width !== atRest.strokes[0].width)) {
  warn('an idle wire changed width when the other one pulsed')
}
await boardShot('41-glow-pulse-400ms.png')

await sleep(2600)
const at3000 = await wireLook()
note(`3000ms after the message, still pulsing: ${at3000.strokes.some((s) => s.pulsing)}, travelling dots ${at3000.travellers}`)
if (!at3000.strokes.some((s) => s.pulsing)) warn('the pulse had already ended at 3000ms, which is shorter than it is meant to hold')
await boardShot('42-glow-pulse-3000ms.png')

/*
 * And after it is over. This is the shot that says the resting board did not get brighter: the same
 * wires, the same cards, one of them still working.
 */
await sleep(PULSE_MS - 3000 + 700)
const after = await wireLook()
note(`after the hold, still pulsing: ${after.strokes.some((s) => s.pulsing)}, travelling dots ${after.travellers}`)
if (after.strokes.some((s) => s.pulsing)) warn('the pulse never ended, so a wire stays lit for good')
if (after.travellers) warn('a travelling dot is still on the board after the pulse ended')
await boardShot('43-glow-cards-at-rest.png')

// ---------------------------------------------------------------------------

if (pageErrors.length) {
  for (const e of pageErrors) warn(`page error: ${e}`)
} else note('no page errors')
note(`shots written: ${shots.length}`)
note(warnings.length ? `warnings: ${warnings.length}` : 'no warnings')

await browser.close()
ws.close()
await garden.stop?.()
process.exit(0)
