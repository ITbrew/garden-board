/**
 * Shots of the simplified sidebar, and of the owner key arriving by URL, on a scratch board.
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md, both asserted
 * before anything touches the socket. Nothing here reaches the owner's board.
 *
 * What it is for. Five surfaces left the sidebar at the owner's request, and the owner key now
 * arrives in the fragment of the URL the launcher opens instead of being pasted into a field. A
 * screenshot can show that a section is gone; it cannot show that the rail is not quietly broken at
 * a narrow width, that no section is left standing empty, or that a page opened with a key ends up
 * as the owner with a clean address bar. So the run asserts those and prints what it found, and the
 * shots are for a reader who has not seen the code.
 *
 *   npm run build
 *   node scripts/capture-simplify-ui.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const require = createRequire('C:/Garden/package.json')
const WebSocket = require('ws')
const puppeteer = require('puppeteer-core').default ?? require('puppeteer-core')

const OUT = 'C:\\Garden\\docs\\shots'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDE = 1440
const NARROW = 900
const TALL = 950
const LIVE_PORT = 5178

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const note = (s) => console.log(s)
const warnings = []
const warn = (s) => {
  warnings.push(s)
  console.log(`  WARNING: ${s}`)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-simplify-shots-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch board for the sidebar simplification shots\n')
mkdirSync(join(dir, 'docs'), { recursive: true })
writeFileSync(join(dir, 'docs', 'work-order.md'), '# Work order\n\nTake five surfaces out of the sidebar.\n')
// A handful of files, so that a board which still had the "Show N files" button would have
// something to count. The button is gone; this is what proves the scan is not what was removed.
for (const name of ['one.ts', 'two.ts', 'three.json', 'four.md', 'five.py']) {
  writeFileSync(join(dir, name), `// ${name}\n`)
}

const home = mkdtempSync(join(tmpdir(), 'garden-simplify-home-'))
const state = { projects: [], sessions: [], wires: [], tasks: [], limits: null }
let ws = null

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
      })
    } else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'session.added') state.sessions.push(m.session)
    else if (m.t === 'wire.added') state.wires.push(m.wire)
    else if (m.t === 'limits') state.limits = m.limits
    else if (m.t === 'task.state') state.tasks = m.tasks
    else if (m.t === 'error') note(`  server refused ${m.forT}: ${m.message}`)
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
// The board
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
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) throw new Error('the scratch project was not added')
say({ t: 'limits.get', projectId: project.id })
await sleep(300)

for (const [title, roleClass] of [
  ['Orchestrator', 'orchestrator'],
  ['Ink', 'worker'],
  ['Plumb', 'verifier'],
]) {
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
const plumb = cardNamed('Plumb')
if (!boss || !ink || !plumb) throw new Error('the scratch cards were not created')

for (const card of [ink, plumb]) {
  const already = state.wires.some(
    (w) => (w.sourceId === boss.id && w.targetId === card.id) || (w.targetId === boss.id && w.sourceId === card.id),
  )
  if (already) continue
  say({ t: 'wire.create', projectId: project.id, sourceId: boss.id, targetId: card.id, bidirectional: true })
  await sleep(350)
}

/*
 * A task a card is actually holding, and a refusal against that card, because those two are what
 * the owner is left with in place of the panel: the id and state on the card's face, and the pill
 * above it. Both are made the way a real one is, through `task.create`, real work mail and a real
 * `/claim` outside the territory.
 */
say({
  t: 'task.create',
  projectId: project.id,
  task: {
    id: 'simplify-ui-01',
    ownerId: ink.id,
    assignerId: boss.id,
    verifierId: plumb.id,
    territory: ['apps/web/src'],
    acceptanceRef: { path: 'docs/work-order.md' },
  },
})
await sleep(500)
note(
  await post(garden.port, '/mail', {
    from: boss.id,
    to: 'Ink',
    kind: 'work',
    taskId: 'simplify-ui-01',
    text: 'Take the five surfaces out of the rail.',
  }).then((r) => `work mail: ${r.status}`),
)
await sleep(500)
const claim = await post(garden.port, '/claim', { gardenSessionId: ink.id, path: 'server/src/index.ts' })
note(`claim outside territory: ${claim.status}`)
await sleep(400)
say({ t: 'task.list', projectId: project.id })
await sleep(500)
note(`tasks: ${state.tasks.map((t) => `${t.id}=${t.state}`).join(', ') || 'none'}`)

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
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }, selector)
}

async function clip(name, selector, pad = 8) {
  const box = await rectOf(selector)
  if (!box || box.width < 2) {
    warn(`no shot ${name}: ${selector} was not found`)
    return
  }
  return await shoot(name, {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  })
}

/** Open the board as the owner, with the key in the fragment the launcher would have used. */
async function openAsOwner() {
  await page.goto(`http://127.0.0.1:${garden.port}/#key=${key}`, { waitUntil: 'networkidle2' })
  await sleep(2500)
  return await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    identity: document.querySelector('.app')?.getAttribute('data-identity') ?? 'no app element',
  }))
}

const owner = await openAsOwner()
note(`owner page: identity=${owner.identity}, location.href=${owner.href}, fragment=${owner.hash || '(none)'}`)
if (owner.identity !== 'owner') warn(`the page opened with the key is "${owner.identity}", not the owner`)
if (owner.hash) warn(`the fragment is still in the address bar: ${owner.hash}`)
if (owner.href.includes('key=')) warn('the key is still in location.href')

/*
 * What the rail must not contain any more, checked rather than looked at.
 *
 * Matched on the text of a heading or a button, which is what the owner reads, and not on a class
 * name: a section renamed but still there would pass a class check and fail this one.
 */
const GONE = [
  { what: 'Owner key', test: (t) => t === 'Owner key' },
  { what: 'Task ownership', test: (t) => t === 'Task ownership' },
  { what: 'Tasks', test: (t) => t === 'Tasks' },
  { what: 'Arrange the board', test: (t) => t === 'Arrange the board' },
  { what: 'Show N files', test: (t) => /^Show \d+ files$/.test(t) },
]

async function checkRail(width) {
  const found = await page.evaluate(() => {
    const rail = document.querySelector('.rail')
    if (!rail) return null
    const texts = [...rail.querySelectorAll('h3, button, label, span, p')].map((el) => el.textContent.trim())
    const empties = [...rail.querySelectorAll('.rail-section')]
      .filter((s) => s.textContent.trim().length === 0 || s.children.length <= 1)
      .map((s) => s.querySelector('.rail-title')?.textContent.trim() ?? '(no heading)')
    const sections = [...rail.querySelectorAll('.rail-title')].map((el) => el.textContent.trim())
    return {
      texts,
      empties,
      sections,
      scrollHeight: rail.scrollHeight,
      clientHeight: rail.clientHeight,
      window: window.innerHeight,
    }
  })
  if (!found) {
    warn(`at ${width}px the rail was not drawn at all`)
    return
  }
  note(`  at ${width}px the rail holds: ${found.sections.join(', ')}`)
  for (const gone of GONE) {
    const hit = found.texts.find((t) => gone.test(t))
    if (hit) warn(`at ${width}px the rail still has "${hit}", which was meant to be removed`)
  }
  if (found.empties.length) warn(`at ${width}px these sections are empty: ${found.empties.join(', ')}`)
  note(`  at ${width}px the rail is ${found.scrollHeight}px of content in ${found.clientHeight}px, window ${found.window}px`)
  if (found.scrollHeight > found.clientHeight + 4) {
    note(`  at ${width}px the rail scrolls by ${found.scrollHeight - found.clientHeight}px, which is content and not blank space`)
  }
}

await clip('34-simplify-rail-1440.png', '.rail', 0)
await checkRail(WIDE)
await clip('35-simplify-ceiling.png', '.rail-limits', 12)

/*
 * The canvas context menu, which is the other place "Arrange" was offered.
 *
 * It is checked rather than photographed because a menu is only on screen while it is open, and a
 * shot of a menu without the item proves only that the shot was taken after the item was removed.
 * The assertion reads every label the menu draws and fails on any that begins with "Arrange", so a
 * later hand putting it back trips this rather than a reader having to notice its absence.
 */
async function checkCanvasMenu() {
  const pane = await rectOf('.react-flow__pane')
  if (!pane) {
    warn('the canvas pane was not drawn, so the context menu could not be checked')
    return
  }
  await page.mouse.click(pane.x + pane.width - 120, pane.y + 80, { button: 'right' })
  await sleep(500)
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.ctxmenu__label')].map((el) => el.textContent.trim()),
  )
  if (!labels.length) {
    warn('the canvas context menu did not open, so nothing was checked in it')
    return
  }
  note(`  the canvas menu holds: ${labels.join(', ')}`)
  const arrange = labels.filter((t) => t.toLowerCase().startsWith('arrange'))
  if (arrange.length) warn(`the canvas menu still offers ${arrange.join(', ')}`)
  else note('  the canvas menu has no item beginning with "Arrange"')
  await page.keyboard.press('Escape')
  await sleep(300)
  const stillOpen = await page.evaluate(() => !!document.querySelector('.ctxmenu'))
  if (stillOpen) {
    await page.mouse.click(pane.x + 40, pane.y + pane.height - 40)
    await sleep(300)
  }
  const closed = await page.evaluate(() => !!document.querySelector('.ctxmenu'))
  if (closed) warn('the context menu would not close, so the shots after this one may carry it')
}
await checkCanvasMenu()

/*
 * Drag the canvas by hand, because nothing on it scrolls.
 *
 * The board is one transformed layer inside a pane of fixed size, so a card whose pill sits above
 * the top of the pane is not off the top of a scroll area, it is not drawn at all. Panning through
 * the pointer means the app's own handler moves its own state, so nothing here is holding a
 * transform React will undo on the next render.
 */
async function panBy(dx, dy) {
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return true
  const view = page.viewport()
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
    view.width,
    view.height,
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

/** Put a node's top-left corner at a known place in the pane, so what sits above it is in frame. */
async function bringToCorner(selector, offX = 120, offY = 160) {
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
 * The card face and its pills, which is where a task is visible now that no panel lists them.
 * The pill is opened, because what it opens is what replaced the panel: the refusals against this
 * card, in sentences, rather than every task on the board in a list.
 */
const inkNode = `.react-flow__node[data-id="${ink.id}"]`
const pillNode = `.react-flow__node[data-id="refusals:${ink.id}"]`
await bringToCorner(inkNode, 140, 220)

/*
 * Two shots, because the pill open covers the face it belongs to.
 *
 * Closed first, which is the state the owner meets: the card, the task it is holding on its face,
 * and the pill above it saying something was refused. Then open, because what it opens is the other
 * half of the answer to "where did the tasks go": the refusals against this card, in sentences.
 */
async function cardShot(name) {
  const box = await page.evaluate(
    (cardSel, pillSel) => {
      const card = document.querySelector(cardSel)
      const pill = document.querySelector(pillSel)
      if (!card) return null
      const parts = [card.getBoundingClientRect()]
      if (pill) {
        parts.push(pill.getBoundingClientRect())
        const panel = pill.querySelector('.refusal-open')
        if (panel) parts.push(panel.getBoundingClientRect())
      }
      return {
        x: Math.min(...parts.map((r) => r.x)),
        y: Math.min(...parts.map((r) => r.y)),
        right: Math.max(...parts.map((r) => r.right)),
        bottom: Math.max(...parts.map((r) => r.bottom)),
        pill: parts.length > 1,
        pillBox: parts[1] ? { x: parts[1].x, y: parts[1].y, right: parts[1].right, bottom: parts[1].bottom } : null,
      }
    },
    inkNode,
    pillNode,
  )
  if (!box) {
    warn(`no shot ${name}: Ink was not drawn on the board`)
    return
  }
  if (!box.pill) warn(`${name}: no refusal pill was drawn above Ink`)
  const clipped = await shoot(name, {
    x: box.x - 16,
    y: box.y - 16,
    width: box.right - box.x + 32,
    height: box.bottom - box.y + 32,
  })
  // Asserted rather than looked at: the pill above the card is half of what this shot exists for,
  // and a board that has not been panned puts it above the top of the frame.
  if (clipped && box.pillBox) {
    const p = box.pillBox
    const inside =
      p.x >= clipped.x &&
      p.y >= clipped.y &&
      p.right <= clipped.x + clipped.width &&
      p.bottom <= clipped.y + clipped.height
    if (inside) note(`  ${name}: the card and the pill above it are both in the frame`)
    else warn(`${name}: the refusal pill is outside the frame`)
  }
}

await cardShot('36-simplify-card-face.png')

const opened = await page.evaluate((sel) => {
  const btn = document.querySelector(`${sel} button`)
  if (!btn) return false
  btn.click()
  return true
}, pillNode)
if (!opened) warn('the refusal pill did not take the click')
await sleep(600)
await cardShot('40-simplify-refusals-open.png')

// The narrow width, which is where a rail that no longer fits shows it.
await page.setViewport({ width: NARROW, height: TALL })
await sleep(1200)
await clip('37-simplify-rail-900.png', '.rail', 0)
await checkRail(NARROW)
await page.setViewport({ width: WIDE, height: TALL })
await sleep(800)

// ---------------------------------------------------------------------------
// The guest tab
// ---------------------------------------------------------------------------

/*
 * A guest exists only once a project is enforcing: below that, canon says an anonymous connection
 * is given the owner's identity, because that is what every tab did before any of this. So the
 * setting is turned on from this script's keyed socket, which is the only connection allowed to,
 * and then a tab with no key is opened.
 *
 * The setting is made here over the socket because the panel that used to make it has gone. On a
 * real board it is `garden-task.mjs authority enforce`, which is the Worker's half.
 */
say({ t: 'limits.set', projectId: project.id, limits: { ...state.limits, taskAuthority: 'enforce' } })
await sleep(700)
say({ t: 'limits.get', projectId: project.id })
await sleep(400)
note(`authority now: ${state.limits?.taskAuthority}`)

/*
 * The key is in this browser's localStorage from the page above, so it is cleared before the tab
 * that is meant to be a guest says hello. Cleared and then reloaded, because identity is decided in
 * the handshake and a socket that is already open has already been answered.
 */
await page.evaluate(() => {
  try {
    localStorage.clear()
  } catch {
    // Storage blocked, which is the guest case anyway.
  }
})
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(2500)
const guest = await page.evaluate(() => ({
  href: location.href,
  identity: document.querySelector('.app')?.getAttribute('data-identity') ?? 'no app element',
  banner: document.querySelector('.banner--guest')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
  /*
   * The board's own line, without the server's sentence under it. They are checked separately on
   * purpose: this line is mine and must not send the owner to a panel that no longer exists, while
   * the sentence below it is the server's and may say whatever is true, including where the key is.
   */
  mine: document.querySelector('.banner--guest > div')?.textContent.trim() ?? null,
}))
note(`guest page: identity=${guest.identity}, location.href=${guest.href}`)
note(`guest banner reads: ${guest.banner ?? 'the banner was not drawn'}`)
if (guest.identity !== 'guest') warn(`the page opened without a key is "${guest.identity}", not a guest`)
if (guest.mine && /owner key|Ceiling panel|paste/i.test(guest.mine)) {
  warn(`the board's own guest line still sends the owner to a removed control: "${guest.mine}"`)
}
/*
 * A guest presses something, so the shot shows what a guest actually meets.
 *
 * The banner's second line only exists once the server has refused something, and a shot taken
 * before that would show half of what is there. Pressing a launcher is the most ordinary thing a
 * reader would try, and the refusal that comes back is the server's own sentence, which is the
 * whole point of not disabling the control.
 */
const pressed = await page.evaluate(() => {
  const btn = document.querySelector('[data-cap="launch-shell"]')
  if (!btn) return false
  btn.click()
  return true
})
if (!pressed) warn('the guest had no launcher to press')
await sleep(1200)
const answered = await page.evaluate(
  () => document.querySelector('.banner__under')?.textContent.trim() ?? null,
)
note(`the server's answer to the guest: ${answered ?? 'nothing came back'}`)
if (!answered) warn('a guest pressed a launcher and the server neither refused it nor said anything')
const bannerBox = await rectOf('.banner--guest')
if (!bannerBox) warn('no shot 38-simplify-guest-banner.png: the guest banner was not drawn')
else await shoot('38-simplify-guest-banner.png', { ...bannerBox, height: bannerBox.height + 10 })
await clip('39-simplify-guest-rail.png', '.rail', 0)

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
