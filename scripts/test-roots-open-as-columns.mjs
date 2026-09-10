/**
 * The roots dot opens columns, not a hundred file cards.
 *
 * The owner's report: "for the roots, make it open just the columns when expanded, not every single
 * .md file at once, makes it too laggy the way it is right now". He was looking at a card whose web
 * answered with 117 files, and every one of them arrived as a node on the canvas at the same moment.
 *
 * So this counts nodes. Pressing the dot must add a handful of columns and no cards; pressing a
 * column must then add that column's cards and only that column's. A count is the right assertion
 * here because "laggy" is not something a test can feel, and the number of nodes created in one go
 * is what was actually wrong.
 */
import puppeteer from 'puppeteer-core'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/*
 * A project with enough documents that opening them all would be the thing being complained about.
 * `docs/canonical` is one of the directories the scan collects as research, and the column is capped
 * at forty, which is itself more cards than anyone wants in one go.
 */
const files = { 'CLAUDE.md': '# Project\n', 'AGENTS.md': '# Agents\n', 'README.md': '# Readme\n' }
const board = await openBoard({ cards: ['Rooted'], files })
mkdirSync(join(board.dir, 'docs', 'canonical'), { recursive: true })
for (let i = 0; i < 30; i++) {
  writeFileSync(join(board.dir, 'docs', 'canonical', `note-${i}.md`), `# Note ${i}\n\nSomething.\n`)
}
const card = board.cards[0]

const browser = await puppeteer.launch({
  executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const counts = () =>
  page.evaluate(() => ({
    cards: document.querySelectorAll('.react-flow__node-doc').length,
    columns: document.querySelectorAll('.colhead').length,
    // Pills that are still folded. An open column wears the same class plus `is-open`, and it is
    // a way back rather than a way in.
    pickable: document.querySelectorAll('.colhead--pick:not(.is-open)').length,
    foldable: document.querySelectorAll('.colhead--pick.is-open').length,
  }))

const before = await counts()
check('the board starts with no roots unfolded', before.cards === 0 && before.columns === 0, JSON.stringify(before))

// The dot under the card, found by what it offers rather than by position.
const pressedDot = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.port-arrow--down')][0]
  if (!btn) return false
  btn.click()
  return true
})
check('the roots dot is there', pressedDot)
await sleep(2500)

const opened = await counts()
check(
  'pressing it adds columns and no file cards',
  opened.cards === 0 && opened.columns > 0,
  `${opened.columns} columns, ${opened.cards} file cards`,
)
check('and every column is offering to open', opened.pickable === opened.columns, `${opened.pickable} of ${opened.columns}`)

/*
 * The counts on the columns are the point of showing them at all: the owner has to be able to see
 * that a card runs from a hundred files without a hundred cards arriving to tell him.
 */
const labelled = await page.evaluate(() =>
  [...document.querySelectorAll('.colhead--pick:not(.is-open)')].map((el) => ({
    label: el.querySelector('.colhead-label')?.textContent?.trim() ?? '',
    count: Number(el.querySelector('.colhead-count')?.textContent?.trim() ?? '0'),
  })),
)
check(
  'each column says how many files are behind it',
  labelled.length > 0 && labelled.every((c) => c.label && c.count > 0),
  labelled.map((c) => `${c.label}:${c.count}`).join(' '),
)

// --- opening one column brings that column only ------------------------------------------------

/*
 * With SHOT_DIR set, leave a picture of the columns state behind for a blind pass. The failure this
 * change could introduce is visual and not countable: columns that read as decoration rather than as
 * something to press, or that do not look connected to the card they belong to.
 */
if (process.env.SHOT_DIR) {
  const shot = join(process.env.SHOT_DIR, 'roots-columns.png')
  await page.screenshot({ path: shot })
  console.log('shot:', shot)
}

/*
 * The rightmost column, deliberately. Centring a single column under the card would put it within
 * about eighty pixels of the leftmost pill, which is too close to tell apart from landing correctly.
 * The far right pill sits over a thousand pixels away, so the two outcomes cannot be confused.
 */
const target = labelled[labelled.length - 1]

/*
 * Where every pill sits before anything opens, so it can be checked that none of them moved.
 *
 * Laying the pills out by their index in the remaining list made them slide left to fill the gap
 * when one opened, while the opened column's own header stays where its files are, which is that
 * gap. A pill slid underneath it and the two read as one column labelled twice: "remove duplicate
 * pill from when a root column is expanded".
 */
const pillsBefore = await page.evaluate(() =>
  Object.fromEntries(
    [...document.querySelectorAll('.colhead--pick:not(.is-open)')].map((el) => [
      el.querySelector('.colhead-label')?.textContent?.trim() ?? '',
      Math.round(el.getBoundingClientRect().left),
    ]),
  ),
)
const pillLeftBefore = await page.evaluate((label) => {
  const pill = [...document.querySelectorAll('.colhead--pick:not(.is-open)')].find(
    (e) => e.querySelector('.colhead-label')?.textContent?.trim() === label,
  )
  return pill ? pill.getBoundingClientRect().left : null
}, target.label)
await page.evaluate((label) => {
  const el = [...document.querySelectorAll('.colhead--pick:not(.is-open)')].find(
    (e) => e.querySelector('.colhead-label')?.textContent?.trim() === label,
  )
  el?.click()
}, target.label)
await sleep(3000)

const afterOne = await counts()

check(
  'opening a column brings its files and not the rest',
  afterOne.cards === target.count,
  `opened ${target.label} (${target.count}), got ${afterOne.cards} cards`,
)
check(
  'and the columns that are still folded stay offered',
  afterOne.pickable === opened.pickable - 1,
  `${afterOne.pickable} still pickable, was ${opened.pickable}`,
)


/*
 * A column that is open can be folded back on its own, without taking the rest of the roots with it.
 * "i cant collapse them after they are opened".
 */
const pillsAfter = await page.evaluate(() =>
  Object.fromEntries(
    [...document.querySelectorAll('.colhead--pick:not(.is-open)')].map((el) => [
      el.querySelector('.colhead-label')?.textContent?.trim() ?? '',
      Math.round(el.getBoundingClientRect().left),
    ]),
  ),
)
const moved = Object.entries(pillsAfter).filter(([k, v]) => pillsBefore[k] !== undefined && pillsBefore[k] !== v)
check(
  'the columns that stayed folded did not move when one opened',
  moved.length === 0,
  moved.length ? moved.map(([k, v]) => `${k} ${pillsBefore[k]} -> ${v}`).join(', ') : 'every pill kept its slot',
)
check('the opened column offers a way back', afterOne.foldable === 1, `${afterOne.foldable} foldable`)

// A second picture, with one column open, which is where a duplicated pill would show.
if (process.env.SHOT_DIR) {
  const shot2 = join(process.env.SHOT_DIR, 'roots-column-open.png')
  await page.screenshot({ path: shot2 })
  console.log('shot:', shot2)
}
await page.evaluate(() => document.querySelector('.colhead--pick.is-open')?.click())
await sleep(2500)
const refolded = await counts()
check(
  'folding one column puts its files away and leaves the others alone',
  refolded.cards === 0 && refolded.pickable === opened.pickable,
  `${refolded.cards} cards left, ${refolded.pickable} pills back`,
)

// Folding away takes the columns with it, so the dot is a toggle rather than a one-way door.
await page.evaluate(() => document.querySelector('.port-arrow--down')?.click())
await sleep(2500)
const folded = await counts()
check('folding away clears both', folded.cards === 0 && folded.columns === 0, JSON.stringify(folded))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
