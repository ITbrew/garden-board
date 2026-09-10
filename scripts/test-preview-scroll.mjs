/**
 * A card's terminal miniature can be scrolled back through, and says when it is not live.
 *
 * The failure this catches, in the form it had before the change: the miniature read only the last
 * screen's worth of the session's buffer, `getPreviewSpans` had no notion of an offset, and there
 * was no wheel handler on the pane at all. So a wheel over a card scrolled nothing, and everything
 * the session had said before the last screen was reachable only by opening the dock. Run this
 * against that build and the first assertion below fails: the top row of the pane does not change.
 *
 * It starts a real shell and makes it print numbered lines, rather than feeding the preview by
 * hand, because the thing under test is the interpretation of a real byte stream. A text fixture
 * would pass on the naive strip-the-escapes implementation this pane is specifically not allowed
 * to have.
 *
 * Its own Garden on its own port, never the owner's board. Needs `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ projectName: 'scroll', cards: [{ title: 'Chatty' }] })
const card = board.cards[0]

// A real process, and enough output that the pane cannot hold it all: the point of scrolling is
// what is off the top.
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(6000)
board.ws.send(
  JSON.stringify({
    t: 'session.input',
    sessionId: card.id,
    data: '1..120 | ForEach-Object { "line $_ of the scrollback" }\r',
  }),
)
await sleep(6000)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})

try {
  const page = await browser.newPage()
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.mini', { timeout: 20000 })
  await sleep(3000)

  /** The pane's top row, which is what moves when the window into the buffer moves. */
  const topRow = () => page.$eval('.mini .mini-row', (el) => el.textContent ?? '')
  const rowCount = () => page.$$eval('.mini .mini-row', (els) => els.length)

  const before = await topRow()
  const rows = await rowCount()
  check('the pane drew some rows', rows > 0, `${rows} rows, top reads "${before.trim()}"`)

  const bar = await page.$('.mini-scroll')
  check('a scrollbar is drawn when there is more than a screenful', bar !== null)

  // Wheel up over the pane. The card's own ctrl+wheel font gesture must not be involved, so no
  // modifier here; that separation is the thing most likely to break.
  const mini = await page.$('.mini')
  const box = await mini.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel({ deltaY: -400 })
  await sleep(800)

  const after = await topRow()
  check(
    'wheeling up moves the window back through the buffer',
    after !== before,
    after !== before ? `"${before.trim()}" -> "${after.trim()}"` : `top row stayed "${before.trim()}"`,
  )

  /*
   * Exactly one row fewer while scrolled, and that is the design rather than a tolerance.
   *
   * The notice saying the pane is held used to be drawn on top of the bottom line, and a blind
   * reviewer read that line as "line 118 of the scrol..." with the label over the rest of it. The
   * row is now given up to the notice, so nothing is obscured and the pane's height is unchanged,
   * which is why this asserts the exact number rather than "still whole rows".
   */
  const rowsAfter = await rowCount()
  check(
    'the pane gives up exactly one row to the notice, and no more',
    rowsAfter === rows - 1,
    `${rows} then ${rowsAfter}`,
  )

  // Caught here, while the pane is still held above the live end, because this is the state a
  // reviewer needs to see and it does not exist by the end of the run.
  await page.screenshot({ path: 'docs/shots/08-preview-scrolled.png' })
  console.log('shot: docs/shots/08-preview-scrolled.png')

  // Scrolled back is a state the owner must be able to see, or a held pane reads as a dead session.
  const follow = await page.$('.mini-follow')
  check('a scrolled pane says so', follow !== null)

  if (follow) {
    await follow.click()
    await sleep(800)
    const back = await topRow()
    check(
      'and clicking it returns to the live end',
      back === before,
      back === before ? '' : `expected "${before.trim()}", got "${back.trim()}"`,
    )
  }

  // The card must still be draggable after all that: the pane sits inside the node, and a pointer
  // handler that swallowed the gesture would strand every card it is drawn on.
  const node = await page.$('.react-flow__node')
  const nodeBefore = await page.$eval('.react-flow__node', (el) => el.style.transform)
  const nb = await node.boundingBox()
  await page.mouse.move(nb.x + nb.width / 2, nb.y + 10)
  await page.mouse.down()
  await page.mouse.move(nb.x + nb.width / 2 + 90, nb.y + 70, { steps: 10 })
  await page.mouse.up()
  await sleep(1200)
  const nodeAfter = await page.$eval('.react-flow__node', (el) => el.style.transform)
  check('the card is still draggable', nodeAfter !== nodeBefore, `${nodeBefore} -> ${nodeAfter}`)

  await page.screenshot({ path: 'docs/shots/07-preview-scroll.png' })
  console.log('shot: docs/shots/07-preview-scroll.png')
} finally {
  await browser.close()
  await board.stop()
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
