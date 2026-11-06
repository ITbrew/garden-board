/**
 * One Enter in a card's line sends it, and the line and the return arrive far enough apart.
 *
 * The owner's report: "sometimes i have to press enter twice in card after i type for it to actually
 * enter, make one enter count instead of requiring 2. terminals are typically 1, so i press enter
 * waiting for response but its sitting in input field".
 *
 * Two things have to hold and they fail differently. The card's own input must clear on the first
 * Enter, or the press did nothing at all. And the text and the carriage return must reach the process
 * far enough apart to be read as typing rather than as a paste: Claude's composer watches how input
 * arrives and leaves a burst that ends in a newline sitting in the composer unsent, which is exactly
 * "its sitting in input field" from the other side of the glass.
 *
 * The gap was 40ms in the source and nothing had ever measured what came out the other end, which is
 * two websocket messages, a server, and a PTY write away from that number. `scripts/lib/gap-reader.mjs`
 * is a program that reports its own stdin arrivals, so the figure asserted here is the one the
 * process actually saw.
 */
import puppeteer from 'puppeteer-core'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const READER = resolve(HERE, 'lib', 'gap-reader.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/** The smallest gap that counts as typing rather than a paste, per the rest of the server. */
const MIN_GAP_MS = 55

const title = `Line ${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: [title] })
const card = board.cards[0]

const scroll = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.scrollback' && m.sessionId === card.id) scroll.push(m.data ?? '')
})

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(3000)
// The reader takes over stdin, so from here every arrival is reported with its gap.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: `node "${READER}"` }))
await sleep(200)
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
await sleep(3500)

const browser = await puppeteer.launch({
  executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless: 'new',
  defaultViewport: { width: 2400, height: 1300 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const MARKER = 'hello-from-the-card'
const typed = await page.evaluate(async (text) => {
  const input = document.querySelector('.node-input input')
  if (!input) return 'no input'
  input.focus()
  // Set the value the way React sees it, then one Enter and nothing else.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
}, MARKER)
check('the card has a line to type into', typed === 'typed', typed)

await page.evaluate(() => {
  const input = document.querySelector('.node-input input')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const form = input.closest('form')
  if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})
await sleep(2500)

/*
 * The field is empty, which is what says the press did something. A press that leaves the text where
 * it was is the half of the complaint that happens before anything reaches the process.
 */
const leftInField = await page.evaluate(() => document.querySelector('.node-input input')?.value ?? '(gone)')
check('one Enter clears the card\'s line', leftInField === '', `field holds ${JSON.stringify(leftInField)}`)

// What the process actually saw, read from its own output.
board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
await sleep(1500)
const out = scroll[scroll.length - 1] ?? ''
const arrivals = [...out.matchAll(/ARRIVAL (CR|"[^"]*") gap=(\d+)/g)].map((m) => ({ what: m[1], gap: Number(m[2]) }))

check('the process received the line and the return', arrivals.length >= 2, `${arrivals.length} arrivals seen`)
const cr = arrivals.find((a) => a.what === 'CR')
check('the return arrived separately, not in the same burst', !!cr, cr ? `gap ${cr.gap}ms` : 'no separate CR')
check(
  'and far enough after the text to read as typing rather than a paste',
  !!cr && cr.gap >= MIN_GAP_MS,
  cr ? `${cr.gap}ms, wanted at least ${MIN_GAP_MS}ms` : 'no CR',
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
