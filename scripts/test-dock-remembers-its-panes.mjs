/**
 * Proves a reload gives the owner back the terminals he had open.
 *
 * The failure, in his words: a terminal "keeps disappearing from workspace", and "the garden view
 * needed refresh then it was gone". Nothing had gone. Which panes are open was held in memory and
 * written down nowhere, so a reload arrived with an empty dock while every card stayed exactly where
 * it was. That is worse than a visibly broken thing, because the board looks correct.
 *
 * Checked through the browser rather than against the store, because the whole bug lives in the
 * browser: the server was always right about this and was never asked.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Alpha', 'Beta'] })
for (const c of board.cards) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(3000)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

/** Open a pane the way he does, from the sidebar's list of running cards. */
const openPane = (title) =>
  page.evaluate((t) => {
    const row = [...document.querySelectorAll('.row')].find(
      (r) => r.querySelector('.row-label')?.textContent?.trim() === t,
    )
    row?.click()
    return !!row
  }, title)

const panes = () => page.evaluate(() => document.querySelectorAll('.dock-pane').length)

check('the dock starts empty', (await panes()) === 0)
await openPane('Alpha')
await sleep(1500)
await openPane('Beta')
await sleep(2000)
const opened = await panes()
check('two terminals can be opened', opened === 2, `${opened} panes`)

await page.reload({ waitUntil: 'networkidle2' })
await sleep(4000)
const after = await panes()
check(
  'and they are still there after a reload',
  after === 2,
  after === 2 ? 'both came back' : `${after} panes came back, the rest were forgotten`,
)

/*
 * And the pane cap says something when it takes one away. Four is the ceiling, so a fifth card
 * cannot be tested with two; what is checked here is that closing one is remembered too, which is
 * the same store and the same failure if it is not written.
 */
await page.evaluate(() => {
  const close = [...document.querySelectorAll('.dock-pane button')].find((b) =>
    /close/i.test(b.getAttribute('title') ?? b.textContent ?? ''),
  )
  close?.click()
})
await sleep(1500)
const closed = await panes()
await page.reload({ waitUntil: 'networkidle2' })
await sleep(4000)
const afterClose = await panes()
check(
  'closing one is remembered as well as opening one',
  afterClose === closed,
  `${closed} open before the reload, ${afterClose} after`,
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
