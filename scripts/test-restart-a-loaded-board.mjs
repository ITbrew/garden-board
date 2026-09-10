/**
 * The same restart, on a board the size the owner actually keeps.
 *
 * `test-restart-with-running-cards.mjs` does this with three running cards and passes: the board is
 * back in under two seconds and every miniature still shows its own conversation. Three is not what
 * he has. His board carries a dozen or more cards, each with a long conversation behind it, and on
 * reconnect the page asks for `session.scrollback` for every single one of them. Each of those
 * replies can be the full 256 KB buffer, and each one is replayed into a headless terminal on the
 * page's only thread. Twelve of those is several megabytes down one socket and twelve full replays
 * in a row, and that cost does not exist at all on a board of three.
 *
 * So this fills every card's buffer to the cap before restarting, and measures. It is a measurement
 * first and an assertion second: if a loaded board comes back in three seconds then scale is not the
 * fault and this file says so, and if it takes half a minute then a board he reasonably concludes is
 * dead is the finding.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board.
 *
 *   npm run build
 *   node scripts/test-restart-a-loaded-board.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
/**
 * Ten, which is a real board and also the largest that leaves room to prove anything.
 *
 * It was twelve first, and twelve is exactly `DEFAULT_LIMITS.cardsPerProject`. The probe below
 * creates one more card after the restart, so at twelve the ceiling refused it and this file
 * reported a page that had not repainted for two minutes. It had repainted; the card it was waiting
 * for was never made. Hence the error listener on that socket as well: a refusal must never again be
 * readable as a fault in the thing under test.
 */
const HOW_MANY = 10
/** Enough lines to run a 256 KB buffer over its cap, so every card answers with a full one. */
const FILL_LINES = 4000
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

const NAMES = Array.from({ length: HOW_MANY }, (_, i) => `Card${i + 1}`)
const board = await openBoard({ projectName: 'restartloaded', cards: NAMES.map((title) => ({ title })) })
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

// `openBoard`'s state never merges `session.updated`, so a start is only visible in a listener here.
const pids = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated') pids.set(m.session.id, m.session.pid)
})

for (const c of board.cards) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(6000)
const livePids = board.cards.filter((c) => pids.get(c.id)).length
check(`all ${HOW_MANY} cards have real processes behind them`, livePids === HOW_MANY, `${livePids} with a pid`)
if (livePids !== HOW_MANY) await bail('the point of this test is a loaded board')

// Busy, the way a CLI's own hook says so, since `revive` deliberately leaves idle cards down.
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

/*
 * Fill each buffer past its cap, then print the marker last so it is the thing at the bottom that
 * a miniature would be showing. Filling is the whole point of this file: a board of empty cards
 * answers a reconnect with nothing and proves nothing about a board of full ones.
 */
for (const [i, c] of board.cards.entries()) {
  board.ws.send(
    JSON.stringify({
      t: 'session.input',
      sessionId: c.id,
      data: `1..${FILL_LINES} | ForEach-Object { "filler line $_ of ${NAMES[i]} padded out to look like a real conversation line" }\r`,
    }),
  )
}
await sleep(25_000)
for (const [i, c] of board.cards.entries()) {
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: c.id, data: `echo MARKER-${NAMES[i]}-OK\r` }))
}
await sleep(6000)

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
const marked = async () => {
  const now = await minis()
  return now.filter((m) => NAMES.includes(m.title) && m.mini.includes(`MARKER-${m.title}-OK`)).length
}
const offline = () => page.$$eval('.banner--offline', (els) => els.length > 0).catch(() => false)

const loadBegan = Date.now()
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
const settledCold = await waitUntil(async () => (await marked()) === HOW_MANY, 90_000)
note(`a cold load of ${HOW_MANY} loaded cards settled in ${((Date.now() - loadBegan) / 1000).toFixed(1)}s`)

const before = await cardCount()
check(`the board draws its ${HOW_MANY} cards before the restart`, before === HOW_MANY, `${before} cards`)
check('and every miniature shows its own conversation', settledCold, `${await marked()}/${HOW_MANY} marked`)
if (before !== HOW_MANY || !settledCold) await bail('nothing to prove if the board was not right to begin with')

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

const wentDown = await waitUntil(async () => !(await up(PORT)), 60_000)
check('the server goes down', wentDown, wentDown ? `stopped answering after ${since()}s` : 'never went down')
const cameBack = await waitUntil(() => up(PORT), 120_000)
check('and comes back up', cameBack, cameBack ? `answering again after ${since()}s` : 'still down after 120s')
if (!cameBack) await bail('the server half failed, which is a different fault from the one under test')

const bannerGone = await waitUntil(async () => !(await offline()), 120_000)
note(`the offline banner cleared after ${since()}s from the press` + (bannerGone ? '' : ' (it never cleared)'))

/*
 * A card created after the restart, over a socket of this script's own. Counting the twelve already
 * drawn proves nothing: they never leave the DOM whether the page reconnected or not.
 */
const projectId = board.state.projects[0]?.id
const maker = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const revivedPids = new Map()
const refusals = []
maker.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated' && m.session.pid) revivedPids.set(m.session.id, m.session.pid)
  if (m.t === 'state') for (const s of m.sessions) if (s.pid) revivedPids.set(s.id, s.pid)
  // A refusal answers on this socket and nowhere else, and reading it is what tells "the page did
  // not draw the card" apart from "the server never made one".
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
    title: 'Newcomer',
    roleClass: null,
    reportsTo: null,
    start: false,
  }),
)
const repainted = await waitUntil(async () => (await cardCount()) === HOW_MANY + 1, 120_000)
if (refusals.length) note(`the server refused something on the probe socket: ${refusals.join(' | ')}`)
check(
  'the board repaints WITHOUT a reload',
  repainted,
  repainted ? `${HOW_MANY + 1} cards ${since()}s after the press` : `${await cardCount()} cards after ${since()}s`,
)

const backAgain = await waitUntil(async () => (await marked()) === HOW_MANY, 120_000)
check(
  'and every conversation is readable again without opening a terminal',
  backAgain,
  `${await marked()}/${HOW_MANY} marked, ${since()}s after the press`,
)

const allRevived = await waitUntil(() => board.cards.every((c) => revivedPids.has(c.id)), 180_000, 500)
note(
  allRevived
    ? `every card had a new process by ${since()}s from the press`
    : `only ${revivedPids.size} of ${HOW_MANY} cards ever got a new process, ${since()}s after the press`,
)
check(`the ${HOW_MANY} cards that were running are running again`, allRevived, `${revivedPids.size}/${HOW_MANY} revived`)
await sleep(5000)
const afterRevive = await marked()
check(
  'and every conversation survives the revive',
  afterRevive === HOW_MANY,
  `${afterRevive}/${HOW_MANY} still showing their own marker`,
)

if (errors.length) console.log(`console errors during the run:\n${errors.slice(0, 8).join('\n')}`)

await browser.close()
// The processes first, then the server: `killByPort` is a hard stop and would orphan every shell.
for (const c of board.cards) maker.send(JSON.stringify({ t: 'session.stop', sessionId: c.id }))
await sleep(4000)
await killByPort()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
