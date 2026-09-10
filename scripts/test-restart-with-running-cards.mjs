/**
 * The restart the owner actually performs: a board with cards that are RUNNING.
 *
 * Two tests already cover the halves either side of this one and both pass.
 * `test-restart-from-the-launcher-shape.mjs` proves the server stops and comes back as a new pid in
 * about a second in the launcher's five-process shape. `test-restart-repaints-the-board.mjs` proves
 * a browser held open across the restart reconnects and repaints without F5.
 *
 * Both of those boards hold STOPPED cards. His hold running ones with real PTYs behind them, and
 * that is the difference nobody has measured. His two complaints, in his words:
 *
 *   "the reset button doesnt ever refresh board, i have to press f5 to see cards again after
 *    restart server button is pressed"
 *   "also resetting the server messes up the cards conversation views, i have to open terminal for
 *    the card to be able to read"
 *
 * So this starts three real shell PTYs, makes each print a marker only that card can have printed,
 * marks them busy the way a CLI hook does so `revive` counts them as worth bringing back, opens one
 * in the dock, and then presses the button on the page the way he presses it. Nothing is reloaded.
 *
 * The assertions are the ones he would make, and none of them is "are there still rectangles on
 * screen": the page keeps its last state in memory while the socket is down, so a count of cards
 * reads the same on a board that recovered and on a board showing a corpse. What is asserted is
 * content that could only be there if the page asked the new server for it, plus a card created
 * after the restart over a socket of this script's own.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board.
 *
 *   npm run build
 *   node scripts/test-restart-with-running-cards.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NAMES = ['Alpha', 'Bravo', 'Charlie']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (what, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures += 1
}
/** A measurement is not a pass or a fail, and printing it as one would be a lie either way. */
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

const board = await openBoard({ projectName: 'restartrunning', cards: NAMES.map((title) => ({ title })) })
const PORT = board.port

/*
 * Kill by port rather than by the pid `openBoard` holds. After a restart that pid is gone and a
 * different process owns the socket, so the handle this script started with cannot clean up what is
 * actually running at the end.
 */
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

let browser = null

// --- a board with real processes on it -------------------------------------

/*
 * `openBoard`'s own state never merges `session.updated`, so the rows it holds still carry the
 * `pid: null` they were created with. A start is only visible in that message, hence a listener of
 * this test's own rather than a fix to shared library code another test depends on.
 */
const pids = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated') pids.set(m.session.id, m.session.pid)
})

for (const c of board.cards) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(3500)
const livePids = board.cards.filter((c) => pids.get(c.id)).length
check('three cards have real processes behind them', livePids === 3, `${livePids} with a pid`)
if (livePids !== 3) await bail('the point of this test is running cards')

/*
 * Busy, the way a CLI says so.
 *
 * `revive` only brings back cards whose last status was working, starting or needs-input: an idle
 * card is deliberately left down because starting it buys nothing. A shell card is stamped idle the
 * moment it spawns, so without this the restart would skip every card and the test would be
 * measuring a board that is not his. This posts the same `/hook` body the CLI's own hook posts on a
 * prompt, which is the honest way to reach the state rather than writing to the database underneath
 * a running server.
 */
for (const c of board.cards) {
  await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gardenSessionId: c.id,
      receivedAt: Date.now(),
      event: { hook_event_name: 'UserPromptSubmit', session_id: `cli-${c.id}`, prompt: 'do a long thing' },
    }),
  })
}
await sleep(600)

// Something only this card can have printed, so "the terminal came back" cannot be satisfied by a
// prompt banner that every shell prints anyway.
for (const [i, c] of board.cards.entries()) {
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: c.id, data: `echo MARKER-${NAMES[i]}-OK\r` }))
}
await sleep(3000)

// --- the page, before ------------------------------------------------------

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.stack || String(e)))
page.on('dialog', async (d) => {
  await d.accept()
})

const cardCount = () => page.$$eval('.node', (els) => els.length).catch(() => -1)
const minis = () =>
  page
    .$$eval('.node', (els) =>
      els.map((el) => ({
        title: el.querySelector('.node-title')?.textContent?.trim() ?? '?',
        mini: el.querySelector('.mini')?.textContent ?? '',
      })),
    )
    .catch(() => [])
const dockText = () => page.$$eval('.dock-pane', (els) => els.map((e) => e.textContent ?? '')).catch(() => [])
const offline = () => page.$$eval('.banner--offline', (els) => els.length > 0).catch(() => false)

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
await sleep(3000)

const before = await cardCount()
check('the board draws its three cards before the restart', before === 3, `${before} cards`)

const minisBefore = await minis()
const markedBefore = minisBefore.filter((m) => m.mini.includes(`MARKER-${m.title}-OK`)).length
check(
  "each card's miniature shows what its own terminal printed",
  markedBefore === 3,
  minisBefore.map((m) => `${m.title}: ${m.mini.includes(`MARKER-${m.title}-OK`) ? 'marker' : JSON.stringify(m.mini.slice(0, 60))}`).join(' | '),
)
if (before !== 3 || markedBefore !== 3) await bail('nothing to prove if the board was not right to begin with')

// One card open in the dock, because his second complaint is about the pane and the miniature
// disagreeing after a restart.
const opened = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.rail-section .row')].find((b) => b.textContent?.includes('Alpha'))
  if (!row) return false
  row.click()
  return true
})
await sleep(2500)
const dockBefore = await dockText()
check(
  'a terminal is open in the dock and shows that card, before the restart',
  opened && dockBefore.some((t) => t.includes('MARKER-Alpha-OK')),
  `${dockBefore.length} pane(s)`,
)

// --- press it --------------------------------------------------------------

const pressed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart server')
  if (!btn) return false
  btn.click()
  return true
})
check('the Restart server button is on the page and was pressed', pressed)
if (!pressed) await bail('no button to press')

const t0 = Date.now()
const since = () => ((Date.now() - t0) / 1000).toFixed(1)

const wentDown = await waitUntil(async () => !(await up(PORT)), 30_000)
const downAt = since()
check('the server goes down', wentDown, wentDown ? `stopped answering after ${downAt}s` : 'never went down')

const cameBack = await waitUntil(() => up(PORT), 90_000)
const upAt = since()
check('and comes back up', cameBack, cameBack ? `answering again after ${upAt}s` : 'still down after 90s')
if (!cameBack) await bail('the server half failed, which is a different fault from the one under test')

// --- what the page says while it is away -----------------------------------

/*
 * Asked for regardless of what else this test finds. The order was explicit that what the page says
 * while the server is away is worth knowing on its own, so it is measured rather than built for.
 */
const bannerGone = await waitUntil(async () => !(await offline()), 60_000)
note(`the offline banner cleared after ${since()}s from the press` + (bannerGone ? '' : ' (it did not clear)'))
const bannerText = await page
  .$eval('.banner--offline', (el) => el.textContent?.trim() ?? '')
  .catch(() => '(no banner on screen now)')
note(`banner text while down: ${bannerText}`)

// --- did the page ask the new server for anything --------------------------

/*
 * The card made after the restart, over a socket of this script's own, is what tells a reconnected
 * page apart from one holding a stale picture. Counting the three that were already drawn proves
 * nothing: they never leave the DOM either way.
 */
const projectId = board.state.projects[0]?.id
const maker = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
/*
 * The same socket watches the revive, because `revive` is not instant and the interesting moment is
 * after it, not before. It waits 1.5s, then starts one card every 4s, and each start is a NEW
 * process whose buffer begins empty. A miniature checked before that has only proved that the log
 * on disk survived the kill.
 */
const revivedPids = new Map()
maker.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated' && m.session.pid) revivedPids.set(m.session.id, m.session.pid)
  if (m.t === 'state') for (const s of m.sessions) if (s.pid) revivedPids.set(s.id, s.pid)
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
    title: 'Delta',
    roleClass: null,
    reportsTo: null,
    start: false,
  }),
)
const repainted = await waitUntil(async () => (await cardCount()) === 4, 45_000)
check(
  'the board repaints WITHOUT a reload',
  repainted,
  repainted ? `four cards ${since()}s after the press` : `${await cardCount()} cards after ${since()}s`,
)

// --- the conversations -----------------------------------------------------

/*
 * The second complaint, measured. A revived card is a NEW process with an empty buffer, so what the
 * miniature should be showing is either the log kept on disk from the run that was killed or the
 * output of the run that replaced it. Blank is the failure, and so is a marker that belongs to
 * another card.
 */
const restored = await waitUntil(async () => {
  const now = await minis()
  return now.filter((m) => NAMES.includes(m.title) && m.mini.includes(`MARKER-${m.title}-OK`)).length === 3
}, 60_000)
const minisAfter = await minis()
check(
  'every card still shows its own conversation, without opening a terminal',
  restored,
  minisAfter
    .filter((m) => NAMES.includes(m.title))
    .map((m) => `${m.title}: ${m.mini.includes(`MARKER-${m.title}-OK`) ? 'marker' : JSON.stringify(m.mini.replace(/\s+/g, ' ').trim().slice(0, 70))}`)
    .join(' | '),
)
note(`miniatures settled at ${since()}s from the press`)

const dockAfter = await dockText()
check(
  'the terminal that was open in the dock is still open and still readable',
  dockAfter.some((t) => t.includes('MARKER-Alpha-OK')),
  `${dockAfter.length} pane(s): ${dockAfter.map((t) => JSON.stringify(t.replace(/\s+/g, ' ').trim().slice(0, 70))).join(' | ') || 'none'}`,
)

// --- and again once the cards have actually been brought back --------------

/*
 * Everything above happens within about three seconds, while the cards are still stopped and their
 * miniatures are being read off the log on disk. `revive` has not started any of them yet. The half
 * of the restart the owner spends looking at is the next thirty seconds, so the same questions are
 * asked again once every card has a process again.
 */
const allRevived = await waitUntil(() => board.cards.every((c) => revivedPids.has(c.id)), 90_000, 500)
note(
  allRevived
    ? `all three cards had a new process by ${since()}s from the press`
    : `only ${revivedPids.size} of three cards ever got a new process, ${since()}s after the press`,
)
check('the cards that were running are running again', allRevived, `${revivedPids.size}/3 revived`)
// A beat past the last start, so the last card's own output has had time to reach the page.
await sleep(4000)

const minisRevived = await minis()
const keptAfterRevive = minisRevived.filter((m) => NAMES.includes(m.title) && m.mini.includes(`MARKER-${m.title}-OK`)).length
check(
  'and each still shows its own conversation after being brought back',
  keptAfterRevive === 3,
  minisRevived
    .filter((m) => NAMES.includes(m.title))
    .map((m) => `${m.title}: ${m.mini.includes(`MARKER-${m.title}-OK`) ? 'marker' : JSON.stringify(m.mini.replace(/\s+/g, ' ').trim().slice(0, 70))}`)
    .join(' | '),
)

const dockRevived = await dockText()
const dockKept = dockRevived.some((t) => t.includes('MARKER-Alpha-OK'))
check(
  'and the open dock terminal still shows it too',
  dockKept,
  `${dockRevived.length} pane(s): ${dockRevived.map((t) => JSON.stringify(t.replace(/\s+/g, ' ').trim().slice(0, 90))).join(' | ') || 'none'}`,
)

// --- and the control, which decides which half to blame --------------------

if (!restored || keptAfterRevive !== 3 || !dockKept) {
  await page.reload({ waitUntil: 'networkidle0' })
  await sleep(4000)
  const minisReloaded = await minis()
  const dockReloaded = await dockText()
  const backAfterF5 = minisReloaded.filter((m) => NAMES.includes(m.title) && m.mini.includes(`MARKER-${m.title}-OK`)).length
  check(
    'but F5 brings the conversations back, so the server kept them and the page did not ask again',
    backAfterF5 === 3,
    `${backAfterF5}/3 miniatures after a reload, ${dockReloaded.length} dock pane(s)`,
  )
}

if (errors.length) console.log(`console errors during the run:\n${errors.slice(0, 8).join('\n')}`)

await browser.close()
/*
 * The processes first, then the server. `killByPort` is a hard stop, so the shells this test started
 * would be left orphaned on the owner's machine; asking the server to stop them is what the button
 * in the app does and it takes the conhost each one owns with it.
 */
for (const c of board.cards) maker.send(JSON.stringify({ t: 'session.stop', sessionId: c.id }))
await sleep(2000)
await killByPort()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
