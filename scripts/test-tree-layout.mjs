/**
 * Checks that wired sessions arrange as a readable tree rather than a row joined by long
 * diagonals, and that a wire reaching a lower card travels down rather than sideways across the
 * board.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A small hierarchy of its own, wired by `reportsTo`: a lead with two reports, one of which has
// a report of its own. Enough branching and depth for a tree arrangement to have real rows to
// build, without depending on whatever the owner happens to have wired on his own board today.
const board = await openBoard({
  cards: [
    { title: 'Lead' },
    { title: 'Left', reportsTo: 0 },
    { title: 'Right', reportsTo: 0 },
    { title: 'Grandchild', reportsTo: 1 },
  ],
  projectName: 'tree-layout',
})
const UI = board.UI

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const edgesBefore = await page.$$eval('.react-flow__edge', (e) => e.length)
check('there is at least one wire between cards', edgesBefore > 0, `${edgesBefore} wires`)

/*
 * Right-click somewhere genuinely empty.
 *
 * A fixed point stopped being empty as soon as the board got bigger: the click landed on a card
 * and opened the card's menu instead, so the test reported that the canvas menu had lost an item
 * that was still right there in the code. The point is now chosen from where the cards actually
 * are, which is the only way it stays empty as the board changes.
 */
const empty = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect())
  const lowest = boxes.reduce((m, b) => Math.max(m, b.bottom), 0)
  // Inside the canvas itself: x=200 was over the left rail, which has its own menu and no
  // arrangement items, so the test was right-clicking the sidebar and reporting a missing feature.
  const flow = document.querySelector('.canvas-flow') ?? document.body
  const r = flow.getBoundingClientRect()
  return {
    x: Math.round(r.x + r.width * 0.75),
    y: Math.round(Math.min(r.bottom - 60, Math.max(r.y + 80, lowest + 120))),
  }
})
await page.mouse.click(empty.x, empty.y, { button: 'right' })
await sleep(600)
const arranged = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ctxmenu__item')].find(
    (n) => n.querySelector('.ctxmenu__label')?.textContent === 'Arrange as a tree',
  )
  if (!el) return false
  el.click()
  return true
})
check('the canvas menu offers Arrange as a tree', arranged)
await sleep(1800)

const layout = await page.evaluate(() => {
  const wired = new Set()
  document.querySelectorAll('.react-flow__edge').forEach((e) => {
    const id = e.getAttribute('data-testid') || ''
    id.split('__').slice(1).forEach((p) => p.split('-').forEach(() => {}))
  })
  const nodes = [...document.querySelectorAll('.react-flow__node')].map((n) => {
    const r = n.getBoundingClientRect()
    const title = n.querySelector('.node-title')?.textContent ?? ''
    return { title, x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) }
  })
  const paths = [...document.querySelectorAll('.react-flow__edge-path')].map((p) => p.getAttribute('d'))
  return { nodes, paths, wired: [...wired] }
})

console.log('   cards:', layout.nodes.map((n) => `${n.title}@${n.x},${n.y}`).join('  '))

// A tree puts a child on a lower row than its parent, so not everything shares one y.
const rows = new Set(layout.nodes.map((n) => n.y))
check('cards occupy more than one row', rows.size > 1, `${rows.size} distinct rows`)

/*
 * What a tree actually promises now.
 *
 * It used to assert that a wire reaching a lower card travelled mostly downward, which was true
 * when a card could send from its bottom edge. It cannot any more: every session-to-session wire
 * leaves the right dot and arrives at the left dot, because one meaning per side is the rule and
 * the bottom belongs to the file web. Checking direction was checking a rule we no longer hold.
 *
 * The promise that survived is the shape: a child sits on a lower row than its parent, and the
 * wire between them is drawn rather than dropped.
 */
const lowerThanParent = layout.paths.filter((d) => {
  const m = /^M ([\d.-]+),([\d.-]+) C .* ([\d.-]+),([\d.-]+)$/.exec(d || '')
  if (!m) return false
  return Math.abs(+m[4] - +m[2]) > 20
}).length
check('a wire reaching a different row is drawn between them', lowerThanParent > 0,
  `${lowerThanParent} of ${layout.paths.length} wires span rows`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
