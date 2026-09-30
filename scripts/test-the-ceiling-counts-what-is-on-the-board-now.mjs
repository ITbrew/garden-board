/**
 * The ceiling panel's counts move when the board moves, and they say which board they counted.
 *
 * The owner, on 2026-09-29, looking at a header that said one card was running and a ceiling
 * directly underneath it that said `0 of 5`: "fix the cieling section of garden as well, im not
 * sure if those controls are working or do anyhting. make sure those settings are per tab, not
 * entire garden".
 *
 * Nothing was broken and nothing said so, which is how a live control comes to look dead. The
 * counts arrived from the server as a snapshot, and the panel asked for a fresh one on two
 * triggers: the board changing, and the number of open cards on it changing. A card going from idle
 * to working is neither, so the figure sat at whatever it was when the card was made. They are
 * measured in the panel now, from the cards the tab already holds, through the same two functions
 * in `@garden/shared` that `store.countCards` and `store.countRunning` spell out in SQL.
 *
 * So there are two things to hold, and this drives his path for both. **A card starting work moves
 * the running figure**, with no card created or closed to trigger a refresh, which is the exact
 * shape that failed. And **the heading names the board**, because the separation was real the whole
 * time and he still had to ask: three numbers sat on one screen counting three different
 * populations, and none of them said which.
 *
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Alpha', 'Beta', 'Gamma'], projectName: 'ceiling' })
/*
 * The harness names its project after the temporary directory it made, so the expected name is read
 * off the board rather than written here. An assertion against a literal would pass only while the
 * harness happened to agree with it, which is a test of the harness.
 */
const NAME = board.project.name

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/** One row of the ceiling, read the way the owner reads it: a label, the line under it, and the box. */
const readCeiling = () =>
  page.evaluate(() => {
    const section = [...document.querySelectorAll('.rail-section')].find((s) =>
      s.querySelector('.rail-title')?.textContent?.startsWith('Ceiling'),
    )
    if (!section) return null
    return {
      heading: section.querySelector('.rail-title')?.textContent?.trim() ?? '',
      board: section.querySelector('.rail-title__of')?.textContent?.trim() ?? null,
      rows: [...section.querySelectorAll('.rail-limit-row')].map((r) => ({
        label: r.querySelector('.rail-limit-row__label')?.childNodes[0]?.textContent?.trim() ?? '',
        under: r.querySelector('.rail-limit-row__label em')?.textContent?.trim() ?? '',
        value: r.querySelector('input')?.value ?? r.querySelector('select')?.value ?? '',
      })),
    }
  })

const before = await readCeiling()
check('the ceiling section is on screen', !!before && before.rows.length >= 5, `${before?.rows.length ?? 0} rows`)

/*
 * The heading names the board. This is the whole of "per tab, not entire garden": the ceilings are
 * stored and enforced per project and always were, and nothing on the control said so.
 */
check('the heading names the board it counted', before?.board === NAME, `heading "${before?.heading}", board is "${NAME}"`)

const cardsRow = before?.rows.find((r) => r.label === 'Agent cards')
const runningRow = before?.rows.find((r) => r.label === 'Agent cards running at once')
check('the card count is the three cards on this board', cardsRow?.under === `3 of ${cardsRow?.value}`, cardsRow?.under)
check('nothing is running yet', runningRow?.under === `0 of ${runningRow?.value}`, runningRow?.under)

/*
 * The row that matters, and the one the owner was looking at. A card is STARTED, not created and
 * not closed, so nothing the old code listened for has changed. The figure has to move anyway.
 */
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: board.cards[0].id }))
await sleep(5000)

const after = await readCeiling()
const runningAfter = after?.rows.find((r) => r.label === 'Agent cards running at once')
check(
  'starting a card moves the running figure, with no card created or closed',
  runningAfter?.under === `1 of ${runningAfter?.value}`,
  `was "${runningRow?.under}", now "${runningAfter?.under}"`,
)
check(
  'the card count did not move, because no card was made',
  after?.rows.find((r) => r.label === 'Agent cards')?.under === cardsRow?.under,
)

/*
 * And back down again. A figure that only ever climbs is a counter, not a measurement, and the
 * failure being fixed here would have passed a one-directional check.
 */
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: board.cards[0].id }))
await sleep(5000)
const ended = await readCeiling()
const runningEnded = ended?.rows.find((r) => r.label === 'Agent cards running at once')
check(
  'stopping it moves the figure back',
  runningEnded?.under === `0 of ${runningEnded?.value}`,
  runningEnded?.under,
)

/*
 * The subagent permission's unit line names the board too. It used to read "everywhere on this
 * board", which is the sentence that made the owner ask whether these were the whole app's.
 */
const allowed = ended?.rows.find((r) => r.label === 'Subagents allowed')
check('the subagent permission names the board it governs', allowed?.under === `every card on ${NAME}`, allowed?.under)

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
