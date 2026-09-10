/**
 * Shots of the task-ownership surface, on a scratch board of its own.
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md. Both are
 * asserted before anything touches the socket rather than intended: the port must not be the live
 * one, and `/health` must report zero sessions. Nothing here reaches the owner's board.
 *
 * The board it builds is made the way a real one is. Tasks are created through `task.create`, work
 * starts because a piece of mail moved it, the reassignment is one whose evidence the server
 * checked, the refusal is a real `/claim` against a real territory, and the unbound row comes from
 * the migration reading its own mail history when a second server opens the same home. A fixture
 * that inserted rows would prove the panel can draw a shape, which is not what is being reviewed.
 *
 * WHAT CHANGED IN THE CLIPS, since a blind reviewer lost two answers to them.
 *
 * The refusal pill's panel is absolutely positioned under the pill so that opening one does not
 * shove the pills beside it along the row, and the old shot hung a fixed box off the pill's own
 * corner. A fixed box is only right while the pill happens to sit somewhere the box fits, and on
 * this board it did not: the shot began part-way down the panel with the pill itself above the top
 * edge. The board is a transformed canvas, so `scrollIntoView` cannot fix that; nothing scrolls.
 * This drags the canvas the way a hand would, puts the pill in a known corner, and then clips to
 * the union of the pill and the panel it opened, so the frame holds both by construction. The
 * union is checked afterwards and the run says so if the pill is not inside the frame.
 *
 * The guest banner was two banners, and the shot caught the second one as a single row of pixels
 * at the bottom edge. They are one banner now, so there is one box to clip, and the shot is taken
 * after a guest has actually pressed something: an empty banner would photograph the half of the
 * change that is only a line of text. Every clip prints its box and warns if it comes out thinner
 * than a line of text, because that is what went unnoticed last time.
 *
 *   npm run build
 *   node apps/web/src/capture-task-ownership.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

// Resolved from the repository root rather than from beside this file, because this file is not
// where its dependencies are and the whole reason for that is in the header above.
const require = createRequire('C:/Garden/package.json')
const WebSocket = require('ws')
const puppeteer = require('puppeteer-core').default ?? require('puppeteer-core')

const OUT = 'C:\\Garden\\docs\\shots'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 2200
const HEIGHT = 1500
const LIVE_PORT = 5178

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const note = (s) => console.log(s)
const warnings = []
const warn = (s) => {
  warnings.push(s)
  console.log(`  WARNING: ${s}`)
}

// The scratch workspace. A real directory on disk, because an acceptance reference is hashed off
// the file it names and a made-up path would be refused.
const dir = mkdtempSync(join(tmpdir(), 'garden-taskown-shots-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch board for the task-ownership shots\n')
mkdirSync(join(dir, 'docs'), { recursive: true })
writeFileSync(
  join(dir, 'docs', 'work-order.md'),
  '# Work order\n\nDraw task ownership on the board: the panel, the card face and the refusals.\n',
)

// The home outlives the first server on purpose. The unbound row exists only because a second
// server opened the same workspace and read the mail history it found there.
const home = mkdtempSync(join(tmpdir(), 'garden-taskown-home-'))

const state = { projects: [], sessions: [], wires: [], tasks: [], reassignments: [], refusals: [], limits: null }
let ws = null
const refused = []

const say = (msg) => ws.send(JSON.stringify(msg))
const cardNamed = (title) => state.sessions.find((s) => s.title === title)

async function connect(port, key) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      Object.assign(state, {
        projects: m.projects,
        sessions: m.sessions,
        wires: m.wires ?? [],
        tasks: m.tasks ?? [],
        reassignments: m.reassignments ?? [],
        refusals: m.refusals ?? [],
      })
    } else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'session.added') state.sessions.push(m.session)
    else if (m.t === 'wire.added') state.wires.push(m.wire)
    else if (m.t === 'limits') state.limits = m.limits
    else if (m.t === 'task.state') {
      state.tasks = m.tasks
      state.reassignments = m.reassignments
      state.refusals = m.refusals
    } else if (m.t === 'error') {
      refused.push(`${m.forT}: ${m.message}`)
      note(`  server refused ${m.forT}: ${m.message}`)
    }
  })
  await new Promise((r) => sock.on('open', r))
  ws = sock
  say({ t: 'hello', key })
  await sleep(600)
  return sock
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

// ---------------------------------------------------------------------------
// The board, built on the first server
// ---------------------------------------------------------------------------

let garden = await startInstance({ home })

if (garden.port === LIVE_PORT) throw new Error(`refusing to run: the scratch port is ${LIVE_PORT}, the live one`)
const health = await (await fetch(`http://127.0.0.1:${garden.port}/health`)).json()
if (health.sessions !== 0) throw new Error(`refusing to run: ${health.sessions} sessions already on the scratch port`)
if (!health.app) throw new Error('the built app is not there. Run npm run build first.')
note(`scratch backend on ${garden.port}, home ${home}`)
note(`/health on the scratch port: ${health.sessions} sessions`)

// The key the server minted for this home, so this connection is the owner and keyed. Without it
// the enforce shot at the end cannot be taken at all: the server refuses to turn enforcement on
// from a connection that could not turn it off again.
const key = readFileSync(join(home, 'owner.key'), 'utf8').trim()
await connect(garden.port, key)

say({ t: 'project.add', path: dir.replace(/\\/g, '/') })
await sleep(1600)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) throw new Error('the scratch project was not added')
say({ t: 'limits.get', projectId: project.id })
await sleep(300)

const CARDS = [
  ['Orchestrator', 'orchestrator'],
  ['Ink', 'worker'],
  ['Quill', 'worker'],
  ['Slate', 'reviewer'],
  ['Plumb', 'verifier'],
]
for (const [title, roleClass] of CARDS) {
  say({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title,
    roleClass,
    reportsTo: title === 'Orchestrator' ? null : (cardNamed('Orchestrator')?.id ?? null),
    start: false,
  })
  await sleep(500)
}
const boss = cardNamed('Orchestrator')
const ink = cardNamed('Ink')
const quill = cardNamed('Quill')
const slate = cardNamed('Slate')
const plumb = cardNamed('Plumb')
for (const [name, card] of [['Ink', ink], ['Quill', quill], ['Slate', slate], ['Plumb', plumb]]) {
  if (!card) throw new Error(`the card "${name}" was not created`)
}

// A wire is what permits a message, so the mail below needs one. Only drawn where the chain has
// not already drawn it, rather than blindly, so this does not depend on whether `reportsTo` wires
// itself up today.
for (const card of [ink, quill, slate, plumb]) {
  const already = state.wires.some(
    (w) => (w.sourceId === boss.id && w.targetId === card.id) || (w.targetId === boss.id && w.sourceId === card.id),
  )
  if (already) continue
  say({ t: 'wire.create', projectId: project.id, sourceId: boss.id, targetId: card.id, bidirectional: true })
  await sleep(350)
}
note(`cards: ${state.sessions.length}, wires: ${state.wires.length}`)

/*
 * A task id that only ever existed as a label on a piece of mail, which is what every task on the
 * owner's real board is today. Nothing declares it; it is delivered, and the migration finds it.
 */
note(await post(garden.port, '/mail', {
  from: boss.id,
  to: 'Quill',
  kind: 'work',
  taskId: 'legacy-mail-07',
  text: 'Have a look at the mail shim and tell me what it does about kinds it does not know.',
}).then((r) => `legacy mail: ${r.status} ${r.text.slice(0, 120)}`))
await sleep(400)

// The task the shots are mostly about: an owner, an assigner, a verifier, a territory, and an
// acceptance reference hashed off a file that really is in the project.
say({
  t: 'task.create',
  projectId: project.id,
  task: {
    id: 'shots-panel-01',
    ownerId: ink.id,
    assignerId: boss.id,
    verifierId: plumb.id,
    territory: ['apps/web/src', 'docs/shots'],
    acceptanceRef: { path: 'docs/work-order.md' },
  },
})
await sleep(500)

// The one that changes hands, with a required role so the reassignment has evidence to check.
say({
  t: 'task.create',
  projectId: project.id,
  task: {
    id: 'shots-audit-02',
    ownerId: quill.id,
    assignerId: boss.id,
    requiredRole: 'reviewer',
    acceptance: 'Read every refusal the mail shim can produce and say which of them a card can act on.',
  },
})
await sleep(500)

// Work starts because a hand-off happened, not because anything set a field. This is what moves
// shots-panel-01 from assigned to working.
note(await post(garden.port, '/mail', {
  from: boss.id,
  to: 'Ink',
  kind: 'work',
  taskId: 'shots-panel-01',
  text: 'The panel, the card face and the refusal pill. Acceptance is the work order in docs.',
}).then((r) => `work mail: ${r.status} ${r.text.slice(0, 120)}`))
await sleep(500)

// A reassignment the server had to agree with: shots-audit-02 requires a reviewer, Quill is a
// worker, and Slate is a reviewer. The same call with any other reason is refused.
say({
  t: 'task.reassign',
  projectId: project.id,
  taskId: 'shots-audit-02',
  toOwnerId: slate.id,
  reason: 'missing_capability',
  note: 'Quill is a worker and this needs a reviewer to sign it off.',
})
await sleep(500)

/*
 * A real refusal, through the door a real one comes through. Ink holds shots-panel-01, whose
 * territory is apps/web/src and docs/shots, and this is a write to neither. At shadow the write is
 * allowed and the refusal is recorded, which is the whole of canon's rollout.
 */
const claim = await post(garden.port, '/claim', { gardenSessionId: ink.id, path: 'server/src/index.ts' })
note(`claim outside territory: ${claim.status} ${claim.text.slice(0, 200)}`)
await sleep(400)

say({ t: 'task.list', projectId: project.id })
await sleep(500)
note(`tasks: ${state.tasks.map((t) => `${t.id}=${t.state}`).join(', ')}`)
note(`reassignments: ${state.reassignments.length}, refusals: ${state.refusals.length}`)
note(`refusal types: ${state.refusals.map((r) => r.type).join(', ')}`)

// ---------------------------------------------------------------------------
// The restart, which is what makes the unbound row
// ---------------------------------------------------------------------------

ws.close()
await garden.stop()
await sleep(600)
garden = await startInstance({ home })
note(`second backend on ${garden.port}, same home`)
await connect(garden.port, key)
say({ t: 'task.list', projectId: project.id })
await sleep(600)
const unbound = state.tasks.filter((t) => t.state === 'unbound').map((t) => t.id)
note(`unbound after the restart: ${unbound.join(', ') || 'none'}`)

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: [`--window-size=${WIDTH},${HEIGHT}`],
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(`http://127.0.0.1:${garden.port}`, { waitUntil: 'networkidle2' })
await sleep(3000)

const shots = []

/*
 * One place every screenshot goes through, so that a clip that came out as a sliver says so in the
 * run rather than in a reviewer's report a day later. `least` is the smallest height that could
 * hold a line of text and its padding.
 */
async function shoot(name, box, least = 28) {
  const clipped = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
  clipped.width = Math.min(clipped.width, WIDTH - clipped.x)
  clipped.height = Math.min(clipped.height, HEIGHT - clipped.y)
  const file = join(OUT, name)
  await page.screenshot({ path: file, clip: clipped })
  shots.push(file)
  const size = statSync(file).size
  note(`shot: ${name} at ${clipped.x},${clipped.y} ${clipped.width}x${clipped.height}, ${size} bytes`)
  if (clipped.height < least) warn(`${name} is ${clipped.height}px tall, which cannot hold what it is meant to show`)
  if (clipped.width < 40) warn(`${name} is ${clipped.width}px wide`)
  return clipped
}

async function rectOf(selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }, selector)
}

/*
 * Scroll a panel row into the window before clipping it.
 *
 * The rail is an ordinary scrolling column, and a row near the bottom of it hangs past the window,
 * so a clip taken from its rectangle is clamped at the screen edge and the shot stops part-way down
 * the row. That is how images 4 and 5 lost their forms: the forms grew when the explanatory
 * sentences went in, the rows grew with them, and nothing scrolled. Tall rows are put with their
 * top near the window's top so that the whole of them fits below it, short rows only far enough in
 * to clear the bottom.
 */
async function ensureVisible(selector, topAt = 110) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await rectOf(selector)
    if (!r) return false
    const room = HEIGHT - topAt - 20
    let dy = 0
    if (r.height > room || r.y < topAt) dy = r.y - topAt
    else if (r.bottom > HEIGHT - 20) dy = r.bottom - (HEIGHT - 20)
    if (Math.abs(dy) < 3) return true
    const moved = await page.evaluate(
      (sel, d) => {
        const el = document.querySelector(sel)
        if (!el) return 0
        for (let n = el.parentElement; n; n = n.parentElement) {
          const s = getComputedStyle(n)
          if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2) {
            const before = n.scrollTop
            n.scrollTop = before + d
            return n.scrollTop - before
          }
        }
        return 0
      },
      selector,
      dy,
    )
    if (Math.abs(moved) < 1) return true
    await sleep(180)
  }
  return true
}

/*
 * `must` is the part of the shot the reviewer is being asked about, named rather than assumed. The
 * two form shots stopped above their send buttons and nothing in the run said so, so every clip
 * that has a subject inside it now says whether that subject is in the frame.
 */
async function clip(name, selector, pad = 24, must = null) {
  const box = await rectOf(selector)
  if (!box || box.width < 2) {
    warn(`no shot ${name}: ${selector} was not found, or had no size`)
    return
  }
  await ensureVisible(selector)
  await sleep(200)
  const again = await rectOf(selector)
  const clipped = await shoot(name, {
    x: again.x - pad,
    y: again.y - pad,
    width: again.width + pad * 2,
    height: again.height + pad * 2,
  })
  if (must && clipped) {
    const inner = await rectOf(`${selector} ${must}`)
    if (!inner) warn(`${name}: ${must} was not drawn inside ${selector}`)
    else {
      const inside =
        inner.x >= clipped.x &&
        inner.y >= clipped.y &&
        inner.right <= clipped.x + clipped.width &&
        inner.bottom <= clipped.y + clipped.height
      if (inside) note(`  ${name}: ${must} is inside the frame, at ${Math.round(inner.x)},${Math.round(inner.y)}`)
      else warn(`${name}: ${must} is outside the frame, at ${Math.round(inner.x)},${Math.round(inner.y)}`)
    }
  }
  return clipped
}

async function full(name) {
  const file = join(OUT, name)
  await page.screenshot({ path: file })
  shots.push(file)
  note(`shot: ${name} full page, ${statSync(file).size} bytes`)
}

// Every control is clicked rather than set from outside. A shot of a panel forced open by script
// says the panel renders and says nothing about whether anybody can get to it.
async function click(selector) {
  const done = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    el.click()
    return true
  }, selector)
  await sleep(500)
  return done
}

async function clickText(scope, text) {
  const done = await page.evaluate(
    (sel, want) => {
      const root = document.querySelector(sel)
      if (!root) return false
      const btn = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === want)
      if (!btn) return false
      btn.click()
      return true
    },
    scope,
    text,
  )
  await sleep(500)
  return done
}

/*
 * Drag the canvas by hand, because nothing on it scrolls.
 *
 * The board is one transformed layer inside a pane of fixed size, so a node outside the pane is not
 * off the bottom of a scroll area, it is not drawn at all: `scrollIntoView` has nothing to move.
 * Panning is the only way to bring one in, and doing it through the pointer means the app's own
 * pan handler moves its own state, so nothing here is holding a transform that React will undo on
 * the next render. The start point is any spot where the pane itself is the top element, chosen so
 * that the end of the drag is still inside the window.
 */
async function panBy(dx, dy) {
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return true
  const spot = await page.evaluate(
    (ddx, ddy, w, h) => {
      const pane = document.querySelector('.react-flow__pane')
      if (!pane) return null
      const r = pane.getBoundingClientRect()
      for (let fy = 0.12; fy <= 0.92; fy += 0.08) {
        for (let fx = 0.08; fx <= 0.94; fx += 0.08) {
          const x = r.x + r.width * fx
          const y = r.y + r.height * fy
          if (x + ddx < 10 || x + ddx > w - 10 || y + ddy < 10 || y + ddy > h - 10) continue
          if (document.elementFromPoint(x, y) === pane) return { x, y }
        }
      }
      return null
    },
    dx,
    dy,
    WIDTH,
    HEIGHT,
  )
  if (!spot) {
    warn(`could not pan by ${Math.round(dx)},${Math.round(dy)}: no empty spot on the pane to drag from`)
    return false
  }
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x + dx, spot.y + dy, { steps: 16 })
  await page.mouse.up()
  await sleep(450)
  return true
}

/** Put a node's top-left corner at a known place in the pane, so what it opens has room below it. */
async function bringToCorner(selector, offX = 90, offY = 90) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const node = await rectOf(selector)
    const pane = await rectOf('.react-flow__pane')
    if (!node || !pane) return false
    const dx = pane.x + offX - node.x
    const dy = pane.y + offY - node.y
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return true
    if (!(await panBy(dx, dy))) return false
  }
  return true
}

/*
 * The union of a node and whatever it has opened into the space below it.
 *
 * A panel that is absolutely positioned is outside its node's own rectangle, so clipping to the
 * node captures the node and none of the panel, and hanging a fixed box off the node captures
 * whatever happens to be in the box. Measuring both and taking the union is the only version of
 * this that is right wherever the node has ended up.
 */
async function clipOpened(name, nodeSel, openedSel, pad = 22) {
  const box = await page.evaluate(
    (n, o) => {
      const node = document.querySelector(n)
      if (!node) return null
      const parts = [node.getBoundingClientRect()]
      const opened = node.querySelector(o)
      if (opened) parts.push(opened.getBoundingClientRect())
      return {
        x: Math.min(...parts.map((r) => r.x)),
        y: Math.min(...parts.map((r) => r.y)),
        right: Math.max(...parts.map((r) => r.right)),
        bottom: Math.max(...parts.map((r) => r.bottom)),
        opened: parts.length > 1,
        node: { x: parts[0].x, y: parts[0].y, right: parts[0].right, bottom: parts[0].bottom },
      }
    },
    nodeSel,
    openedSel,
  )
  if (!box) {
    warn(`no shot ${name}: ${nodeSel} was not found`)
    return
  }
  if (!box.opened) warn(`${name}: ${openedSel} is not open inside ${nodeSel}, so the shot is of the control alone`)
  const clipped = await shoot(name, {
    x: box.x - pad,
    y: box.y - pad,
    width: box.right - box.x + pad * 2,
    height: box.bottom - box.y + pad * 2,
  })
  // The thing that went wrong last time, asserted rather than assumed.
  if (clipped) {
    const inside =
      box.node.x >= clipped.x &&
      box.node.y >= clipped.y &&
      box.node.right <= clipped.x + clipped.width &&
      box.node.bottom <= clipped.y + clipped.height
    if (!inside) warn(`${name}: the control itself is not inside the frame`)
    else note(`  ${name}: the control and what it opened are both inside the frame`)
  }
  return clipped
}

/*
 * A place on the board with nothing in it, big enough for a card and for what hangs above it.
 *
 * The refusal panel floats over whatever the board has under it, and in the last capture that was a
 * wire label, which showed through the panel's corner as an unreadable fragment. The panel is not
 * changing, so the board underneath it is what moves: a card dragged to open canvas takes its pill
 * with it, and the wire label goes to the middle of the longer wire, away from the shot.
 */
async function emptySpot(w, h, keepSel) {
  return await page.evaluate(
    (wantW, wantH, keep) => {
      const pane = document.querySelector('.react-flow__pane')
      if (!pane) return null
      const p = pane.getBoundingClientRect()
      const keeps = [...document.querySelectorAll(keep)]
      const others = [...document.querySelectorAll('.react-flow__node, .wire-label')]
        .filter((el) => !keeps.some((k) => k === el || k.contains(el) || el.contains(k)))
        .map((el) => el.getBoundingClientRect())
      for (let y = p.y + 200; y + wantH + 80 < p.bottom; y += 40) {
        for (let x = p.x + 100; x + wantW + 80 < p.right; x += 40) {
          const box = { x: x - 80, y: y - 160, right: x + wantW + 80, bottom: y + wantH + 80 }
          const hit = others.some(
            (r) => !(r.right <= box.x || r.x >= box.right || r.bottom <= box.y || r.y >= box.bottom),
          )
          if (!hit) return { x, y }
        }
      }
      return null
    },
    w,
    h,
    keepSel,
  )
}

/** Drag a card the way the owner would, by its own body, and say whether it actually moved. */
async function dragNodeTo(nodeSel, target) {
  const r = await rectOf(nodeSel)
  if (!r) return false
  await page.mouse.move(r.x + 24, r.y + 8)
  await page.mouse.down()
  await page.mouse.move(target.x + 24, target.y + 8, { steps: 20 })
  await page.mouse.up()
  await sleep(700)
  const after = await rectOf(nodeSel)
  return !!after && (Math.abs(after.x - r.x) > 10 || Math.abs(after.y - r.y) > 10)
}

/** What else the frame caught, named rather than left for a reviewer to puzzle over. */
async function whatElseIsInFrame(box, keepSel) {
  return await page.evaluate(
    (frame, keep) => {
      const keeps = [...document.querySelectorAll(keep)]
      const found = []
      for (const el of document.querySelectorAll('.react-flow__node, .wire-label')) {
        if (keeps.some((k) => k === el || k.contains(el) || el.contains(k))) continue
        const r = el.getBoundingClientRect()
        if (r.right <= frame.x || r.x >= frame.x + frame.width) continue
        if (r.bottom <= frame.y || r.y >= frame.y + frame.height) continue
        const words = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        found.push(`${String(el.className).split(' ')[0]}${words ? ` "${words}"` : ''}`)
      }
      return found
    },
    box,
    keepSel,
  )
}

const tasksSection = await page.evaluate(() => {
  const s = [...document.querySelectorAll('.rail-section')].find(
    (el) => el.querySelector('.rail-title')?.textContent.trim() === 'Tasks',
  )
  if (!s) return false
  s.setAttribute('data-shot', 'tasks')
  return true
})
if (!tasksSection) warn('the Tasks section was not drawn at all')

await clip('24-taskown-panel.png', '[data-shot="tasks"]')

await click('.task-row[data-task="shots-panel-01"] .task-row__head')
await clip('25-taskown-working-open.png', '.task-row[data-task="shots-panel-01"]')

await click('.task-row[data-task="shots-panel-01"] .task-row__head')
await click('.task-row[data-task="shots-audit-02"] .task-row__head')
await clip('26-taskown-reassigned-open.png', '.task-row[data-task="shots-audit-02"]')

await clickText('.task-row[data-task="shots-audit-02"]', 'Reassign')
/*
 * Both dropdowns, not the first one twice.
 *
 * This used to set `.task-form select`, which is the new owner picker, so the reason was never
 * chosen and the line naming that reason's check was never on screen: the shot showed the form
 * asking for a reason, and the reviewer was being asked to look at what a chosen reason says. The
 * empty state is not lost by this, it is in the bind form in the next shot, which is left untouched.
 */
const picked = await page.evaluate(() => {
  const sels = [...document.querySelectorAll('.task-row[data-task="shots-audit-02"] .task-form select')]
  // A change event, because React reads the value from its own handler and not from the DOM.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  const chosen = []
  for (const sel of sels) {
    const option = [...sel.options].find((o) => o.value)
    if (!option) continue
    setter.call(sel, option.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    chosen.push(`${option.text.trim()}`)
  }
  return chosen
})
note(`  reassign form set to: ${picked.join(', ') || 'nothing'}`)
await sleep(400)
await clip('27-taskown-reassign-form.png', '.task-row[data-task="shots-audit-02"]', 24, '.task-form .btn--primary')

await click('.task-row[data-task="shots-audit-02"] .task-row__head')
await click('.task-row[data-task="legacy-mail-07"] .task-row__head')
await clickText('.task-row[data-task="legacy-mail-07"]', 'Bind')
await clip('28-taskown-unbound-bind.png', '.task-row[data-task="legacy-mail-07"]', 24, '.task-form .btn--primary')

await clip('29-taskown-ceiling.png', '.rail-limits')

/*
 * The card and its pill, both brought into the pane before anything is opened rather than after.
 * A panel that opens downwards needs the room to be there already; moving the board afterwards
 * would be moving it while the reviewer's subject is on screen.
 */
const inkNode = `.react-flow__node[data-id="${ink.id}"]`
await bringToCorner(inkNode, 140, 220)
await clip('30-taskown-card-face.png', inkNode, 40)

const pillNode = `.react-flow__node[data-id="refusals:${ink.id}"]`
const keep = `${inkNode}, ${pillNode}`
if (!(await rectOf(pillNode))) {
  warn('no refusal pill was drawn above Ink')
} else {
  /*
   * Move the card off the wire before opening the panel that floats over it. The panel is 380px of
   * absolutely positioned board furniture and it will always have something under it; what it had
   * was the "reports to" label of Ink's own wire, which is content that cannot be cropped out
   * without cropping the pill with it. Dragging the card is a thing the owner does, and it takes
   * the pill along, so the panel opens over empty canvas instead.
   */
  const card = await rectOf(inkNode)
  // Wide enough for the panel, not just for the card: the panel is 380px and opens to the card's
  // right edge and past it, so reserving the card's own width leaves a neighbour showing through.
  const spot = await emptySpot(Math.max(card.width, 520), card.height + 520, keep)
  if (!spot) warn('no empty part of the board to move Ink to, so the shot keeps whatever is behind the panel')
  else if (!(await dragNodeTo(inkNode, spot))) warn('Ink did not move when dragged, so the panel keeps its background')
  /*
   * Put the card down properly. A selected node is raised above its neighbours, and a card left
   * selected after the drag paints over the panel that is supposed to be floating above it, which
   * turned a small fragment behind the panel into the whole card on top of it. Clicking bare canvas
   * is how the owner deselects, so it is how this does it.
   */
  const bare = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')
    if (!pane) return null
    const r = pane.getBoundingClientRect()
    for (let fy = 0.2; fy <= 0.9; fy += 0.08) {
      for (let fx = 0.1; fx <= 0.9; fx += 0.08) {
        const x = r.x + r.width * fx
        const y = r.y + r.height * fy
        if (document.elementFromPoint(x, y) === pane) return { x, y }
      }
    }
    return null
  })
  if (bare) {
    await page.mouse.click(bare.x, bare.y)
    await sleep(400)
  } else warn('found nowhere bare to click, so the card may still be selected and raised')
  const landed = await rectOf(inkNode)
  note(
    `  Ink asked for ${spot ? `${Math.round(spot.x)},${Math.round(spot.y)}` : 'nowhere'}` +
      `, landed at ${Math.round(landed.x)},${Math.round(landed.y)}, was at ${Math.round(card.x)},${Math.round(card.y)}`,
  )
  await bringToCorner(pillNode, 140, 160)
  const pillThere = await click(`${pillNode} button`)
  if (!pillThere) warn('the refusal pill did not take the click')
  await sleep(400)
  // A tight pad, because the pad is where the neighbour showed: the card below the panel reached
  // into the frame by about ten pixels and read as a sliced element rather than as background.
  const pillClip = await clipOpened('31-taskown-refusal-pill.png', pillNode, '.refusal-open', 12)
  if (pillClip) {
    const behind = await whatElseIsInFrame(pillClip, keep)
    note(behind.length ? `  31: also in the frame: ${behind.join(', ')}` : '  31: nothing else is in the frame')
  }
}

/*
 * And the state the owner key exists for. Turning enforcement on is done from the keyed connection
 * this script holds; the page has no key in its localStorage, so on reload the server sees it as a
 * guest, and the shot is of what a guest is told.
 */
say({ t: 'limits.set', projectId: project.id, limits: { ...state.limits, taskAuthority: 'enforce' } })
await sleep(700)
say({ t: 'limits.get', projectId: project.id })
await sleep(400)
note(`authority now: ${state.limits?.taskAuthority}`)
await page.reload({ waitUntil: 'networkidle2' })
await sleep(2500)
await full('32-taskown-guest.png')

/*
 * A guest presses something, and the shot is of what came back.
 *
 * The banner is two lines now, mine and the server's, and the second line only exists once the
 * server has actually refused something. Photographing it before that would be photographing the
 * half of the change that is only a sentence of prose. The authority radio is the control used
 * because it is one click, it is a mutation, and the refusal it comes back with names the rule.
 */
const pressed = await page.evaluate(() => {
  const box = [...document.querySelectorAll('.rail-authority__choice input')].find((i) => !i.checked)
  if (!box) return false
  box.click()
  return true
})
if (!pressed) warn('no authority choice was available for the guest to press')
await sleep(900)
const banner = await page.evaluate(() => {
  const el = document.querySelector('.banner--guest')
  return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
})
note(`guest banner reads: ${banner ?? 'the banner was not drawn'}`)
if (banner && !/server just said/i.test(banner)) warn('the guest banner has no refusal under it, so the shot is one line')
/*
 * Clipped to the banner's own top edge rather than padded above it. The banner sits directly under
 * the project tabs, so any padding at the top puts a sliced row of the tab strip in the frame,
 * which is the same fault as before pointed at the neighbour above.
 */
const bannerBox = await rectOf('.banner--guest')
if (!bannerBox) warn('no shot 33-taskown-guest-banner.png: the guest banner was not drawn')
else await shoot('33-taskown-guest-banner.png', { ...bannerBox, height: bannerBox.height + 10 })

note(pageErrors.length ? `page errors: ${pageErrors.join('; ')}` : 'no page errors')
note(`shots written: ${shots.length}`)
note(warnings.length ? `warnings: ${warnings.length}\n  ${warnings.join('\n  ')}` : 'no warnings')

await browser.close()
ws.close()
await garden.stop()
try {
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
} catch {
  // A mailbox Windows still has open is not worth failing the run over.
}
