/**
 * The history and roots buttons receive their own presses, and folding away really folds away.
 *
 * Three reports from the owner on 2026-09-09, which turned out to be one fault and one other:
 *
 *   "history/roots buttons are too hard to hit and blended too closely into the cards instead of
 *    being pushable button"
 *   "the history button overlaps the border of the card as well so when i try to collapse it, it
 *    resizes the card instead of collapsing histroy"
 *   "the history is non collaposible currently"
 *
 * The first two are the same thing. The buttons straddled the card's edge, and the card's resize
 * line runs along that edge, so a press near the middle of the button landed on the resizer. The
 * control was not merely small, it did something else instead, which is why it read as unhittable
 * rather than as fiddly.
 *
 * The third is separate. History opens in two steps: the first press asks for the days and draws
 * pills rather than cards. The set that decides whether the arrow reads "open" counted only cards,
 * so it stayed empty, the arrow kept saying "History", and the second press asked for the days
 * again. Nothing folded, ever.
 *
 * So the checks here are geometric and behavioural rather than about appearance. What is on top at
 * a point is a fact the browser will answer; whether a button looks pressable is not, and this file
 * does not pretend to judge it.
 *
 *   npm run build
 *   node scripts/test-web-buttons-are-hittable.mjs
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ projectName: 'hittable', cards: [{ title: 'Subject' }] })
const card = board.cards[0]

/*
 * Give the card a turn that actually changed a file, so it has a day to show.
 *
 * Without this the card has no history, the first press draws no day pills, and every assertion
 * about the pills leaving the board passes whether or not folding works. That is exactly what the
 * first version of this file did, and the run against the pre-fix build is what exposed it: the
 * pill check was green on the broken code. A check that cannot fail is not a check.
 *
 * A write rather than a bare tool call, because since v1.1.6 a turn earns a page only if it changed
 * something.
 */
const hook = async (event, ts) => {
  const res = await fetch(`${board.UI}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: card.id, receivedAt: ts, event }),
  })
  if (!res.ok) throw new Error(`hook post failed: ${res.status}`)
}
let clock = Date.now() - 60 * 60 * 1000
const tick = () => (clock += 1000)
await hook({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'change the loader' }, tick())
await hook(
  { hook_event_name: 'PostToolUse', prompt_id: 'p1', tool_name: 'Write', tool_input: { file_path: 'C:/scratch/loader.ts' } },
  tick(),
)
await hook({ hook_event_name: 'Stop', prompt_id: 'p1' }, tick())
await sleep(600)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

/**
 * The geometry of one web button, what the browser says is on top of its centre, and the card.
 *
 * `elementFromPoint` is the whole point of this file. It answers the question the owner actually
 * hit, which is not "is the button there" but "if I press the middle of it, what gets the press".
 */
const probe = (which) =>
  page.evaluate((sel) => {
    const node = document.querySelector(`.react-flow__node[data-id]`)
    const btn = document.querySelector(sel)
    if (!node || !btn) return null
    const nb = node.getBoundingClientRect()
    const bb = btn.getBoundingClientRect()
    const cx = bb.left + bb.width / 2
    const cy = bb.top + bb.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      button: { x: bb.left, y: bb.top, w: bb.width, h: bb.height, bottom: bb.bottom, top: bb.top },
      cardTop: nb.top,
      cardBottom: nb.bottom,
      // Whether the button, or something inside it, is what the press would land on.
      ownsItsCentre: !!hit && (hit === btn || btn.contains(hit)),
      // Named so a failure says what stole it rather than only that something did.
      atCentre: hit ? `${hit.tagName.toLowerCase()}.${(hit.className || '').toString().split(' ').slice(0, 3).join('.')}` : 'nothing',
    }
  }, sel(which))

function sel(which) {
  return which === 'history' ? '.port-arrow--up' : '.port-arrow--down'
}

await page.hover('.react-flow__node')
await sleep(300)

const hist = await probe('history')
check('the history button is on screen', !!hist)

if (hist) {
  /*
   * Worth asserting, but honestly labelled: this passed on the broken build too. The button owned
   * its own centre even while straddling the edge, because the resize line is thin and the middle of
   * a 15px button clears it. What it catches is something being drawn over the button later, which
   * is a different regression and still worth a line.
   */
  check('nothing is drawn on top of the history button', hist.ownsItsCentre, `got ${hist.atCentre}`)

  /*
   * This is the one that catches the fault he reported. Pre-fix the button was 15px tall anchored
   * 6px above the card top, so 9 of its 15 pixels lay over the card's own edge, which is where the
   * resize line runs. Verified red on the previous commit: "button bottom 109, card top 100".
   */
  check(
    'and it sits clear of the card edge rather than across it',
    hist.button.bottom <= hist.cardTop + 1,
    `button bottom ${Math.round(hist.button.bottom)}, card top ${Math.round(hist.cardTop)}`,
  )

  // Pre-fix: 15px square carrying an 8px glyph.
  check(
    'it is big enough to aim at',
    hist.button.w >= 20 && hist.button.h >= 20,
    `${Math.round(hist.button.w)}x${Math.round(hist.button.h)}`,
  )
}

const roots = await probe('roots')
if (roots) {
  check('pressing the middle of the roots button lands on the button', roots.ownsItsCentre, `got ${roots.atCentre}`)
  check(
    'and it sits clear of the card edge too',
    roots.button.top >= roots.cardBottom - 1,
    `button top ${Math.round(roots.button.top)}, card bottom ${Math.round(roots.cardBottom)}`,
  )
}

// --- and the card was not resized by any of that ---

const widthBefore = card.width
await page.click('.port-arrow--up')
await sleep(1400)

const after = board.state.sessions.find((s) => s.id === card.id)
// The symptom he actually reported. A press that resizes is a press that reached the resizer.
check('pressing it did not resize the card', after?.width === widthBefore, `${widthBefore} -> ${after?.width}`)

/** What the arrow says it will do next, which is how the fold state is visible at all. */
const arrowLabel = () =>
  page.evaluate(() => document.querySelector('.port-label--top')?.textContent?.trim() ?? '')
const dayPills = () => page.evaluate(() => document.querySelectorAll('[data-id^="histpick:"]').length)

const openLabel = await arrowLabel()
// Verified red on the previous commit: it still read "History" with the days on screen, which is
// why a second press asked for them again instead of folding.
check('after one press the arrow offers to fold away', openLabel === 'Fold away', `reads "${openLabel}"`)

// The card was given a turn above precisely so this can be non-zero. If it is zero the fold check
// below proves nothing, so say so here rather than letting a vacuous pass through.
const openPills = await dayPills()
check('and a day is actually on the board to fold', openPills > 0, `${openPills} day pill(s)`)

// --- fold it away again ---

await page.click('.port-arrow--up')
await sleep(1400)

const pills = await dayPills()
// Pre-fix: the turn cards went and the day pills stayed, because they are drawn from an answer the
// server has no reason to send again. So the block never actually closed.
check('pressing it again takes the days off the board', pills === 0, `${pills} day pill(s) still drawn`)

const closedLabel = await arrowLabel()
// Pre-fix this still read "History" while the days were showing, which is why a second press
// reopened rather than folded.
check('and the arrow offers to open again', closedLabel === 'History', `reads "${closedLabel}"`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
