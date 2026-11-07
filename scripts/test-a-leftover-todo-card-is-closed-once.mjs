/**
 * A To Do card left on a tab from before the goal ring is closed the first time the tab is shown, and
 * one opened on purpose afterwards stays open. Canon 26. The file is never touched.
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const LIST = '# Plan\n\n## First\n- [x] A\n\n## Second\n- [ ] B\n'
const board = await openBoard({ cards: [{ title: 'Boss', roleClass: 'orchestrator' }], files: { 'TODO.md': LIST } })
const projectId = board.cards[0].projectId
board.ws.send(JSON.stringify({ t: 'doc.open', projectId, relPath: 'TODO.md' }))
await sleep(800)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const cards = () => page.$$eval('.react-flow__node-doc', (n) => n.length)
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)
check('the old card is gone from the tab', (await cards()) === 0, String(await cards()))
check('the ring is drawn instead', !!(await page.$('.goal-ring__open')))
check('the file is untouched', readFileSync(join(board.dir, 'TODO.md'), 'utf8') === LIST)

board.ws.send(JSON.stringify({ t: 'doc.open', projectId, relPath: 'TODO.md' }))
await sleep(1200)
check('one opened on purpose stays', (await cards()) === 1, String(await cards()))
await page.reload({ waitUntil: 'networkidle2' })
await sleep(2500)
check('and survives a reload', (await cards()) === 1, String(await cards()))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
