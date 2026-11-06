/**
 * Proves a card still shows what its session said after Garden has been restarted.
 *
 * The owner's report: outside the app he can press up and read back through a session; inside it,
 * "Garden resets puts everything back to clear state until i fully wake it up and message it".
 *
 * That was true, and it was one character. A card's miniature is drawn by a headless terminal whose
 * byte counter started at 0, and the scrollback restored from disk for a session with no live
 * process is numbered `seq: 0`, because nothing is running to have emitted anything. So the first
 * snapshot after a restart matched the "already exactly current, nothing to do" test and was
 * discarded, and the card drew blank until the session was woken and printed something new. The
 * dock terminal started its counter at -1 and restored correctly all along, which is why the card
 * and the pane below it disagreed about whether the session had ever said anything.
 *
 * The test restarts a real server against the same workspace and asks the card what it is drawing.
 * Reading the miniature rather than the socket is the point: the bytes were always on disk and
 * always served, and it was the card that threw them away.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
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

// One workspace, two server lifetimes. `startInstance` deletes its home on stop, which is exactly
// what must not happen here, so the server is run directly.
const home = mkdtempSync(join(tmpdir(), 'garden-restart-home-'))
const port = await freePort()

// Every server this test spawns and every directory it makes, so the tail is not the only path that
// tidies up. This test runs the server directly rather than through `startInstance`, so nothing
// else owns the child: if anything above the tail throws, node exits, the server does not, and it
// sits holding a multi-GB garden.db open that no later sweep can delete.
const spawned = []
const scratch = [home]
const TMP = resolve(tmpdir()).toLowerCase()
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  // Only the servers this test started. A Garden the owner is running is not ours to touch.
  for (const child of spawned) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    } catch {
      // Already gone.
    }
  }
  for (const p of scratch) {
    // Refuse anything outside the temp root by construction, so no later edit to this file can
    // reach the real board at ~/.garden.
    if (!resolve(p).toLowerCase().startsWith(TMP)) continue
    // Windows frees the SQLite handles a beat after the process dies, so one attempt loses the race.
    for (let i = 0; i < 40; i++) {
      try {
        rmSync(p, { recursive: true, force: true })
        break
      } catch {
        sleepSync(50)
      }
    }
  }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup()
    process.exit(1)
  })
}
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, (e) => {
    console.error(e)
    cleanup()
    process.exit(1)
  })
}

async function boot() {
  const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, GARDEN_PORT: String(port), GARDEN_HOME: home, GARDEN_DB: join(home, 'garden.db'), CLAUDE_CODE_CHILD_SESSION: undefined },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  spawned.push(child)
  child.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child
    } catch {
      // Not up yet.
    }
    await sleep(150)
  }
  child.kill()
  throw new Error('the test server never answered. Has "npm run build" been run?')
}

const marker = `GARDEN_REMEMBERS_${Date.now().toString().slice(-6)}`
const title = `Restart ${Date.now().toString().slice(-6)}`
const dir = mkdtempSync(join(tmpdir(), 'garden-restart-proj-'))
scratch.push(dir)
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

// --- first lifetime: make a card, make it say something ----------------------------------------

let server = await boot()
const state = { projects: [], sessions: [] }
let ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('the scratch project was added', !!project)

ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: true }))
await sleep(3000)
const card = state.sessions.find((s) => s.title === title)
check('the card was created and started', !!card)

ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: `echo ${marker}\r` }))
// Long enough for the output to arrive AND for the three-second flush timer to put it on disk.
await sleep(5000)

// --- the restart -------------------------------------------------------------------------------

ws.close()
server.kill()
await sleep(1500)
server = await boot()

// Nothing is woken here. The session is dead, its process cannot be re-parented, and the card is
// being asked to draw what it printed before any of that happened.
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 2200, height: 1200 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const shown = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  return node?.innerText ?? '(card not found)'
}, title)

check('the card is on the board after the restart', !shown.startsWith('(card not found)'), shown.slice(0, 60))
check('and it still shows what the session printed', shown.includes(marker), shown.replace(/\s+/g, ' ').slice(0, 220))

await browser.close()
cleanup()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
