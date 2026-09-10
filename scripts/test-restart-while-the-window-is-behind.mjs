/**
 * The restart he actually performs, from a window that is not the one in front.
 *
 * Every restart test so far, mine included, holds the board window focused for the whole thing and
 * they all pass: the page reconnects in under two seconds and repaints without F5. His does not, and
 * the launcher says why that gap is worth chasing. `scripts/launch.ps1` opens the board as a Chrome
 * `--app` window, which is a window among his other windows rather than a tab he is looking at, and
 * he presses Restart and then goes back to whatever he was doing. From that moment the page is
 * `document.hidden`, and Chrome treats a hidden page differently in the one way that matters here:
 * `setTimeout` is clamped, and after five minutes hidden with no open connection the page can be
 * frozen outright and run no JavaScript at all.
 *
 * The reconnect ladder in `connection.ts` is nothing but `setTimeout`. Nothing in the app retries on
 * `visibilitychange`: that handler exists, and all it does is reset the watchdog's clock. So the
 * question this file asks is the owner's question. If the page is behind another window when the
 * server goes away, does it ever come back, and does returning to the window bring it back.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board.
 *
 *   npm run build
 *   node scripts/test-restart-while-the-window-is-behind.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
/** How long the page is left hidden after the server is answering again, before it is judged. */
const PATIENCE_MS = 45_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (what, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures += 1
}
const note = (what) => console.log(`      ${what}`)

const up = (port) =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(700)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(false)
    })
    probe.on('error', () => done(false))
  })

const waitUntil = async (fn, ms, step = 250) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

const board = await openBoard({ projectName: 'restartbehind', cards: [{ title: 'Alpha' }, { title: 'Bravo' }] })
const PORT = board.port

const killByPort = async () => {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force }`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise((r) => ps.on('close', r))
}

let browser = null
const bail = async (why) => {
  console.log(`ABORT: ${why}`)
  try {
    await browser?.close()
  } catch {
    // Never launched, or already gone.
  }
  await killByPort()
  process.exit(1)
}

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('dialog', async (d) => {
  await d.accept()
})

const cardCount = () => page.$$eval('.node', (els) => els.length).catch(() => -1)
const offline = () => page.$$eval('.banner--offline', (els) => els.length > 0).catch(() => false)
const visibility = () => page.evaluate(() => document.visibilityState).catch(() => 'unknown')

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
await sleep(2500)

const before = await cardCount()
check('the board draws its cards before the restart', before === 2, `${before} cards`)
if (before !== 2) await bail('nothing to prove if the board was not drawn in the first place')

const pressed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart server')
  if (!btn) return false
  btn.click()
  return true
})
check('the Restart server button was pressed', pressed)
if (!pressed) await bail('no button to press')

/*
 * Behind. A second tab brought to the front is what a headless Chrome has instead of another window,
 * and it produces the same `visibilitychange` and the same `document.hidden` the owner's board sees
 * the moment he goes back to his terminal.
 *
 * Immediately after the press rather than before it, because that is the order he does it in: he
 * presses the button in the board window and then looks away.
 */
const other = await browser.newPage()
await other.goto('about:blank')
await other.bringToFront()
await sleep(500)
check('the board window is now behind another one', (await visibility()) === 'hidden', `visibilityState ${await visibility()}`)

const t0 = Date.now()
const since = () => ((Date.now() - t0) / 1000).toFixed(1)

const wentDown = await waitUntil(async () => !(await up(PORT)), 30_000)
check('the server goes down', wentDown, wentDown ? `after ${since()}s` : 'never went down')
const cameBack = await waitUntil(() => up(PORT), 90_000)
check('and comes back up', cameBack, cameBack ? `after ${since()}s` : 'still down')
if (!cameBack) await bail('the server half failed, which is a different fault from the one under test')

/*
 * The probe card, made on a socket of this script's own. Counting the two already drawn proves
 * nothing: they stay in the DOM whether the page reconnected or not, which is the trap the first
 * version of `test-restart-repaints-the-board.mjs` fell into.
 */
const projectId = board.state.projects[0]?.id
const maker = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const refusals = []
maker.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'error' && !String(m.message).startsWith('__')) refusals.push(m.message)
})
await new Promise((r, x) => {
  maker.on('open', r)
  maker.on('error', x)
})
maker.send(JSON.stringify({ t: 'hello' }))
await sleep(600)
maker.send(
  JSON.stringify({
    t: 'session.create',
    projectId,
    adapterId: 'shell',
    title: 'Charlie',
    roleClass: null,
    reportsTo: null,
    start: false,
  }),
)
await sleep(1500)
if (refusals.length) note(`the server refused something on the probe socket: ${refusals.join(' | ')}`)

const backWhileHidden = await waitUntil(async () => (await cardCount()) === 3, PATIENCE_MS)
check(
  'the board repaints while its window is behind another one',
  backWhileHidden,
  backWhileHidden
    ? `three cards ${since()}s after the press`
    : `${await cardCount()} cards after ${since()}s, banner ${(await offline()) ? 'still up' : 'gone'}`,
)

/*
 * And the half that decides what to build if the first half failed. Coming back to the window is the
 * next thing the owner does, and if that alone brings the board back then the fault is only that it
 * waited; if it does not, the page is stuck until F5 and returning to it is not a recovery path at
 * all.
 */
if (!backWhileHidden) {
  const cameForward = Date.now()
  await page.bringToFront()
  const backOnReturn = await waitUntil(async () => (await cardCount()) === 3, 30_000)
  check(
    'or at least repaints when he comes back to the window',
    backOnReturn,
    backOnReturn
      ? `three cards ${((Date.now() - cameForward) / 1000).toFixed(1)}s after returning to it`
      : `${await cardCount()} cards, 30s after returning to it`,
  )

  if (!backOnReturn) {
    await page.reload({ waitUntil: 'networkidle0' })
    await sleep(2500)
    const reloaded = await cardCount()
    check(
      'but F5 does bring them back, so the server kept them and the page never asked again',
      reloaded === 3,
      `${reloaded} cards after a reload`,
    )
  }
}

await browser.close()
await killByPort()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
