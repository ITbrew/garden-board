/**
 * Screenshots of the roots UI in its three states, for a blind pass.
 *
 * The roots are the part of the board the owner has been looking at hardest, and the failures have
 * all been visual: columns that read as decoration, pills that looked duplicated, a block that
 * landed somewhere it did not belong. None of that is countable, so it needs pictures and a reviewer
 * who has not seen the code.
 *
 * Its own Garden, its own port, its own workspace, like every other harness here. Shots go wherever
 * SHOT_DIR points, defaulting to docs/shots/roots, so a real conversation or a real board is never
 * what gets photographed.
 *
 *   npm run build
 *   node scripts/capture-roots.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.SHOT_DIR || join(ROOT, 'docs', 'shots', 'roots')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A card with something in every column, so the row is the width it really is in use.
const board = await openBoard({
  projectName: 'roots',
  cards: [{ title: 'Loader department', roleClass: 'manager' }],
  files: { 'CLAUDE.md': '# Project\n', 'AGENTS.md': '# Agents\n', 'README.md': '# Readme\n' },
})
mkdirSync(join(board.dir, 'docs', 'canonical'), { recursive: true })
for (let i = 0; i < 24; i++) {
  writeFileSync(join(board.dir, 'docs', 'canonical', `design-note-${i}.md`), `# Note ${i}\n\nText.\n`)
}

const WIDTH = 3840
const HEIGHT = 1600
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const taken = []
/*
 * Fit the board before each shot.
 *
 * A first pass photographed a card sitting against the left sidebar, so half the roots row was behind
 * the sidebar and a reviewer reported columns "clipped", "jammed against the left" and one that
 * "opened nothing" when it had simply opened off-screen. That is the harness lying about the app.
 */
const fit = async () => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.react-flow__controls button')].find((b) =>
      /fit/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''),
    )
    btn?.click()
  })
  await sleep(1200)
}

const shot = async (name, what) => {
  await fit()
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  taken.push({ name, what })
  console.log('shot:', join(OUT, `${name}.png`))
}

const pressPill = (label) =>
  page.evaluate((l) => {
    const el = [...document.querySelectorAll('.colhead--pick:not(.is-open)')].find(
      (e) => e.querySelector('.colhead-label')?.textContent?.trim() === l,
    )
    el?.click()
    return !!el
  }, label)

await shot('01-folded', 'A card with its roots folded away. Nothing below it should be open.')

await page.evaluate(() => document.querySelector('.port-arrow--down')?.click())
await sleep(2500)
await shot('02-columns', 'The roots unfolded. Every column is closed; nothing has been opened yet.')

await pressPill('Instructions')
await sleep(3000)
await shot('03-one-open', 'One column opened, the rest still closed.')

await pressPill('Its own notes')
await sleep(3000)
await shot('04-two-open', 'A second column opened beside the first.')

await pressPill('Research')
await sleep(3500)
await shot('05-three-open', 'A third and much larger column opened as well.')

writeFileSync(
  join(OUT, 'INDEX.md'),
  ['# What each shot is', '', ...taken.map((t) => `- \`${t.name}.png\`  ${t.what}`), ''].join('\n'),
  'utf8',
)
console.log(errors.length ? `\nconsole errors:\n${errors.slice(0, 10).join('\n')}` : '\nno console errors')

await browser.close()
await board.stop()
