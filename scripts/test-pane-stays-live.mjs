/**
 * Proves a terminal pane the owner is looking at is never disposed to make room for another one.
 *
 * The pool keeps one xterm per session and caps them at eight, evicting the least recently used.
 * "Least recently used" was stamped once, when a pane mounted, and eviction did not care whether
 * the instance it picked was still on screen. So a pane left open while other panes were opened and
 * closed around it aged into being the oldest thing in the pool, and the ninth one opened disposed
 * it: unsubscribed from the byte stream, xterm disposed, host pulled out of the DOM. The pane went
 * on showing the last frame it had drawn and never updated again, with no error anywhere.
 *
 * That is the "terminals stop updating text" the owner reported, and this is the sequence that
 * causes it: keep one pane open, and open and close eight others.
 *
 * The assertion is a byte written into the pinned session's real PTY appearing in the pinned pane.
 * Reading it off the screen rather than off the socket is the point: the socket kept working the
 * whole time, and it was the pane that had stopped listening.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// One more than the pool's cap of eight, because the cap is what triggers an eviction at all.
const CARD_COUNT = 9
const stamp = Date.now().toString().slice(-6)
const titles = Array.from({ length: CARD_COUNT }, (_, i) => `Pool${i + 1} ${stamp}`)
const marker = `GARDEN_PANE_ALIVE_${stamp}`

const board = await openBoard({ cards: titles })
const pinned = board.cards[0]

// Live shells, because the sidebar only lists sessions with a process and clicking those rows is
// how a pane is opened by hand. They are plain shells, so this costs no tokens.
for (const card of board.cards) {
  board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
  await sleep(250)
}
await sleep(2500)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

/** Click the sidebar row for a card, which is how the owner opens a pane. */
async function openPane(title) {
  const ok = await page.evaluate((t) => {
    const row = [...document.querySelectorAll('.row')].find(
      (r) => r.querySelector('.row-label')?.textContent?.trim() === t,
    )
    if (!row) return false
    row.click()
    return true
  }, title)
  await sleep(600)
  return ok
}

/** Close one named pane, leaving every other pane alone. */
async function closePane(title) {
  const ok = await page.evaluate((t) => {
    const pane = [...document.querySelectorAll('.dock-pane')].find(
      (p) => p.querySelector('.dock-title')?.textContent?.trim() === t,
    )
    if (!pane) return false
    const btn = [...pane.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close pane')
    if (!btn) return false
    btn.click()
    return true
  }, title)
  await sleep(500)
  return ok
}

check('the sidebar lists the live cards', await openPane(titles[0]), titles[0])

// Every other card is opened and closed in turn while the first one stays open. By the last of
// them the pool is over its cap and has to evict something, and the first card is the oldest
// acquire in it.
for (let i = 1; i < CARD_COUNT; i++) {
  await openPane(titles[i])
  await closePane(titles[i])
}
await sleep(600)

const stillOpen = await page.evaluate(
  (t) =>
    [...document.querySelectorAll('.dock-pane')].some(
      (p) => p.querySelector('.dock-title')?.textContent?.trim() === t,
    ),
  titles[0],
)
check('the pinned pane is still open after eight others came and went', stillOpen)

// Into the real PTY, not into the page, so nothing about this write depends on the pane.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: pinned.id, data: `echo ${marker}\r` }))
await sleep(3000)

const shown = await page.evaluate(
  (t) =>
    [...document.querySelectorAll('.dock-pane')].find(
      (p) => p.querySelector('.dock-title')?.textContent?.trim() === t,
    )?.innerText ?? '',
  titles[0],
)
check('the pinned pane is still drawing what its process prints', shown.includes(marker), shown.slice(-160))

// The instance survived as well as the subscription: a disposed xterm leaves an empty host behind,
// so an eviction that happened would show here even if the text check were somehow satisfied.
const hasRows = await page.evaluate(
  (t) =>
    !!(
      [...document.querySelectorAll('.dock-pane')].find(
        (p) => p.querySelector('.dock-title')?.textContent?.trim() === t,
      )?.querySelector('.xterm-rows')
    ),
  titles[0],
)
check('the pinned pane still holds a real terminal', hasRows)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
