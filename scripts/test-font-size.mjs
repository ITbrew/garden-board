/**
 * Ctrl and the wheel inside a card changes that card's text size, including its terminal
 * miniature, and the change is stored rather than being a local trick of the render.
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

const title = `FontTest ${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: [title], projectName: 'font-size' })
const UI = board.UI
const target = board.cards[0]
check('created a card to test on', !!target, title)
if (!target) {
  await board.stop()
  process.exit(1)
}

// This instance's own database, in its own home directory, never ~/.garden: the card being
// measured here only exists on this board, so reading the owner's real database found nothing.
const DB = join(board.home, 'garden.db')
const fontOf = (id) => {
  const d = new Database(DB, { readonly: true })
  try {
    return d.prepare('SELECT fontSize FROM sessions WHERE id = ?').get(id)?.fontSize ?? null
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

const readMiniFont = () =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.react-flow__node')].find(
      (n) => n.querySelector('.node-title')?.textContent === t,
    )
    const mini = node?.querySelector('.mini')
    return mini ? parseFloat(getComputedStyle(mini).fontSize) : null
  }, title)

const before = await readMiniFont()
check('the terminal miniature has a font size', !!before, `${before}px`)

// Ctrl and the wheel, up, inside the card.
const box = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.react-flow__node')].find(
    (n) => n.querySelector('.node-title')?.textContent === t,
  )
  const r = node.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}, title)

await page.mouse.move(box.x, box.y)
for (let i = 0; i < 3; i++) {
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -120 })
  await page.keyboard.up('Control')
  await sleep(350)
}
await sleep(1200)

const after = await readMiniFont()
check('the miniature text grew', after > before, `${before}px -> ${after}px`)
check('the new size was stored', fontOf(target.id) !== null, `stored ${fontOf(target.id)}px`)

const stored = fontOf(target.id)
for (let i = 0; i < 2; i++) {
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: 120 })
  await page.keyboard.up('Control')
  await sleep(350)
}
await sleep(1200)
check('scrolling back down shrinks it again', fontOf(target.id) < stored,
  `${stored}px -> ${fontOf(target.id)}px`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
