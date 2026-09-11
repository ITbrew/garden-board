/**
 * A shot of the rail's two lists, for somebody who has not seen the code.
 *
 * `test-rail-lists-model-and-effort.mjs` proves the rows carry the right strings and that no card is
 * in both lists. That is not an eye. What it cannot answer is whether a person reading the rail can
 * tell the two sections apart, whether the second line reads as belonging to the card above it, and
 * whether a list of cards with the same model looks like information or like repetition.
 *
 * Its own Garden, its own port, its own workspace, serving the BUILT app, so run `npm run build`
 * first or this is a picture of the previous bundle.
 *
 *   npm run build
 *   node scripts/capture-rail-lists.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots', 'rail-lists')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A board with something in every state the rail can draw, because a shot where every row looks the
 * same cannot show whether the differences read.
 */
const board = await openBoard({
  projectName: 'raillists',
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Worker one', roleClass: 'worker', reportsTo: 0 },
    { title: 'Worker two', roleClass: 'worker', reportsTo: 0 },
    { title: 'Reviewer', roleClass: 'worker' },
    { title: 'Long name that will not fit in the rail at all', roleClass: 'worker' },
  ],
})

const [orchestrator, workerOne, workerTwo, reviewer, longName] = board.cards
const choose = (id, modelChoice, effortChoice) =>
  board.ws.send(JSON.stringify({ t: 'session.setRole', sessionId: id, modelChoice, effortChoice }))

choose(orchestrator.id, 'opus-5', 'high')
choose(workerOne.id, 'sonnet-5', 'medium')
choose(longName.id, 'haiku-4-5', 'low')
// Reviewer and Worker two are left untold, so the shot carries a "default model" row as well.
await sleep(600)

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: orchestrator.id }))
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: workerOne.id }))
await sleep(3000)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1900, height: 1300, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

await page.screenshot({ path: join(OUT, 'board.png') })

const rail = await page.$('.rail')
if (rail) await rail.screenshot({ path: join(OUT, 'rail.png') })

console.log(`shots in ${OUT}`)
await browser.close()
await board.stop()
