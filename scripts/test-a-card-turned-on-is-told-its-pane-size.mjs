/**
 * A card turned on with its pane already open must be told how big that pane is. Canon 03.
 *
 * The owner's report: "when turning cards on theres this problem with typing". The input box was
 * gone and what they typed landed on the status line. The process was drawing for 110x29 and the
 * pane held 118x26, so every move to a row below 26 landed on the pane's last row: the rule, the
 * input and the status line all on top of each other.
 *
 * A pane over an off card says nothing about its size, because there is no process to tell, and a
 * process starts at the size last recorded for the card. So any change to the pane while the card
 * was off has to be reported when it comes back on, and this checks that it is.
 *
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first. It uses
 * the shell adapter and spends nothing.
 */
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Alpha'] })
const card = board.cards[0]

let pid = null
let size = null
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if ((m.t === 'session.updated' || m.t === 'session.added') && m.session?.id === card.id) pid = m.session.pid
  if (m.t === 'session.scrollback' && m.sessionId === card.id) size = { cols: m.cols, rows: m.rows }
})

/** The size the server holds for the process. */
const serverSize = async () => {
  size = null
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  await sleep(500)
  return size
}

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(4000)
check('the card is running to begin with', pid !== null)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

await page.evaluate(() => {
  const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent?.trim() === 'Alpha')
  row?.click()
})
await sleep(2500)
check('its pane opens', (await page.$('.dock-pane .xterm')) !== null)

/** The rows and columns the pane is really showing, measured from what it drew. */
const paneSize = () =>
  page.evaluate(() => {
    const x = document.querySelector('.dock-pane .xterm')
    if (!x) return null
    const rows = x.querySelectorAll('.xterm-rows > div').length
    const measure = x.querySelector('.xterm-char-measure-element')
    const cell = measure ? measure.getBoundingClientRect().width / measure.textContent.length : 0
    const width = x.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0
    return { cols: cell ? Math.round(width / cell) : 0, rows }
  })

const before = await paneSize()
const reported = await serverSize()
check('while it runs the process and the pane agree', reported?.rows === before?.rows && reported?.cols === before?.cols,
  `process ${JSON.stringify(reported)}, pane ${JSON.stringify(before)}`)

const turnOn = async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dock-pane .dock-offbar button')].find((n) => n.textContent.trim() === 'Turn on')
    b?.click()
  })
  await sleep(5000)
}

// ---------------------------------------------------------------------------
// Off, the pane changes size, and it comes back on.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(3000)
check('the process really ended', pid === null)

await page.setViewport({ width: 1300, height: 760 })
await sleep(1500)
const resized = await paneSize()
check('the pane really changed size while off', resized?.rows !== before?.rows && resized?.cols !== before?.cols,
  `${JSON.stringify(before)} to ${JSON.stringify(resized)}`)

await turnOn()
check('Turn on started it', pid !== null)
let shown = await paneSize()
let process_ = await serverSize()
check('a card turned on after its pane resized is told the new size',
  process_?.rows === shown?.rows && process_?.cols === shown?.cols,
  `process ${JSON.stringify(process_)}, pane ${JSON.stringify(shown)}`)

// ---------------------------------------------------------------------------
// The same with no resize at all, off and on again, in case the size only arrives on a change.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(3000)
await turnOn()
shown = await paneSize()
process_ = await serverSize()
check('off and on with the pane unchanged, they still agree',
  process_?.rows === shown?.rows && process_?.cols === shown?.cols,
  `process ${JSON.stringify(process_)}, pane ${JSON.stringify(shown)}`)

// ---------------------------------------------------------------------------
// The page reloads while the card is off, which is every restart of Garden.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(3000)
await page.setViewport({ width: 1500, height: 900 })
await page.reload({ waitUntil: 'networkidle2' })
await sleep(3000)
const reopened = (await page.$('.dock-pane .xterm')) !== null
console.log(`after the reload the pane is ${reopened ? 'still open' : 'closed'}`)
if (reopened) {
  await turnOn()
  shown = await paneSize()
  process_ = await serverSize()
  check('after a reload while off, a card turned on is told its size',
    process_?.rows === shown?.rows && process_?.cols === shown?.cols,
    `process ${JSON.stringify(process_)}, pane ${JSON.stringify(shown)}`)

  // What the owner actually saw: a program that places its input box by absolute row, as the CLI
  // does, drawn in this pane. It reads its size from the terminal, so it is only right if the pane
  // and the process agree. A stand-in for the CLI, because a real one costs money to run in a test.
  const fixture = join(board.dir, 'box.cjs')
  writeFileSync(fixture, [
    "const out = process.stdout; let typed = ''",
    'const draw = () => {',
    '  const r = out.rows, line = "-".repeat(out.columns)',
    '  out.write(`\\x1b[?1049h\\x1b[2J\\x1b[${r - 3};1H${line}\\x1b[${r - 1};1H${line}\\x1b[${r};3Hstatus line`)',
    '  out.write(`\\x1b[${r - 2};1H> ${typed}`)',
    '}',
    "process.stdin.setRawMode(true); process.stdin.on('data', (d) => { typed += d; draw() })",
    "out.on('resize', draw); draw(); setTimeout(() => process.exit(0), 20000)",
  ].join('\n'))
  await page.click('.dock-pane .xterm')
  await page.keyboard.type(`node "${fixture}"\r`)
  await sleep(2500)
  await page.keyboard.type('hello')
  await sleep(1000)
  const bottom = await page.evaluate(() =>
    [...document.querySelectorAll('.dock-pane .xterm-rows > div')].slice(-4).map((d) => d.textContent.trim()))
  check('the input box stands on its own row above the status line',
    /^-+$/.test(bottom[0]) && /^-+$/.test(bottom[2]) && bottom[3] === 'status line', JSON.stringify(bottom).slice(0, 200))
  check('and typed text appears inside it', bottom[1] === '> hello', bottom[1])
}

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')
await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
