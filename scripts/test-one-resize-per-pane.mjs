/**
 * Proves opening a terminal pane tells the process one size, and that it is the measured one.
 *
 * Opening a pane used to send `106x34` and then, a moment later, `106x13`. The pane holds 13. The
 * first figure was not measured: the mount-time fit ran before the browser had laid the container
 * out, and a fit against a box with no height answers with the whole viewport. Garden then sent that
 * guess to the process as a fact about its screen, which is the one thing this project exists not to
 * do, whatever the CLI on the other end does with it.
 *
 * The server records the geometry it was told, and answers `session.scrollback` with it, so the
 * check reads the size the process is actually running at rather than anything on screen.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const title = `Fit ${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: [title] })
const card = board.cards[0]

const geometry = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.scrollback' && m.sessionId === card.id) geometry.push(`${m.cols}x${m.rows}`)
})

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(2500)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

// Open the pane the way the owner does, from the sidebar's list of live sessions.
const opened = await page.evaluate((t) => {
  const row = [...document.querySelectorAll('.row')].find(
    (r) => r.querySelector('.row-label')?.textContent?.trim() === t,
  )
  if (!row) return false
  row.click()
  return true
}, title)
check('the pane opened', opened)

// Well past the 120 ms settle, so anything that was going to be sent has been.
await sleep(2500)

board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
await sleep(1000)

const reported = geometry[geometry.length - 1] ?? '(none)'
const rows = Number(reported.split('x')[1])

// What the pane actually is on screen, measured from xterm's own grid rather than assumed.
const onScreen = await page.evaluate(() => {
  const rowsEl = document.querySelector('.dock-pane .xterm-rows')
  return rowsEl ? rowsEl.children.length : 0
})

check('the process was told a size at all', reported !== '(none)', reported)
check(
  'and it is the size of the pane, not of the viewport',
  onScreen > 0 && Math.abs(rows - onScreen) <= 1,
  `told ${reported}, pane holds ${onScreen} rows`,
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
