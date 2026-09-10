/**
 * His second complaint, on its own: "resetting the server messes up the cards conversation views, i
 * have to open terminal for the card to be able to read".
 *
 * The other restart tests all ask whether the CARDS come back. This one asks whether what is drawn
 * inside them is still readable, and it is built around the one thing that makes a stream readable
 * or not: the width it was drawn at. A CLI does not print finished text, it prints instructions
 * computed for a grid it believes it has, so replaying them at another width puts every wrap
 * somewhere else. `server/src/pty-manager.ts` says this at length and keeps a `.size.json` beside
 * every scrollback log for exactly this reason.
 *
 * What none of that covers is the moment `revive` starts a card again. A revived card is a NEW
 * process and `ptys.spawn` gives it the spawn grid, 120 by 30, whatever the pane that used to draw
 * it was; the card's own preview is then told that new size and reflows a history that was never
 * drawn at it. So the shape here is his shape: a card whose pane took it to a real width, a line
 * that only fits at that width, the pane closed again the way he closes it, and then the button.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board.
 *
 *   npm run build
 *   node scripts/test-restart-keeps-a-card-readable.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
/**
 * The width of the one line everything here turns on.
 *
 * Comfortably over the 120 columns a process is spawned at and under any dock pane this viewport
 * gives, so it is exactly one row while the pane's width is in force and exactly two the moment
 * something replays it at the spawn width. One token rather than a sentence, so no wrapping
 * cleverness can make it look right by accident.
 */
const LONG = 150
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

const board = await openBoard({ projectName: 'restartreadable', cards: [{ title: 'Alpha' }] })
const PORT = board.port
const card = board.cards[0]

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

/*
 * A watcher socket of this script's own, for the two facts the page cannot be asked for: the grid
 * the server believes this card is drawing at, and whether a new process has appeared.
 */
const geometry = { cols: 0, rows: 0 }
let livePid = null
/*
 * Attached to whichever socket is alive, and that matters: `board.ws` dies with the old server, so
 * asking it anything after the restart answers with nothing and reads as a card with no geometry.
 * The first version of this file printed `0x17` for exactly that reason.
 */
const watch = (sock) =>
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'session.scrollback' && m.sessionId === card.id) {
      geometry.cols = m.cols
      geometry.rows = m.rows
    }
    if (m.t === 'session.updated' && m.session.id === card.id) livePid = m.session.pid
  })
watch(board.ws)
const askGeometry = async (sock) => {
  geometry.cols = 0
  sock.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  const answered = await waitUntil(async () => geometry.cols > 0, 5000, 100)
  return answered ? { ...geometry } : { cols: -1, rows: -1 }
}

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(3000)
check('the card has a real process behind it', Boolean(livePid), livePid ? `pid ${livePid}` : 'never started')
if (!livePid) await bail('the point of this test is a running card')

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('dialog', async (d) => {
  await d.accept()
})

/** Every row the miniature is drawing, in order, as plain strings. */
const miniRows = () =>
  page.$$eval('.node .mini-row', (els) => els.map((e) => e.textContent ?? '')).catch(() => [])
const widestRow = async () => (await miniRows()).reduce((w, r) => Math.max(w, r.trimEnd().length), 0)

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
await sleep(2500)

// The pane, which is what takes the process off the spawn grid and onto a real one.
const opened = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.rail-section .row')].find((b) => b.textContent?.includes('Alpha'))
  if (!row) return false
  row.click()
  return true
})
await sleep(3000)
const paneGrid = await askGeometry(board.ws)
check(
  'opening a pane takes the process off the 120-column spawn grid',
  opened && paneGrid.cols > LONG,
  `the server has it at ${paneGrid.cols}x${paneGrid.rows}`,
)
if (!opened || paneGrid.cols <= LONG) await bail('a pane no wider than the test line proves nothing about width')

// The line that only fits on one row at the pane's width.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: `echo ${'W'.repeat(LONG)}\r` }))
await sleep(2500)

// And the pane closed again, the way he closes one after reading it. Nothing resizes a card with no
// pane, so this is the state most of his board is in when he presses the button.
const closed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dock-head button')].find((b) => b.textContent?.trim() === 'Close pane')
  if (!btn) return false
  btn.click()
  return true
})
await sleep(2000)
check('the pane is closed again, leaving the card with no terminal open', closed)

const wideBefore = await widestRow()
check(
  `the miniature draws the ${LONG}-column line as one row`,
  wideBefore >= LONG,
  `widest row is ${wideBefore} characters`,
)
if (wideBefore < LONG) await bail('the line under test was not drawn whole even before the restart')

/*
 * Busy, the way a CLI's own hook says so, because `revive` deliberately leaves an idle card down and
 * a card that is never revived never gets the new process this test is about.
 */
await fetch(`http://127.0.0.1:${PORT}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: card.id,
    receivedAt: Date.now(),
    event: { hook_event_name: 'UserPromptSubmit', session_id: `cli-${card.id}`, prompt: 'do a long thing' },
  }),
})
await sleep(600)

const pressed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart server')
  if (!btn) return false
  btn.click()
  return true
})
check('the Restart server button was pressed', pressed)
if (!pressed) await bail('no button to press')

const t0 = Date.now()
const since = () => ((Date.now() - t0) / 1000).toFixed(1)

const wentDown = await waitUntil(async () => !(await up(PORT)), 30_000)
check('the server goes down', wentDown, wentDown ? `after ${since()}s` : 'never went down')
const cameBack = await waitUntil(() => up(PORT), 90_000)
check('and comes back up', cameBack, cameBack ? `after ${since()}s` : 'still down')
if (!cameBack) await bail('the server half failed, which is a different fault from the one under test')

/*
 * The card is stopped at this point and its miniature is read off the log on disk, at the width the
 * `.size.json` beside it records. That half already works, and it is worth asserting separately so a
 * failure below cannot be blamed on it.
 */
const stillWideWhileStopped = await waitUntil(async () => (await widestRow()) >= LONG, 30_000)
check(
  'while the card is still stopped, its miniature is drawn at the width it was written at',
  stillWideWhileStopped,
  `widest row is ${await widestRow()} characters, ${since()}s after the press`,
)

// Now the part nothing has ever tested: the card being started again.
const watcher = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
let revivedPid = null
watch(watcher)
watcher.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated' && m.session.id === card.id && m.session.pid) revivedPid = m.session.pid
  if (m.t === 'state') for (const s of m.sessions) if (s.id === card.id && s.pid) revivedPid = s.pid
})
await new Promise((r, x) => {
  watcher.on('open', r)
  watcher.on('error', x)
})
watcher.send(JSON.stringify({ t: 'hello' }))

const revived = await waitUntil(() => revivedPid !== null, 90_000, 500)
check('the card that was running is running again', revived, revived ? `pid ${revivedPid} at ${since()}s` : 'never came back')
if (!revived) await bail('a card that was never revived cannot show what a revived one draws')

// A beat for the new process's first bytes and for the page to have acted on the new pid.
await sleep(6000)

const grid = await askGeometry(watcher)
note(`after the revive the server has this card at ${grid.cols}x${grid.rows}`)
const wideAfter = await widestRow()
const rows = await miniRows()
check(
  'and its conversation is still drawn at the width it was written at, with no terminal opened',
  wideAfter >= LONG,
  `widest row is ${wideAfter} characters` +
    (wideAfter >= LONG ? '' : `, so the ${LONG}-column line has been re-wrapped; rows now ${JSON.stringify(rows.slice(-6).map((r) => r.trimEnd().length))}`),
)
/*
 * On one row, and the row is the assertion.
 *
 * `.mini`'s textContent joins every row end to end, so a line cut in half at column 120 still reads
 * as 150 unbroken W's there. That version of this check passed against a miniature that was visibly
 * wrong, which is the same trap `test-restart-repaints-the-board.mjs` records: an assertion that
 * cannot tell the two outcomes apart is not an assertion.
 */
const whole = (await miniRows()).some((r) => r.trimEnd() === 'W'.repeat(LONG))
check(
  'and the line is on one row rather than cut in half',
  whole,
  whole ? '' : `no row is the whole ${LONG} characters`,
)

await browser.close()
watcher.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(2000)
await killByPort()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
