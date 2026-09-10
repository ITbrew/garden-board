/**
 * Screenshots of the pipeline view, on the seeded card, for a reviewer that sees only the images.
 *
 * Separate from capture.mjs because that one adds the owner's own repository as a project and
 * launches live sessions on it, which is exactly what must not happen here. This one touches
 * nothing it did not find: it opens the tab seed-pipeline-runs.mjs already made, finds the one card
 * on it by the id that script wrote down, and photographs what is on screen.
 *
 * Run the dev servers, then:
 *   node scripts/seed-pipeline-runs.mjs
 *   node scripts/capture-pipeline.mjs
 *
 * With no argument it reports what the card's context menu offers and stops, so the gesture that
 * opens the view can be found by asking the running page rather than by reading the code that drew
 * it. Pass the menu item text to actually open it:
 *   node scripts/capture-pipeline.mjs "Show pipeline"
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const STAMP = join(OUT, '.pipeline-seed.json')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5177/'
const WIDTH = 3840
const HEIGHT = 1600

const MENU_ITEM = process.argv[2] || null

if (!existsSync(STAMP)) {
  console.log('no seed stamp; run: node scripts/seed-pipeline-runs.mjs')
  process.exit(1)
}
const seed = JSON.parse(readFileSync(STAMP, 'utf8'))
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.stack || String(e)))

const shot = async (name) => {
  const path = join(OUT, `${name}.png`)
  await page.screenshot({ path })
  console.log('shot:', path)
}

await page.goto(URL, { waitUntil: 'networkidle2' })
// The tab strip renders after the first state message arrives, so querying too early finds an
// empty document and concludes the tab does not exist. Wait for the strip itself.
await page.waitForSelector('.tabs .tab', { timeout: 15000 })
await sleep(1200)

// Switch to the scratch tab. Matched on the temp directory name the seeder created, so this can
// never land on one of the owner's real projects by accident.
const tabName = seed.dir.split(/[\\/]/).pop()
const onTab = await page.evaluate((name) => {
  const tabs = [...document.querySelectorAll('.tabs .tab')]
  const t = tabs.find((el) => (el.textContent || '').includes(name))
  if (!t) return { ok: false, saw: tabs.map((el) => (el.textContent || '').trim()).slice(0, 20) }
  t.click()
  return { ok: true, already: t.classList.contains('is-active') }
}, tabName)
console.log('scratch tab', tabName, onTab.ok ? 'selected' : 'NOT FOUND; tabs were: ' + JSON.stringify(onTab.saw))
await sleep(1800)

// The card, located by the id the seeder recorded rather than by title.
const card = await page.evaluateHandle((id) => {
  const nodes = [...document.querySelectorAll('.react-flow__node')]
  return nodes.find((n) => (n.getAttribute('data-id') || '').includes(id)) || null
}, seed.sessionId)
const cardEl = card.asElement()
if (!cardEl) {
  console.log('seeded card not on canvas')
  await shot('pipeline-00-no-card')
  await browser.close()
  process.exit(1)
}
// Bring it on screen by moving the canvas under it at 1:1, rather than by scrolling: a react-flow
// node lives inside a transformed viewport, so scrollIntoView does nothing and boundingBox comes
// back null for anything parked outside the window.
const placed = await page.evaluate((id) => {
  const n = [...document.querySelectorAll('.react-flow__node')].find((el) =>
    (el.getAttribute('data-id') || '').includes(id),
  )
  const vp = document.querySelector('.xyflow__viewport') || document.querySelector('.react-flow__viewport')
  const m = /translate\(\s*([-\d.]+)px[,\s]+([-\d.]+)px/.exec(n?.style.transform || '')
  if (!n || !vp || !m) return null
  const x = parseFloat(m[1])
  const y = parseFloat(m[2])
  vp.style.transform = `translate(${240 - x}px, ${160 - y}px) scale(1)`
  return { x, y }
}, seed.sessionId)
console.log('canvas moved to card at', JSON.stringify(placed))
await sleep(600)
await shot('pipeline-01-card')

const box = await cardEl.boundingBox()
if (!box) {
  console.log('card has no box even after moving the canvas; stopping rather than guessing')
  await browser.close()
  process.exit(1)
}
await page.mouse.click(box.x + box.width / 2, box.y + 12, { button: 'right' })
await sleep(600)

const items = await page.$$eval('.ctxmenu__item', (els) => els.map((e) => (e.textContent || '').trim()))
console.log('context menu offers:', JSON.stringify(items))

if (!MENU_ITEM) {
  await shot('pipeline-02-menu')
  console.log('\nno menu item given; pass one to open the view, e.g. node scripts/capture-pipeline.mjs "' + (items[0] ?? 'Item') + '"')
  if (errors.length) console.log('\nconsole errors:\n' + errors.slice(0, 10).join('\n'))
  await browser.close()
  process.exit(0)
}

const clicked = await page.evaluate((label) => {
  const item = [...document.querySelectorAll('.ctxmenu__item')].find((i) =>
    (i.textContent || '').toLowerCase().includes(label.toLowerCase()),
  )
  if (!item) return false
  item.click()
  return true
}, MENU_ITEM)
console.log('menu item', JSON.stringify(MENU_ITEM), clicked ? 'clicked' : 'NOT FOUND')
await sleep(2500)

// What actually appeared, asked of the DOM rather than judged from the picture. This is here so a
// blank or cropped capture is caught before it is handed to a reviewer: a reviewer sent an empty
// image will answer honestly about an empty image, and prove nothing.
// Matched on the node type rather than on the id: the panel's id contains the card's id, so
// "any node that is not the card" silently excludes the very thing being looked for.
const appeared = await page.evaluate(() => {
  const n = document.querySelector('.react-flow__node-pipeline')
  if (!n) return null
  const r = n.getBoundingClientRect()
  const m = /translate\(\s*([-\d.]+)px[,\s]+([-\d.]+)px/.exec(n.style.transform || '')
  return {
    id: n.getAttribute('data-id'),
    w: Math.round(r.width),
    h: Math.round(r.height),
    x: m ? parseFloat(m[1]) : null,
    y: m ? parseFloat(m[2]) : null,
    runs: n.querySelectorAll('.prun').length,
    stages: n.querySelectorAll('.pstage').length,
  }
})
console.log('pipeline panel:', JSON.stringify(appeared))
if (!appeared) {
  console.log('no pipeline panel rendered; stopping rather than handing a reviewer an empty picture')
  await shot('pipeline-03-nothing')
  await browser.close()
  process.exit(1)
}
await shot('pipeline-03-open')

// Put the panel itself in frame at 1:1, so nothing the reviewer is asked about is cropped.
if (appeared?.x != null) {
  await page.evaluate((pos) => {
    const vp = document.querySelector('.xyflow__viewport') || document.querySelector('.react-flow__viewport')
    if (vp) vp.style.transform = `translate(${120 - pos.x}px, ${90 - pos.y}px) scale(1)`
  }, appeared)
  await sleep(700)
  await shot('pipeline-04-panel')

  // Anything scrolled out of the panel is not in the picture, and a reviewer cannot report on what
  // it cannot see. Say so in numbers rather than trusting that it looked complete.
  const clipped = await page.evaluate(() => {
    const n = document.querySelector('.react-flow__node-pipeline')
    const pr = n.getBoundingClientRect()
    const stages = [...n.querySelectorAll('.pstage')]
    const outside = stages.filter((s) => {
      const r = s.getBoundingClientRect()
      return r.bottom > pr.bottom + 1 || r.top < pr.top - 1 || r.right > pr.right + 1
    }).length
    const scroller = [...n.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4)
    return {
      stagesTotal: stages.length,
      stagesOutsidePanel: outside,
      hiddenByScroll: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    }
  })
  console.log('clipping check:', JSON.stringify(clipped))

  // The panel scrolls internally, so one frame shows only the runs that happen to be at the top.
  // A second frame at the bottom is not decoration: without it a reviewer is being asked about
  // content that was never in front of it.
  if (clipped.hiddenByScroll > 0) {
    await page.evaluate(() => {
      const n = document.querySelector('.react-flow__node-pipeline')
      const s = [...n.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4)
      if (s) s.scrollTop = s.scrollHeight
    })
    await sleep(600)
    await shot('pipeline-05-panel-lower')
  }
}

if (errors.length) {
  console.log('\n--- console errors ---')
  for (const e of errors.slice(0, 20)) console.log(e)
} else {
  console.log('\nno console errors')
}
await browser.close()
