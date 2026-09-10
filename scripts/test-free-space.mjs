/**
 * Proves a context web unfolds into genuinely empty canvas rather than landing on existing cards.
 * The canvas is infinite, so overlapping is never necessary.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A few cards, so there is something to collide with.
const board = await openBoard({ cards: ['A', 'B', 'C'], projectName: 'free-space' })
const UI = board.UI
const st = board.state
const project = board.project
const owner = board.cards[0]

/*
 * Open the UI first and let it settle.
 *
 * Auto-packed cards are positioned by the renderer, and the server only learns those positions
 * when a client reports them. Asking for a web with no client attached placed it against stale
 * coordinates, which is exactly the overlap this test exists to catch.
 */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

// Re-read state after the client has reported where it actually drew the cards, or this
// compares the new web against coordinates that were never on screen.
board.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(1200)

board.ws.send(JSON.stringify({ t: 'context.open', sessionId: owner.id }))
await sleep(3000)
board.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(1200)

const mine = st.sessions.filter((s) => s.projectId === project.id)
const web = st.docs.filter((d) => d.ownerId === owner.id)
check('the web opened', web.length > 5, `${web.length} cards`)

// packages/shared/src/index.ts's BOARD.COLLAPSED_H: what a collapsed card really draws.
const H = (c) => (c.collapsed ? 52 : c.height)
const others = [
  ...mine.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: H(s) })),
  // Only this project's cards: boards do not share a screen, so a card in another project
  // sitting at the same coordinates is not an overlap. Comparing across projects is what made
  // this test report four phantom collisions.
  ...st.docs
    .filter((d) => d.projectId === project.id && d.ownerId !== owner.id)
    .map((d) => ({ id: d.id, x: d.x, y: d.y, w: d.width, h: H(d) })),
]

let collisions = 0
for (const c of web) {
  const a = { x: c.x, y: c.y, w: c.width, h: H(c) }
  for (const o of others) {
    const hit = a.x < o.x + o.w && a.x + a.w > o.x && a.y < o.y + o.h && a.y + a.h > o.y
    if (hit) collisions++
  }
}
check('no web card overlaps an existing card', collisions === 0, `${collisions} overlaps`)

const lowestExisting = Math.max(...others.map((o) => o.y + o.h))
const webTop = Math.min(...web.map((c) => c.y))
check('the web sits clear of the existing board', webTop > lowestExisting,
  `web top ${Math.round(webTop)} vs lowest card ${Math.round(lowestExisting)}`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
