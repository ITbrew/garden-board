/**
 * The model and effort controls on a card can be found and opened.
 *
 * The failure this catches: both controls have existed for a while, three rows down inside the
 * powers panel, which is folded by default behind a caret about ten pixels wide. Beside it sat a
 * summary line printing the model and effort as plain text, and clicking that text did nothing at
 * all. The owner reported that there was no way to change a card's model. He was wrong about the
 * feature and right about the experience, which is the only part he can see.
 *
 * So the assertion is not that the picker exists. It is that clicking the words a person would
 * click, the summary, opens the panel. Run this against the previous build and the second check
 * fails: the strip was a plain div and only the caret was a button.
 *
 * A `claude` card rather than a shell one, because a shell has no model, no effort and no hiring
 * cap and is deliberately given no strip at all. It stays switched off: the strip is drawn from
 * stored settings, so proving this needs no process and should not spend one.
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

const board = await openBoard({ projectName: 'powers' })
board.ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: board.project.id,
    adapterId: 'claude',
    title: 'Planner',
    roleClass: 'manager',
    start: false,
  }),
)
await sleep(2000)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})

try {
  const page = await browser.newPage()
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.node-powers', { timeout: 20000 })
  await sleep(1500)

  const summary = await page.$eval('.node-powers__summary', (el) => el.textContent ?? '')
  check('the card summarises what it is running', summary.trim() !== '', `reads "${summary.trim()}"`)

  const hint = await page.$('.node-powers__hint')
  check('and says it can be changed', hint !== null, hint ? '' : 'no affordance beside the summary')

  // The panel must be shut to start with, or this proves nothing about finding it.
  const bodyBefore = await page.$('.node-powers__body')
  check('the settings start folded away', bodyBefore === null)

  // The shot for the discoverability review, taken while folded, which is the state the owner
  // actually looks at.
  await page.screenshot({ path: 'docs/shots/09-card-powers-folded.png' })
  console.log('shot: docs/shots/09-card-powers-folded.png')

  /*
   * Click the WORDS, not the caret. That is the whole point: a person reads "default model" and
   * clicks it, and before this change that click landed on a div and did nothing.
   */
  const words = await page.$('.node-powers__summary')
  const wb = await words.boundingBox()
  await page.mouse.click(wb.x + wb.width / 2, wb.y + wb.height / 2)
  await sleep(800)

  const bodyAfter = await page.$('.node-powers__body')
  check('clicking the summary opens the settings', bodyAfter !== null)

  const selects = await page.$$eval('.node-powers__body select', (els) => els.length)
  check('and the model and effort pickers are in there', selects >= 2, `${selects} pickers`)

  await page.screenshot({ path: 'docs/shots/10-card-powers-open.png' })
  console.log('shot: docs/shots/10-card-powers-open.png')

  // The card must still drag: the strip is inside the node and is now a full-width button.
  const before = await page.$eval('.react-flow__node', (el) => el.style.transform)
  const nb = await (await page.$('.react-flow__node')).boundingBox()
  await page.mouse.move(nb.x + nb.width / 2, nb.y + 10)
  await page.mouse.down()
  await page.mouse.move(nb.x + nb.width / 2 + 80, nb.y + 60, { steps: 10 })
  await page.mouse.up()
  await sleep(1200)
  const after = await page.$eval('.react-flow__node', (el) => el.style.transform)
  check('the card is still draggable', after !== before, `${before} -> ${after}`)
} finally {
  await browser.close()
  await board.stop()
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
