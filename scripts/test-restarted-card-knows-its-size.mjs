/**
 * A card turned off and on again must be told how big its pane is.
 *
 * Every process starts at the spawn default of 120x30, whatever the dock actually looks like, and
 * the pane corrects it once it has measured itself. That correction is deduped on the client:
 * `actions.resize` remembers the last size it sent per session and drops a repeat, which is right
 * while one process is running and wrong the moment a second one replaces it. Stop a card and start
 * it again and the pane has not changed, so the dedupe swallows the message, and the new process
 * spends its whole life believing it has 120 columns while the pane draws it at whatever the dock
 * gives.
 *
 * That mismatch is the other half of the smeared text. The CLI computes its wrapping and its cursor
 * moves for 120 columns; xterm lays those instructions out over a grid twice as wide; every "move up
 * three lines" lands somewhere the CLI never meant. Nothing in the app reports this, because both
 * sides are internally consistent and only disagree with each other.
 *
 * The assertion reads the geometry the SERVER holds for the live process, not anything rendered, so
 * it is about what the CLI was told rather than about what a pane looks like.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/** The size every process starts at, from server/src/pty-manager.ts. */
const SPAWN_COLS = 120

const title = `Restart ${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: [title] })
const card = board.cards[0]

const scroll = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.scrollback' && m.sessionId === card.id) scroll.push(m)
})

async function geometry() {
  const before = scroll.length
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  const deadline = Date.now() + 5000
  while (scroll.length === before && Date.now() < deadline) await sleep(50)
  return scroll[scroll.length - 1]
}

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(3000)

const browser = await puppeteer.launch({
  executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless: 'new',
  // Deliberately wide, so the pane's grid cannot be mistaken for the spawn default.
  defaultViewport: { width: 2400, height: 1300 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const opened = await page.evaluate((t) => {
  const row = [...document.querySelectorAll('.row')].find(
    (r) => r.querySelector('.row-label')?.textContent?.trim() === t,
  )
  if (!row) return false
  row.click()
  return true
}, title)
check('the pane opened', opened)
await sleep(3000)

const first = await geometry()
check(
  'the first process was told the pane size, not the spawn default',
  first && first.cols !== SPAWN_COLS,
  `process has ${first?.cols}x${first?.rows}, spawn default is ${SPAWN_COLS}`,
)

// Off and on, with the pane left open and untouched the whole time.
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(2500)
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(5000)

const second = await geometry()
check(
  'the replacement process was told the same pane size',
  second && second.cols === first.cols && second.rows === first.rows,
  `after restart the process has ${second?.cols}x${second?.rows}, the pane is ${first?.cols}x${first?.rows}`,
)

// What the pane is actually drawing, so the check above is comparing the process against the screen
// rather than against a number this test made up.
const onScreen = await page.evaluate(() => {
  const rows = document.querySelectorAll('.dock-pane .xterm-rows > div')
  return { rows: rows.length, cols: Math.max(...[...rows].map((r) => (r.textContent ?? '').length), 0) }
})
check(
  'and that size is the grid on screen',
  second && Math.abs(second.rows - onScreen.rows) <= 1,
  `process ${second?.cols}x${second?.rows}, pane draws ${onScreen.rows} rows`,
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
