/**
 * Screenshot harness. Drives the app in real Chrome and writes PNGs to docs/shots/.
 *
 * Exists so visual changes can be verified by a reviewer that sees only the image, never the code.
 * A card screen is static and self-contained, so one shot represents the whole state, which is
 * exactly the case where there is no excuse to skip looking.
 *
 * It gets a Garden of its own, on its own port with its own workspace, and serves the BUILT app off
 * that same port. It used to open `localhost:5177`, the dev server, and then add `C:\Garden` as a
 * project and launch three real sessions into it. That meant taking a screenshot mutated the board
 * the owner was working on, which is the same trap the test scripts carried and it has cost him a
 * live board more than once. A review pass must never be a reason to be afraid of running one.
 *
 * So this needs no dev server and no live app:
 *
 *   npm run build
 *   node scripts/capture.mjs
 *
 * The shots land in docs/shots/ and they are the thing to open. Nothing appears on screen while it
 * runs, because Chrome is headless on purpose: a review pass should never steal the display.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

// The target display: a 37 inch 4K ultrawide. Layout must be judged at the real aspect ratio.
const WIDTH = 3840
const HEIGHT = 1600

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A board with a chain already on it, so the shots show a team rather than one lonely card.
 *
 * Created switched off, every one. A screenshot is about what is drawn, and spawning real shells to
 * look at a layout is a cost with nothing to show for it. The roles are the current chain: the boss
 * rung was removed on 2026-08-12, so a manager answers to the orchestrator directly.
 */
const board = await openBoard({
  projectName: 'shots',
  files: {
    'notes.md': '# Notes\n\nA document card, so the board shows both card kinds.\n',
    'plan.md': '# Plan\n\nA second one, to show two side by side.\n',
  },
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Loader department', roleClass: 'manager', reportsTo: 0 },
    { title: 'Loader worker', roleClass: 'worker', reportsTo: 1 },
    { title: 'Reviewer', roleClass: 'reviewer', reportsTo: 0 },
  ],
})

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

const taken = []
async function shot(name, what) {
  const path = join(OUT, `${name}.png`)
  await page.screenshot({ path })
  taken.push({ name, what })
  console.log('shot:', path)
}

await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

await shot('01-board', 'The whole board: four role cards and the sidebar.')

// --- the ceiling control in the sidebar, which nobody has looked at ---

const ceilingBox = await page.evaluate(() => {
  const el = document.querySelector('.rail-limits')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
if (ceilingBox && ceilingBox.width > 0) {
  await page.screenshot({
    path: join(OUT, '02-ceiling.png'),
    clip: {
      x: Math.max(0, ceilingBox.x - 20),
      y: Math.max(0, ceilingBox.y - 20),
      width: Math.min(WIDTH, ceilingBox.width + 40),
      height: Math.min(HEIGHT, ceilingBox.height + 40),
    },
  })
  taken.push({ name: '02-ceiling', what: 'The board ceiling control in the sidebar, close up.' })
  console.log('shot:', join(OUT, '02-ceiling.png'))
} else {
  console.log('NOT FOUND: .rail-limits, so no ceiling shot was taken')
}

// --- the new card form, in the quick state and the full one ---

await page.mouse.click(2200, 900, { button: 'right' })
await sleep(600)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) =>
    /New role card/i.test(x.textContent ?? ''),
  )
  b?.click()
})
await sleep(800)
await shot('03-newcard-quick', 'The new card form as it opens: the quick path.')

await page.evaluate(() => {
  const el = document.querySelector('.newcard')
  const fold = [...(el?.querySelectorAll('button, summary') ?? [])].find((b) =>
    /more options/i.test(b.textContent || ''),
  )
  fold?.click()
})
await sleep(500)
await shot('04-newcard-full', 'The same form with More options opened.')

await page.keyboard.press('Escape')
await sleep(500)

// --- a card's own role picker, and the pending-role note ---

const cardBox = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.react-flow__node')].find((n) =>
    /Loader department/.test(n.textContent || ''),
  )
  if (!node) return null
  const r = node.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
if (cardBox) {
  await page.screenshot({
    path: join(OUT, '05-card.png'),
    clip: {
      x: Math.max(0, cardBox.x - 30),
      y: Math.max(0, cardBox.y - 30),
      width: Math.min(WIDTH - cardBox.x + 30, cardBox.width + 380),
      height: Math.min(HEIGHT - cardBox.y + 30, cardBox.height + 60),
    },
  })
  taken.push({ name: '05-card', what: 'One card close up, with whatever is pinned beside it.' })
  console.log('shot:', join(OUT, '05-card.png'))
}

// --- a document card, since the save badge lives there ---

/*
 * The file list is folded behind a "Show N files" control, so it has to be opened before a file can
 * be clicked. The first version of this script skipped that and took a shot of a board with no
 * document card on it, then labelled the image "a document card open on the board", which is the
 * exact kind of caption that wastes a reviewer's time and quietly discredits the whole set.
 */
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .filter((x) => x.offsetParent !== null)
    .find((x) => /show \d+ files?/i.test(x.textContent || ''))
  b?.click()
})
await sleep(800)
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.rail-section .row')].find((r) =>
    /notes\.md/.test(r.textContent || ''),
  )
  row?.click()
})
await sleep(1400)

const docDrawn = await page.$$eval('.node--doc', (n) => n.length)
if (docDrawn === 0) {
  console.log('WARNING: no document card is on the board, so 06-doc.png does not show one')
}
await shot('06-doc', 'A document card open on the board, beside the session cards.')

// --- a card showing its conversation rather than its terminal ---

/*
 * These cards are switched off and have never run, so this is deliberately the empty case: what a
 * card says when it has nothing to show yet. That is the shot worth reviewing, because the failure
 * mode is a blank pane that reads as a run which did nothing.
 */
/*
 * A Claude card, added here rather than in the board above so only these last two shots differ from
 * the ones before them. The switch is offered only on a card that can actually have a transcript: a
 * shell has none and never will, so a shell card with the control would be a button with one working
 * position, and a blind reviewer shown exactly that read the copy as written for something else.
 */
board.ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: board.project.id,
    adapterId: 'claude',
    title: 'Researcher',
    start: false,
  }),
)
await sleep(1600)

const flipped = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.node')].find((n) =>
    /Researcher/.test(n.querySelector('.node-title')?.textContent || ''),
  )
  if (!node) return null
  const btn = [...node.querySelectorAll('button')].find((b) => /Show the conversation/.test(b.title || ''))
  if (!btn) return null
  btn.click()
  return node.querySelector('.node-title')?.textContent?.trim() ?? 'a card'
})
if (!flipped) {
  console.log('WARNING: no conversation toggle found, so 07-conversation.png does not show one')
}
await sleep(1500)
await shot('07-conversation', 'A Claude card switched from its terminal to its conversation. The others are unchanged.')

// --- the board with no server behind it ---

/*
 * Last, because it takes the server away and nothing after it would work.
 *
 * This state used to be announced by a small grey chip in the corner of the top bar, which is worth
 * a look precisely because the board behind it is frozen and looks completely ordinary. Everything
 * the owner can see is stale, and the only thing saying so is on screen here.
 */
await board.stop()
await sleep(4000)
await shot('08-offline', 'The board a moment after its server went away, with nothing running behind it.')

/*
 * What each shot is, written beside them, so whoever reviews them is given the images and the
 * neutral question and never the code. This file is the ONLY thing the reviewer should be handed
 * besides the PNGs, and it deliberately says what is pictured rather than what it is supposed to
 * look like.
 */
writeFileSync(
  join(OUT, 'INDEX.md'),
  ['# What each shot is', '', ...taken.map((t) => `- \`${t.name}.png\`  ${t.what}`), ''].join('\n'),
  'utf8',
)

if (errors.length) {
  console.log('\n--- console errors ---')
  for (const e of errors.slice(0, 20)) console.log(e)
} else {
  console.log('\nno console errors')
}

await browser.close()
// `board.stop()` already ran, above the offline shot.
