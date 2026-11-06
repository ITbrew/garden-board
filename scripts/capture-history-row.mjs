/**
 * The day pills against an opened history block, on a scratch board of its own.
 *
 * The owner: "when a history day is opened, make that panel not overlap the other dates". Two things
 * are drawn above a card, the row of day pills and the block an opened day unfolds into, and until
 * now neither knew about the other. This makes the three states and both photographs and measures
 * them, because a screenshot can be squinted at and a number cannot.
 *
 * The measurement is in BOARD coordinates, not screen ones. The canvas is zoomed to fit whatever is
 * on it, so a clearance in screen pixels shrinks as the board grows and two shots of the same
 * clearance would report different numbers. Dividing out the viewport's own scale gives a figure
 * that can be read against `BOARD.GAP` and the rest of the table.
 *
 * The turns are seeded by posting the hook events the real CLI posts, at the same `/hook` door, with
 * `receivedAt` set to the day each turn belongs to. That is what makes the days real: the server
 * groups work records by the day of `startedAt`, and `startedAt` is `receivedAt`. Writing rows
 * would take a shortcut around the grouping this whole layout hangs off.
 *
 *   npm run build
 *   node scripts/capture-history-row.mjs
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md. Nothing here
 * touches the live board or a real workspace.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 2400
const HEIGHT = 1700

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({ projectName: 'histrow-shots', cards: ['Loader'] })
const card = board.cards[0]

/*
 * Four days, and the shape of them is the test rather than decoration.
 *
 * Six turns is one row and seven is two, so the seven-turn day is the one that proves the row
 * follows a block that wraps. The other three exist so that pills REMAIN in the row once one and
 * then two days are open: with only the days being opened there would be nothing left to be
 * overlapped and every shot would pass for the wrong reason.
 */
const DAY = 24 * 60 * 60 * 1000
const noon = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * DAY)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}
const DAYS = [
  { daysAgo: 3, turns: 2 },
  { daysAgo: 2, turns: 3 },
  { daysAgo: 1, turns: 7 },
  { daysAgo: 0, turns: 2 },
]

async function hook(event, receivedAt) {
  const res = await fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: card.id, receivedAt, event }),
  })
  if (!res.ok) throw new Error(`/hook refused with ${res.status}: ${await res.text()}`)
}

for (const day of DAYS) {
  for (let i = 0; i < day.turns; i++) {
    const at = noon(day.daysAgo) + i * 60_000
    const promptId = randomUUID()
    await hook(
      { hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt: `turn ${i + 1} of day -${day.daysAgo}` },
      at,
    )
    /*
     * A file write inside the turn, and it is required rather than realistic detail. `hasSubstance`
     * drops a turn that called no tool and touched no file, and the day pills are counted with that
     * same filter, so turns without one produce a card whose history opens to nothing at all. The
     * first run of this script seeded fourteen turns and drew zero pills for exactly that reason.
     */
    await hook(
      {
        hook_event_name: 'PostToolUse',
        prompt_id: promptId,
        tool_name: 'Edit',
        tool_input: { file_path: `C:/scratch/day${day.daysAgo}/turn${i + 1}.ts` },
      },
      at + 10_000,
    )
    await hook({ hook_event_name: 'Stop', prompt_id: promptId }, at + 30_000)
  }
}
console.log(`seeded ${DAYS.reduce((n, d) => n + d.turns, 0)} turns across ${DAYS.length} days`)
await sleep(800)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: [`--window-size=${WIDTH},${HEIGHT}`],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(board.UI, { waitUntil: 'networkidle2' })
/*
 * Wait for the board to exist rather than for a number of milliseconds.
 *
 * A fixed sleep is a guess about how busy this machine is, and on a machine running several cards
 * it guessed wrong: the card had not been drawn yet, so the history arrow was not found, and the
 * failure that surfaced was a missing Fit control three steps later. Waiting for the card's own
 * furniture is the same wait, expressed as the condition it was standing in for.
 */
await page.waitForSelector('.react-flow__node .port-arrow--up', { timeout: 30000 })
await page.waitForSelector('.react-flow__controls-fitview', { timeout: 30000 })
await sleep(1200)

/**
 * Everything the assertion needs, in board coordinates.
 *
 * The pills, the history frame, and the card, each as a rectangle with the viewport's own scale
 * divided out. `getBoundingClientRect` is what the eye sees and is therefore the right thing to
 * measure; it is only the units that have to be put back.
 */
async function measure() {
  return page.evaluate(() => {
    const viewport = document.querySelector('.react-flow__viewport')
    const scale = Number(/scale\(([\d.]+)\)/.exec(viewport?.style.transform ?? '')?.[1] ?? 1)
    /*
     * Positions from each node's own transform, sizes from its rectangle.
     *
     * A bounding rectangle is in window pixels and includes whatever a node draws outside its own
     * box: the port arrows hang above a card by design, so a rect puts a card's top 26 pixels
     * higher than the board says it is, and every distance measured from it is wrong by that.
     * React Flow writes the board position straight into the node's `transform`, which is the same
     * number the layout code works in, so the comparison is exact rather than nearly right.
     */
    const at = (el) => {
      const m = /translate(?:3d)?\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform ?? '')
      if (!m) throw new Error(`a node had no readable transform: ${el.getAttribute('data-id')}`)
      const r = el.getBoundingClientRect()
      const x = Number(m[1])
      const y = Number(m[2])
      const width = r.width / scale
      const height = r.height / scale
      return { id: el.getAttribute('data-id'), x, y, width, height, top: y, bottom: y + height, left: x, right: x + width }
    }
    const pick = (selector) => [...document.querySelectorAll(selector)]
    return {
      scale,
      pills: pick('.react-flow__node[data-id^="histpick:"]').map(at),
      frames: pick('.react-flow__node[data-id^="frame:"]')
        .filter((n) => n.getAttribute('data-id').endsWith(':history'))
        .map(at),
      cards: pick('.react-flow__node').filter((n) => n.querySelector(':scope > .node')).map(at),
    }
  })
}

/**
 * Bring the whole board into view, with the app's own Fit control.
 *
 * Needed rather than tidy. The row sits above the card and the block above that, so opening a day
 * grows the board upward past the top of the window, and React Flow does not keep nodes in the DOM
 * once they leave it. Measuring without this reports zero pills for a row that is drawn perfectly
 * well, which is the first thing this script did.
 */
async function fit() {
  const pressed = await page.evaluate(() => {
    const button = document.querySelector('.react-flow__controls-fitview')
    if (!button) return false
    button.click()
    return true
  })
  if (!pressed) throw new Error('the canvas has no Fit control to press')
  await sleep(900)
}

const shot = async (name) => {
  const file = join(OUT, name)
  await page.screenshot({ path: file })
  console.log(`shot: ${file}`)
  return file
}

/*
 * Open the history from the card's own arrow rather than by calling the action.
 *
 * Since the change earlier tonight the pill row is drawn only for a card whose history is unfolded,
 * so pressing the control is the only thing that puts this board into the state being tested. A
 * board forced into it from outside would be a board no owner can reach.
 */
const opened = await page.evaluate(() => {
  const arrow = document.querySelector('.react-flow__node .port-arrow--up')
  if (!arrow) return null
  arrow.click()
  return true
})
if (!opened) throw new Error('the card drew no history arrow to press')
console.log('clicked the history arrow')
await page.waitForSelector('.react-flow__node[data-id^="histpick:"]', { timeout: 30000 })
await sleep(1200)
await fit()

/**
 * Press one day's pill, named by which day it is rather than by where it sits in the row.
 *
 * By position first, and that was a quiet mistake worth keeping the note for: the pills are ordered
 * newest first, so slot 2 was the three-turn day and the shot labelled "seven turns, two rows"
 * was of a block with one row in it. The case the label claimed was never exercised. Naming the day
 * makes the label and the thing photographed the same thing.
 */
const dayKey = (daysAgo) => {
  const d = new Date(noon(daysAgo))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function openDay(daysAgo) {
  const key = dayKey(daysAgo)
  const which = await page.evaluate((group) => {
    const target = [...document.querySelectorAll('.react-flow__node[data-id^="histpick:"]')].find((n) =>
      n.getAttribute('data-id').endsWith(`:${group}`),
    )
    if (!target) return null
    const button = target.querySelector('.colhead--pick') ?? target.querySelector('button')
    if (!button) return null
    button.click()
    return target.getAttribute('data-id')
  }, key)
  if (!which) throw new Error(`there was no pill for ${key} to open`)
  console.log(`opened ${which}`)
  await sleep(2200)
  await fit()
}

const results = []

/**
 * How much clear board space there is between the lowest pill and the top of the frame.
 *
 * Negative means the row is inside the block, which is the fault being fixed. Null means there is
 * no frame yet, which is the resting case and has nothing to clear.
 */
function clearance(m) {
  if (!m.frames.length) return null
  /*
   * A clearance measured against no pills is not a pass, it is a missing row. Without this the
   * whole check reports success on a board where the pills failed to draw at all, which is the
   * exact shape of a test that passes for the wrong reason.
   */
  if (!m.pills.length) throw new Error('a frame is open but no day pills are drawn at all')
  const frameTop = Math.min(...m.frames.map((f) => f.top))
  const lowestPill = Math.max(...m.pills.map((p) => p.bottom))
  return Math.round((frameTop - lowestPill) * 10) / 10
}

const before = await measure()
await shot('40-history-row-nothing-open.png')
results.push({ state: 'nothing open', pills: before.pills.length, expect: DAYS.length, clearance: clearance(before), m: before })

/*
 * The seven-turn day first, because it is the one that wraps to two rows. If the row only cleared a
 * one-row block this is the case that would catch it.
 */
await openDay(1)
const oneOpen = await measure()
await shot('41-history-row-one-day-open.png')
results.push({ state: 'one day open (7 turns, two rows)', pills: oneOpen.pills.length, expect: DAYS.length - 1, clearance: clearance(oneOpen), m: oneOpen })

await openDay(3)
const twoOpen = await measure()
await shot('42-history-row-two-days-open.png')
results.push({ state: 'two days open', pills: twoOpen.pills.length, expect: DAYS.length - 2, clearance: clearance(twoOpen), m: twoOpen })

/*
 * The resting position, asserted rather than eyeballed.
 *
 * A card with no day open has to be pixel-identical to before this change, and that is checkable:
 * the row sits 56 above the card less the 34 a pill takes, so the gap from the pill's top to the
 * card's top is exactly 90 board pixels. If this moves, the majority case moved.
 */
const cardTop = Math.min(...before.cards.map((c) => c.top))
const restingGap = Math.round((cardTop - Math.min(...before.pills.map((p) => p.top))) * 10) / 10
console.log('')
/*
 * Reported rather than asserted against a number, and the reason is worth writing down.
 *
 * The row is placed from the card's STORED y, and on a board that has not had a layout saved the
 * card is DRAWN at a packed position instead, so the gap on screen is not the 56 + 34 the code
 * computes. That is not this change's doing and not this change's to fix; it is only a reason not
 * to bake 90 into an assertion here and call a pre-existing offset a failure. What this figure is
 * for is comparison: run this script against a build without the change and the resting gap has to
 * come out identical, because with no day open the expression is the one that was there before.
 */
console.log(`resting row sits ${restingGap} board px above the card as drawn`)
console.log('')

let failed = 0

/*
 * How many pills are left, asserted rather than reported.
 *
 * Every overlap check below is over the pills that are drawn, so a row that failed to draw would
 * pass all of them with nothing in it. Four days, less one for each day opened.
 */
for (const r of results) {
  const ok = r.pills === r.expect
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.state}: ${r.pills} pills drawn, ${r.expect} expected`)
}

for (const r of results) {
  if (r.clearance === null) {
    console.log(`      ${r.state}: no block open and nothing to clear`)
    continue
  }
  const ok = r.clearance > 0
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${r.state}: ${r.pills} pill${r.pills === 1 ? '' : 's'} left, ` +
      `${r.clearance} board px of clear space between the lowest pill and the top of the frame`,
  )
}

/*
 * And that no pill is inside the frame's rectangle at all, which is the thing the owner actually
 * complained about. The clearance above is the vertical gap; this is the overlap test itself, and
 * it would catch a row that cleared the top of the frame and ran into its side.
 */
for (const r of results) {
  if (!r.m.frames.length) continue
  const overlapping = r.m.pills.filter((p) =>
    r.m.frames.some((f) => p.left < f.right && p.right > f.left && p.top < f.bottom && p.bottom > f.top),
  )
  if (overlapping.length) failed++
  console.log(
    `${overlapping.length ? 'FAIL' : 'PASS'}  ${r.state}: ${overlapping.length} of ${r.m.pills.length} pills ` +
      'overlap the history frame',
  )
}

console.log('')
console.log(JSON.stringify(results.map((r) => ({ state: r.state, scale: r.m.scale, pills: r.m.pills, frames: r.m.frames })), null, 2))
console.log(errors.length ? `console errors: ${errors.join('; ')}` : 'no console errors')

await browser.close()
await board.stop()
process.exit(failed ? 1 : 0)
