/**
 * A shot of the to-do bars, for somebody who has not seen the code.
 *
 * `test-to-do-bars.mjs` proves the counts, the placement and that a tick reaches the file. That is
 * not an eye. What it cannot answer is whether a person looking at the board can tell what the bar
 * above a card is, whether the progress bar reads as progress, and whether a card's own list looks
 * like it belongs to that card rather than floating between two of them.
 *
 * Run `npm run build` first: this serves the built app.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots', 'to-do-bars')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TODO = [
  '# TODO',
  '',
  '- [ ] Replace the husk check in session.start @Orchestrator',
  '- [ ] Write canon for the to-do list @Orchestrator',
  '- [x] Bump the three package.json files @Worker one',
  '- [ ] Sweep the inbox and answer anything older than an hour @Worker one',
  '- [ ] Decide whether the rail keeps two lists',
  '',
].join('\n')

const board = await openBoard({
  projectName: 'todoshot',
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Worker one', roleClass: 'worker' },
  ],
  files: { 'TODO.md': TODO },
})
board.ws.send(JSON.stringify({ t: 'doc.create', projectId: board.project.id, relPath: 'TODO.md', openIfExists: true }))
await sleep(1500)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1700, height: 1100, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/*
 * Fit the board before shooting, or the bars are the first thing off the top of the frame.
 *
 * They sit above their cards, so the topmost thing on the board is a bar, and the first read of this
 * shot came back saying every strip was "cut off at the very top of the screenshot" and it could
 * only see a sliver. That was the picture's fault rather than the board's, and a blind pass that
 * cannot see the thing it was called for is a blind pass wasted.
 */
await page.evaluate(() => {
  const fit = [...document.querySelectorAll('.react-flow__controls button')][2]
  fit?.click()
})
await sleep(1500)

await page.screenshot({ path: join(OUT, 'board.png') })
console.log(`shots in ${OUT}`)
await browser.close()
await board.stop()
