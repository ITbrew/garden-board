/**
 * Screenshots for a blind review of two things a person looks at and nothing measures.
 *
 * The getting-started panel and the rail's fold button are both changes to what is on screen, and
 * the rule this project follows is that such a change gets a reader who sees only the picture. An
 * assertion can prove the panel is in the DOM and that the button is not under the resize line. It
 * cannot say whether a newcomer reading the panel would know what to do, or whether the folded rail
 * looks broken rather than folded, and those are the two questions worth asking here.
 *
 * Four frames, and each one exists to catch a specific failure:
 *
 *   01 is the panel on a board with one card, with the first step open. This is what a first-time
 *      user actually sees. The failure it looks for is a panel that reads as a feature list.
 *
 *   02 is the same panel after the board's own menu has been opened, so two steps are ticked and a
 *      later one is open. The failure it looks for is a panel that does not visibly move on, which
 *      would make the whole tick-from-real-state design invisible.
 *
 *   03 is the rail with its fold button in the corner. The failure it looks for is a control that
 *      does not read as a control, which is the complaint that started this.
 *
 *   04 is the rail folded to nothing, with only the tab against the window edge. The failure it
 *      looks for is the worst one available: a folded rail with no visible way back, which is what
 *      the tab exists to prevent.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board. Run `npm run build` first or these are shots of an old bundle.
 *
 *   npm run build
 *   node scripts/capture-firstrun-blind.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots', 'firstrun-blind')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 1600
const HEIGHT = 1000

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({ projectName: 'firstrun', cards: [{ title: 'Alpha' }] })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.stack || String(e)))

await page.goto(`http://127.0.0.1:${board.port}/`, { waitUntil: 'networkidle0' })
await sleep(1800)

/*
 * The panel has to actually be there before anything is photographed.
 *
 * A capture script that shoots whatever is on screen and reports success is how a set of confident
 * screenshots of the wrong thing gets made. This one has already happened on this project: a shot
 * was taken of a mark whose natural width was zero and the number was explained away rather than
 * treated as the failure it was.
 */
const present = await page.$('.firstrun')
if (!present) {
  console.log('ABORT: the getting-started panel is not on the page at all')
  await browser.close()
  await board.stop()
  process.exit(1)
}

const openStep = await page.$eval('.firstrun__step.is-next .firstrun__title', (el) => el.textContent)
console.log(`the open step is "${openStep}"`)

await page.screenshot({ path: join(OUT, '01-panel-first-step.png') })

/*
 * Right-click the canvas, which is the real gesture the first step describes, then press escape so
 * the menu itself is not what fills the frame. The step ticks on the menu opening, so it stays
 * ticked after the escape, which is the behaviour canon 23 asks for and is worth seeing.
 */
const canvas = await page.$('.react-flow__pane')
const box = await canvas.boundingBox()
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6, { button: 'right' })
await sleep(400)
await page.keyboard.press('Escape')
await sleep(400)

const ticked = await page.$$eval('.firstrun__step.is-done', (els) => els.length)
console.log(`${ticked} steps are ticked after opening the board's menu`)
if (ticked < 2) {
  console.log('ABORT: opening the board menu on a board that already has a card should tick two')
  await browser.close()
  await board.stop()
  process.exit(1)
}

await page.screenshot({ path: join(OUT, '02-panel-moved-on.png') })

// The rail on its own, so the fold button is judged as a control rather than lost in a whole window.
const rail = await page.$('.rail')
await rail.screenshot({ path: join(OUT, '03-rail-with-fold.png') })

const foldBox = await (await page.$('.rail-fold')).boundingBox()
const railBox = await rail.boundingBox()
console.log(
  `fold button ${Math.round(foldBox.width)}x${Math.round(foldBox.height)} at ` +
    `${Math.round(foldBox.x)},${Math.round(foldBox.y)}; rail right edge ${Math.round(railBox.x + railBox.width)}`,
)

await page.click('.rail-fold')
await sleep(600)

const tab = await page.$('.rail-unfold')
if (!tab) {
  console.log('ABORT: the rail folded and left no way to open it again')
  await browser.close()
  await board.stop()
  process.exit(1)
}
const tabBox = await tab.boundingBox()
if (!tabBox || tabBox.width < 4 || tabBox.height < 4) {
  console.log(`ABORT: the tab back is ${JSON.stringify(tabBox)}, which nobody can press`)
  await browser.close()
  await board.stop()
  process.exit(1)
}
console.log(`the tab back is ${Math.round(tabBox.width)}x${Math.round(tabBox.height)} at ${Math.round(tabBox.x)},${Math.round(tabBox.y)}`)

await page.screenshot({ path: join(OUT, '04-rail-folded.png') })

if (errors.length) console.log(`console errors during the run:\n${errors.join('\n')}`)
console.log(`shots in ${OUT}`)

await browser.close()
await board.stop()
