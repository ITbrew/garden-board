/**
 * Three shots of the Loops rail: open, one loop folded, and the whole section folded.
 *
 * `test-rail-lists-model-and-effort.mjs` proves the folds hide and restore the right elements and
 * that the state survives a reload. That is not an eye. What it cannot answer is whether a person
 * looking at the rail can tell a folded loop from a stopped one, whether the shut section says
 * enough to be worth leaving shut, and whether the two fold controls read as the same idea.
 *
 * Its own Garden, its own port, its own workspace, serving the BUILT app, so run `npm run build`
 * first or this is a picture of the previous bundle.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots', 'loop-folds')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({
  projectName: 'loopfolds',
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Worker one', roleClass: 'worker' },
    { title: 'Worker two', roleClass: 'worker' },
  ],
})
const [orchestrator, one, two] = board.cards
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: orchestrator.id }))
await sleep(2500)

// Three loops in different states, since a shot where every row is identical cannot show whether
// the differences read: one running with a real prompt, one stopped, one never started.
const setLoop = (card, prompt, minutes, enabled) =>
  board.ws.send(JSON.stringify({ t: 'loop.set', projectId: board.project.id, loop: { sessionId: card.id, prompt, minutes, enabled } }))
setLoop(orchestrator, 'Check in: read your to-do list in TODO.md, do the next item addressed to you, tick it, and switch this loop off when nothing of yours is left.', 15, true)
await sleep(900)
setLoop(one, 'Check the build and report anything that failed.', 30, false)
await sleep(900)
setLoop(two, 'Sweep the inbox and answer anything older than an hour.', 60, false)
await sleep(1200)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1900, height: 1300, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const shootRail = async (name) => {
  const rail = await page.$('.rail')
  if (rail) await rail.screenshot({ path: join(OUT, name) })
}
await shootRail('1-open.png')

await page.evaluate(() => document.querySelector('.rail-loop__fold')?.click())
await sleep(500)
await shootRail('2-one-loop-folded.png')

await page.evaluate(() => document.querySelector('.rail-title--fold .twisty')?.click())
await sleep(500)
await shootRail('3-section-folded.png')

console.log(`shots in ${OUT}`)
await browser.close()
await board.stop()
