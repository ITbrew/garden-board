/**
 * Card sizing, checked against the DATABASE rather than rendered rectangles.
 *
 * Two earlier versions of this test lied. The first asserted on bounding boxes across a zoom
 * change and passed while the stored size never moved. The second looked up "the first session"
 * in SQLite and clicked a card with the same title, which on a board where every project's first
 * shell is called "Shell 1" was a different session entirely.
 *
 * So this one creates its own card with a unique name, drives that card, and reads that row.
 */
import puppeteer from 'puppeteer-core'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const title = `SizeTest ${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: [title], projectName: 'resize' })
const UI = board.UI
const target = board.cards[0]
check('the test created its own card', !!target, title)
if (!target) {
  await board.stop()
  process.exit(1)
}

// This instance's own database, in its own home directory, never ~/.garden: the row being read
// here only exists on this board.
const DB = join(board.home, 'garden.db')
function row(id) {
  const d = new Database(DB, { readonly: true })
  try {
    return d.prepare('SELECT title,size,width,height FROM sessions WHERE id = ?').get(id)
  } finally {
    d.close()
  }
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(2800)

const press = (glyph) =>
  page.evaluate(
    (t, g) => {
      const node = [...document.querySelectorAll('.react-flow__node')].find(
        (n) => n.querySelector('.node-title')?.textContent === t,
      )
      if (!node) return 'no card'
      const btn = [...node.querySelectorAll('.node-head .twisty')].find((b) => b.textContent.trim() === g)
      if (!btn) return 'no button'
      btn.click()
      return 'clicked'
    },
    title,
    glyph,
  )

const dbl = () =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.react-flow__node')].find(
      (n) => n.querySelector('.node-title')?.textContent === t,
    )
    if (!node) return false
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    return true
  }, title)

check('the card is on screen', (await press('⤢')) === 'clicked')
await sleep(1300)
check('the size button changed the stored size', row(target.id).size === 'large', `size=${row(target.id).size}`)

await press('⤢')
await sleep(1300)
check('a second press stored full', row(target.id).size === 'full', `size=${row(target.id).size}`)

await press('–')
await sleep(1300)
check('minimize stepped the stored size back down', row(target.id).size === 'large', `size=${row(target.id).size}`)

// Double-click toggles: back to the size it has on the board, then out again.
await dbl()
await sleep(1300)
check('double-click returns an expanded card to normal', row(target.id).size === 'normal',
  `size=${row(target.id).size}`)

await dbl()
await sleep(1300)
check('double-click again expands it', row(target.id).size === 'large', `size=${row(target.id).size}`)

const handles = await page.$$eval('.react-flow__resize-control', (n) => n.length)
check('cards offer drag handles on their edges', handles > 0, `${handles} controls`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
