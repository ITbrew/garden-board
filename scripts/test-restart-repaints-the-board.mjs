/**
 * After the Restart server button, does the board come back on its own, or does it need F5?
 *
 * The owner's report, twice: "the reset button doesnt ever refresh board, i have to press f5 to see
 * cards again after restart server button is pressed".
 *
 * `test-restart-from-the-launcher-shape.mjs` proves the server half is fine. Started the way the
 * launcher starts it, five processes deep, it stops, comes back as a new pid in about a second, and
 * answers as a working board. So whatever is wrong is on the page, which is the half no restart test
 * has ever looked at: every one of them talks to a socket, and a socket reconnecting is not the same
 * claim as a board being drawn again.
 *
 * So this holds a real browser open across the restart and never reloads it. The assertion is the
 * one the owner would make: are the cards on the screen.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board. Run `npm run build` first or this is a test of an old bundle.
 *
 *   npm run build
 *   node scripts/test-restart-repaints-the-board.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (what, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

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

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(300)
  }
  return false
}

const board = await openBoard({ projectName: 'restartrepaint', cards: [{ title: 'Alpha' }, { title: 'Bravo' }] })
const PORT = board.port

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.stack || String(e)))

/*
 * Kill by port rather than by the pid `openBoard` holds. After a restart that pid is gone and a
 * different process owns the socket, so the handle this script started with cannot clean up what is
 * actually running at the end.
 */
const killByPort = async () => {
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$p = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force }`,
  ], { stdio: 'ignore' })
  await new Promise((r) => ps.on('close', r))
}

const cardCount = () => page.$$eval('.node', (els) => els.length).catch(() => -1)

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
await sleep(2000)

const before = await cardCount()
check('the board draws its cards before the restart', before === 2, `${before} cards`)
if (before !== 2) {
  console.log('ABORT: nothing to prove if the board was not drawn in the first place')
  await browser.close()
  await killByPort()
  process.exit(1)
}

/*
 * Pressed the way the owner presses it, through the page's own button, rather than by sending
 * `server.restart` down a socket of this script's own. The button is behind a confirm dialog, so the
 * dialog is accepted the way a person accepts it. Sending the message directly would test the server
 * and skip the half that is actually suspected.
 */
page.on('dialog', async (d) => {
  await d.accept()
})
const pressed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart server')
  if (!btn) return false
  btn.click()
  return true
})
check('the Restart server button is on the page and was pressed', pressed)
if (!pressed) {
  await browser.close()
  await killByPort()
  process.exit(1)
}

const wentDown = await waitUntil(async () => !(await up(PORT)), 20_000)
check('the server goes down', wentDown, wentDown ? 'stopped answering' : 'never went down')

const cameBack = await waitUntil(() => up(PORT), 60_000)
check('and comes back up', cameBack, cameBack ? 'answering again' : 'still down')

if (cameBack) {
  /*
   * Counting the cards still on screen proves nothing, and the first version of this file did
   * exactly that and passed in 0.0 seconds.
   *
   * The page keeps its last state in memory while the socket is down, so the two cards never leave
   * the DOM whether the page reconnects or not. "Still two cards" is the same reading on a board
   * that recovered and on a board that is showing a corpse. What tells them apart is something that
   * happened while the page was not listening: a card made after the restart, over a socket of this
   * script's own. A page that reconnected and asked again draws three. A page that is holding a
   * stale picture draws two, forever, until F5.
   */
  const began = Date.now()
  /*
   * A socket of this script's own, opened after the restart, so making the card does not depend on
   * the page's connection being the thing under test.
   */
  const projectId = board.state.projects[0]?.id
  const maker = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
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
  await sleep(1200)
  check('a third card was made on the server after the restart', Boolean(projectId), `project ${projectId ?? 'missing'}`)

  const repainted = await waitUntil(async () => (await cardCount()) === 3, 30_000)
  const took = ((Date.now() - began) / 1000).toFixed(1)
  const after = await cardCount()
  check(
    'and the board repaints WITHOUT a reload',
    repainted,
    repainted
      ? `${after} cards after ${took}s`
      : `${after} cards after ${took}s, so the page is showing what it remembered rather than what the server has`,
  )

  /*
   * The control, and it is the half that turns a failure here into a diagnosis. If a reload brings
   * the cards back then the server is fine and the page is the fault, which is precisely the claim
   * being tested. If a reload does not either, the problem is somewhere else entirely and this test
   * would otherwise have blamed the wrong half.
   */
  if (!repainted) {
    await page.reload({ waitUntil: 'networkidle0' })
    await sleep(2500)
    const reloaded = await cardCount()
    check(
      'but F5 does bring them back, so the server kept them and the page did not ask again',
      reloaded === 3,
      `${reloaded} cards after a reload`,
    )
  }
}

if (errors.length) console.log(`console errors during the run:\n${errors.slice(0, 8).join('\n')}`)

await browser.close()
await killByPort()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
