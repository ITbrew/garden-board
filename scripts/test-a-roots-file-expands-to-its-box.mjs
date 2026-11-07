/**
 * The expand button on a file in a card's roots opens it to fill the roots box, so it can be read.
 * Canon 04. The owner: "when i press expand for roots it should open to the size of the border so its
 * readable". It used to do nothing visible, because a file in a web always drew at its stored size.
 *
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const shots = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: [{ title: 'Boss', roleClass: 'orchestrator' }] })
const card = board.cards[0]
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1900, height: 1100 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

board.ws.send(JSON.stringify({ t: 'context.open', sessionId: card.id, group: 'instructions' }))
await sleep(1500)
board.ws.send(JSON.stringify({ t: 'context.open', sessionId: card.id, group: 'memory' }))
await sleep(2500)

const look = () => page.evaluate(() => {
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  const zoom = Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport').style.transform)?.[1] ?? 1)
  const docs = [...document.querySelectorAll('.react-flow__node-doc')]
  const biggest = docs.map((n) => box(n)).sort((a, b) => b.w * b.h - a.w * a.h)[0]
  return { zoom, count: docs.length, frame: box(document.querySelector('.webframe') ?? document.querySelector('.react-flow__node-webFrame')), biggest, handles: document.querySelectorAll('.react-flow__node-doc.selected .card-resize-handle').length, first: box(docs[0]) }
})
const press = (title) => page.evaluate((title) => {
  const b = [...document.querySelectorAll('.react-flow__node-doc button')].find((n) => (n.getAttribute('title') ?? '').startsWith(title))
  b?.click()
  return !!b
}, title)

const before = await look()
check('the roots box opened with files in it', before.count >= 2 && !!before.frame, JSON.stringify(before))
check('the button says what it will do', await press('Fill the box'))
await sleep(1200)
const open = await look()
check('the file fills the box', open.biggest.w >= before.frame.w - 80 && open.biggest.h >= before.frame.h - 110, JSON.stringify([open.biggest, before.frame]))
check('and stays inside it', open.biggest.x >= open.frame.x - 1 && open.biggest.y >= open.frame.y - 1 && open.biggest.x + open.biggest.w <= open.frame.x + open.frame.w + 1 && open.biggest.y + open.biggest.h <= open.frame.y + open.frame.h + 1, JSON.stringify([open.biggest, open.frame]))
check('at least a large card', open.biggest.w / open.zoom >= 700, String(open.biggest.w / open.zoom))
check('the other files keep their places', open.count === before.count, String(open.count))
if (shots) await page.screenshot({ path: join(shots, 'roots-open.png') })

check('pressing again offers the way back', await press('Back to its own size'))
await sleep(1200)
const back = await look()
check('it goes back to its own size', Math.abs(back.first.w - before.first.w) < 2 && Math.abs(back.first.h - before.first.h) < 2, JSON.stringify([back.first, before.first]))
check('and the box does not move', Math.abs(back.frame.x - before.frame.x) < 2 && Math.abs(back.frame.y - before.frame.y) < 2 && Math.abs(back.frame.w - before.frame.w) < 2, JSON.stringify([back.frame, before.frame]))
check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
