/**
 * Two checks that matter for trusting the board:
 *
 * 1. Ctrl+Z reverses a board edit (a drawn wire), in the real browser.
 * 2. The workspace autosaves: cards, positions and wires survive a full server restart, because
 *    a board you rebuild by hand every morning is not a workspace.
 *
 * The second check used to be a manual dance: run the file, restart the server by hand, run it
 * again with --verify, and trust that nothing in between had changed. That only ever proved the
 * database file had *some* rows in it, never that they were the SAME rows the first half drew.
 * This spawns its own server twice against the SAME home directory, so the restart is real and
 * the comparison is exact rather than "greater than zero".
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import Database from 'better-sqlite3'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Launch the built server against a specific home directory, so a second launch can point at the
 * SAME workspace the first one wrote to. `lib/instance.mjs` always mints a fresh home, which is
 * right for every other test here and wrong for exactly this one: proving a restart keeps the
 * workspace means restarting against the same files, not a new temp directory.
 */
async function launchAgainst(home, port) {
  const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GARDEN_PORT: String(port),
      GARDEN_HOME: home,
      GARDEN_DB: join(home, 'garden.db'),
      CLAUDE_CODE_CHILD_SESSION: undefined,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let died = null
  child.on('exit', (code) => (died = code))
  child.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (died !== null) throw new Error(`the test server exited with code ${died} before answering`)
    if (await healthy(port)) return child
    await sleep(150)
  }
  child.kill()
  throw new Error(`the test server never answered on ${port}`)
}

function snapshot(dbFile) {
  const d = new Database(dbFile, { readonly: true })
  try {
    return {
      wires: d.prepare('SELECT id,sourceId,targetId FROM wires ORDER BY id').all(),
      sessions: d.prepare('SELECT id,title,x,y,collapsed FROM sessions ORDER BY id').all(),
      docs: d.prepare('SELECT id,relPath FROM docs ORDER BY id').all(),
    }
  } finally {
    d.close()
  }
}

const port = await freePort()
const home = mkdtempSync(join(tmpdir(), 'garden-undo-persist-home-'))
const DB = join(home, 'garden.db')
const UI = `http://127.0.0.1:${port}`

let child = await launchAgainst(home, port)

// A scratch project with a few cards, so there is something to wire and something to lose if the
// restart does not actually keep the workspace.
const projectDir = mkdtempSync(join(tmpdir(), 'garden-undo-persist-project-'))
writeFileSync(join(projectDir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

ws.send(JSON.stringify({ t: 'project.add', path: projectDir.replace(/\\/g, '/') }))
await sleep(1300)
const project = st.projects.find((p) => p.path.toLowerCase() === projectDir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  ws.close()
  child.kill()
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

for (const t of ['Alpha', 'Beta', 'Gamma']) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: t, start: false }))
  await sleep(700)
}
ws.close()

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 3840, height: 1600, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const before = snapshot(DB)
const edgesBefore = await page.$$eval('.react-flow__edge', (e) => e.length)

// Draw a wire between two cards, the way a person would.
const handles = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.react-flow__node')]
  const pick = (n, sel) => {
    const h = n.querySelector(sel)
    if (!h) return null
    const r = h.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  if (nodes.length < 3) return null
  return { from: pick(nodes[1], '.react-flow__handle.source'), to: pick(nodes[2], '.react-flow__handle.target') }
})

if (handles?.from && handles?.to) {
  await page.mouse.move(handles.from.x, handles.from.y)
  await page.mouse.down()
  await page.mouse.move(handles.to.x, handles.to.y, { steps: 20 })
  await page.mouse.up()
  await sleep(1000)

  const edgesAfter = await page.$$eval('.react-flow__edge', (e) => e.length)
  check('drawing added a wire', edgesAfter === edgesBefore + 1, `${edgesBefore} -> ${edgesAfter}`)
  check('the wire reached the database', snapshot(DB).wires.length === before.wires.length + 1)

  // Undo it.
  await page.evaluate(() => document.body.click())
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await sleep(1000)

  const edgesUndone = await page.$$eval('.react-flow__edge', (e) => e.length)
  check('Ctrl+Z removed the wire', edgesUndone === edgesBefore, `${edgesAfter} -> ${edgesUndone}`)
  check('undo reached the database', snapshot(DB).wires.length === before.wires.length)

  // Redo it.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyY')
  await page.keyboard.up('Control')
  await sleep(1000)
  check('Ctrl+Y restored it', (await page.$$eval('.react-flow__edge', (e) => e.length)) === edgesBefore + 1)
} else {
  check('found two cards to wire together', false)
}

await browser.close()

const beforeRestart = snapshot(DB)
console.log(`\nboard before restart: ${beforeRestart.sessions.length} sessions, ${beforeRestart.docs.length} documents, ${beforeRestart.wires.length} wires`)

// The actual restart: end the process without touching its files, then start a fresh one
// against the same home. Nothing here is a new workspace; it is the same one, reopened.
child.kill()
await sleep(1000)
child = await launchAgainst(home, port)

const afterRestart = snapshot(DB)
check('every session came back', afterRestart.sessions.length === beforeRestart.sessions.length,
  `${beforeRestart.sessions.length} -> ${afterRestart.sessions.length}`)
check('every wire came back', afterRestart.wires.length === beforeRestart.wires.length,
  `${beforeRestart.wires.length} -> ${afterRestart.wires.length}`)
check('positions came back unchanged', JSON.stringify(afterRestart.sessions) === JSON.stringify(beforeRestart.sessions))

// And the running server, not just the file on disk, actually serves that state back.
const st2 = { sessions: [], wires: [] }
const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
ws2.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st2, { sessions: m.sessions, wires: m.wires })
})
await new Promise((r) => ws2.on('open', r))
ws2.send(JSON.stringify({ t: 'hello' }))
await sleep(900)
check('the restarted server reports the same sessions over the socket',
  st2.sessions.filter((s) => s.projectId === project.id).length === beforeRestart.sessions.length)
check('the restarted server reports the same wires over the socket',
  st2.wires.filter((w) => w.projectId === project.id).length === beforeRestart.wires.length)
ws2.close()

child.kill()
await sleep(400)
rmSync(home, { recursive: true, force: true })
rmSync(projectDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
