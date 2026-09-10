/**
 * Proves the line under a card writes straight into that session's terminal.
 *
 * It types a command with a unique marker into the card's input, presses Enter, and then reads
 * the session's own scrollback back off the server. If the marker and its output are there, the
 * input is the real terminal and not a separate chat pretending to be one.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const marker = `GARDEN_CARD_INPUT_${Math.floor(Date.now() / 1000)}`
const ownTitle = `InputTest ${Date.now().toString().slice(-6)}`

// A board of its own, with one card on it. Cards come off openBoard switched off, since most
// tests never need a real shell behind them, but this one is specifically about typing into a
// live terminal, so it is started here and expanded before the browser ever looks at it.
const board = await openBoard({ cards: [ownTitle] })
const UI = board.UI
const own = board.cards[0]

// The scrollback answer arrives as its own message type, which openBoard's own listener does not
// track. A second listener on the same socket is enough; ws lets more than one subscribe.
const scroll = {}
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.scrollback') scroll[m.sessionId] = m.data
})

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: own.id }))
await sleep(2500)
board.ws.send(JSON.stringify({ t: 'session.setCollapsed', sessionId: own.id, collapsed: false }))
await sleep(700)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

// The card has to be running and expanded for its input line to be there.
const ready = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.node')].find((n) => n.querySelector('.node-input input:not(:disabled)'))
  if (!card) return null
  const title = card.querySelector('.node-title')?.textContent ?? ''
  return title
})
check('a live card with an input line is on the board', !!ready, ready ?? 'none found')
if (!ready) {
  await browser.close()
  await board.stop()
  process.exit(1)
}

await page.click('.node-input input:not(:disabled)')
await page.keyboard.type(`echo ${marker}`)
await page.keyboard.press('Enter')
await sleep(3000)

// Read the scrollback straight from the server rather than off the screen.
board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: own.id }))
await sleep(1200)

const all = Object.values(scroll).join('\n')
const clean = all.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
check('the command reached a real terminal', clean.includes(marker), marker)
// The echoed command and its output both appear, so it ran rather than merely being displayed.
const occurrences = clean.split(marker).length - 1
check('it was executed, not just echoed', occurrences >= 2, `${occurrences} occurrences`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
