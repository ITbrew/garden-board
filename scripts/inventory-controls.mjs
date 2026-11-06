/**
 * Every control the page offers, read off a running board. Canon 14 revision 12.
 *
 * The full suite is one test per control, so the list of controls has to come from the page rather
 * than from memory. This starts its own Garden with a small board (a running shell card, a card that
 * is off, a document card, a wire), then records every button, field and link it can see, opens each
 * right-click menu (board, card, wire, tab) and each submenu, and writes what it found with each
 * control's label, tooltip and where it sits.
 *
 * It only reads. What a control DOES is not decided here: that comes from canon, in the expectation
 * table built from this list.
 *
 *   npm run build && node scripts/inventory-controls.mjs [out.json]
 */
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = process.argv[2] ?? 'controls-inventory.json'

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({ projectName: 'inventory', cards: ['Running card', 'Off card'], files: { 'notes.md': '# Notes\n' } })
const [running, offCard] = board.cards
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: running.id }))
board.ws.send(JSON.stringify({ t: 'doc.create', projectId: board.project.id, relPath: 'notes.md', openIfExists: true }))
await sleep(1500)
board.ws.send(JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: running.id, targetId: offCard.id }))
await sleep(1500)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1700, height: 1000 },
})
const page = await browser.newPage()
await page.goto(board.UI, { waitUntil: 'networkidle2' })
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await sleep(2500)

const found = new Map()
const record = (items, how) => {
  for (const c of items) {
    const key = `${c.where} | ${c.kind} | ${c.label}`
    if (!found.has(key)) found.set(key, { ...c, seenBy: how })
  }
}

/** Everything clickable or editable on screen, with where it sits. */
const scan = () =>
  page.evaluate(() => {
    const region = (el) => {
      const pairs = [
        ['.ctxmenu--sub', 'submenu'],
        ['.ctxmenu', 'menu'],
        ['.topbar', 'top bar'],
        ['.project-tabs, .tabs', 'tabs'],
        ['.terminal-dock, .dock', 'terminal pane'],
        ['.react-flow__node-session', 'agent card'],
        ['.react-flow__node-doc', 'document card'],
        ['.react-flow__node', 'board item'],
        ['.react-flow__controls', 'zoom controls'],
        ['.react-flow__minimap', 'minimap'],
        ['.sidebar, aside', 'sidebar'],
        ['.react-flow', 'board'],
      ]
      for (const [sel, name] of pairs) if (el.closest(sel)) return name
      return 'page'
    }
    const section = (el) => {
      const s = el.closest('section, .panel, .side-section, [class*="panel"]')
      const h = s?.querySelector('h1,h2,h3,h4,.section-title,.panel-title,[class*="title"]')
      return h?.textContent?.trim().slice(0, 40) ?? ''
    }
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const sel = 'button, [role="button"], [role="menuitem"], .ctxmenu__item, input, select, textarea, a[href], [contenteditable="true"], .react-flow__handle, .react-flow__resize-control'
    return [...document.querySelectorAll(sel)].filter(vis).map((el) => {
      const kind = el.matches('.ctxmenu__item, [role="menuitem"]')
        ? 'menu item'
        : el.matches('.react-flow__handle')
          ? 'wire handle'
          : el.matches('.react-flow__resize-control')
            ? 'resize handle'
            : el.tagName === 'INPUT'
              ? `field (${el.type})`
              : el.tagName === 'SELECT'
                ? 'dropdown'
                : el.tagName === 'TEXTAREA'
                  ? 'text box'
                  : el.tagName === 'A'
                    ? 'link'
                    : 'button'
      const text = (el.querySelector?.('.ctxmenu__label')?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
      const label =
        text ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (el.matches('.react-flow__handle') ? `${el.dataset.handlepos ?? ''} ${el.dataset.handleid ?? ''}`.trim() : '') ||
        (el.matches('.react-flow__resize-control') ? [...el.classList].find((c) => /top|bottom|left|right/.test(c)) ?? 'edge' : '') ||
        el.className.toString().split(' ')[0]
      return {
        where: region(el),
        section: section(el),
        kind,
        label: label.slice(0, 80),
        tooltip: (el.getAttribute('title') ?? '').slice(0, 200),
        hint: (el.querySelector?.('.ctxmenu__hint')?.textContent ?? el.getAttribute('placeholder') ?? '').slice(0, 120),
        disabled: !!(el.disabled || el.classList.contains('is-disabled')),
      }
    })
  })

record(await scan(), 'the board as it opens')

/** Open a right-click menu, record it and each submenu, then close it. */
const menuAt = async (x, y, how) => {
  await page.mouse.click(x, y, { button: 'right' })
  await sleep(400)
  record(await scan(), how)
  const arrows = await page.$$('.ctxmenu:not(.ctxmenu--sub) > .ctxmenu__item')
  for (const item of arrows) {
    const hasSub = await item.$('.ctxmenu__arrow')
    if (!hasSub) continue
    await item.hover()
    await sleep(300)
    record(await scan(), `${how}, submenu`)
  }
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 995)
  await sleep(300)
}

// A point where nothing but the board itself is under the pointer.
const empty = await page.evaluate(() => {
  for (let y = 150; y < 950; y += 40)
    for (let x = 400; x < 1650; x += 40) {
      const el = document.elementFromPoint(x, y)
      if (el?.classList.contains('react-flow__pane')) return { x, y }
    }
  return null
})
if (empty) await menuAt(empty.x, empty.y, 'right-click on the empty board')
else console.log('no empty point on the board was found')
const plus = await page.$('.tabs button[title^="Open a project folder"], button[title^="Open a project folder"]')
if (plus) {
  const b = await plus.boundingBox()
  await menuAt(b.x + b.width / 2, b.y + b.height / 2, 'right-click on the + tab button')
}

for (const [what, id] of [['a running card', running.id], ['a card that is off', offCard.id]]) {
  const head = await page.$(`.react-flow__node[data-id="${id}"] .node-head`)
  if (!head) continue
  const hb = await head.boundingBox()
  await menuAt(hb.x + hb.width / 2, hb.y + hb.height / 2, `right-click on ${what}`)
}
const doc = await page.$('.react-flow__node-doc')
if (doc) {
  const db = await doc.boundingBox()
  await menuAt(db.x + db.width / 2, db.y + 12, 'right-click on a document card')
}
const edge = await page.$('.react-flow__edge-interaction, .react-flow__edge path')
if (edge) {
  const eb = await edge.boundingBox()
  await menuAt(eb.x + eb.width / 2, eb.y + eb.height / 2, 'right-click on a wire')
}
const tab = await page.$('.project-tab, .tabs [role="tab"], .tab')
if (tab) {
  const tb = await tab.boundingBox()
  await menuAt(tb.x + tb.width / 2, tb.y + tb.height / 2, 'right-click on a tab')
}

// The terminal pane, opened from the running card's own menu item.
const head = await page.$(`.react-flow__node[data-id="${running.id}"] .node-head`)
if (head) {
  const hb = await head.boundingBox()
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2, { button: 'right' })
  await sleep(400)
  const items = await page.$$('.ctxmenu__item')
  for (const it of items) {
    if ((await it.evaluate((e) => e.textContent)).includes('Open terminal')) {
      await it.click()
      break
    }
  }
  await sleep(2000)
  record(await scan(), 'with the terminal pane open')
  const before = found.size
  console.log(`terminal pane added ${before} total so far`)
}

const closePane = await page.$('button[title^="Close this pane"]')
if (closePane) await closePane.click()
await sleep(500)

/** Click a menu item by its label in a right-click menu opened at (x, y). */
const choose = async (x, y, label, sub) => {
  await page.mouse.click(x, y, { button: 'right' })
  await sleep(400)
  for (const it of await page.$$('.ctxmenu__item')) {
    if ((await it.evaluate((e) => e.querySelector('.ctxmenu__label')?.textContent ?? e.textContent)).trim() !== label) continue
    if (sub) {
      await it.hover()
      await sleep(300)
      for (const s of await page.$$('.ctxmenu--sub .ctxmenu__item'))
        if ((await s.evaluate((e) => e.textContent)).includes(sub)) {
          await s.click()
          return true
        }
    } else {
      await it.click()
      return true
    }
  }
  await page.keyboard.press('Escape')
  return false
}

// The other kinds of card, each made the way the owner makes it, from the board's menu.
for (const label of ['New message card', 'New role card', 'Create To Do Card', 'New markdown file']) {
  const p = await page.evaluate(() => {
    for (let y = 150; y < 950; y += 40)
      for (let x = 400; x < 1650; x += 40)
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    return null
  })
  if (!p) break
  const ok = await choose(p.x, p.y, label)
  await sleep(1500)
  record(await scan(), `after ${label}`)
  if (ok) await page.keyboard.press('Escape')
  await sleep(300)
}

// Dialogs a control opens, and the pills above and below a card.
const openAndScan = async (selector, how) => {
  const el = await page.$(selector)
  if (!el) return console.log(`not found: ${how}`)
  await el.click()
  await sleep(1200)
  record(await scan(), how)
  await page.keyboard.press('Escape')
  await sleep(400)
}
const card = `.react-flow__node[data-id="${running.id}"]`
await openAndScan(`${card} button[title^="History"]`, 'with the history pill open')
await openAndScan(`${card} button[title^="Roots"]`, 'with the roots pill open')
await openAndScan(`${card} button[title^="Rename"]`, 'renaming a card')
await openAndScan('button[title^="Save where every card"]', 'saving a layout')
const edge2 = await page.$('.react-flow__edge-interaction, .react-flow__edge path')
if (edge2) {
  const eb = await edge2.boundingBox()
  if (await choose(eb.x + eb.width / 2, eb.y + eb.height / 2, 'Add label')) {
    await sleep(800)
    record(await scan(), 'adding a label to a wire')
    await page.keyboard.press('Escape')
  }
}

const rows = [...found.values()].sort((a, b) => (a.where + a.section + a.kind + a.label).localeCompare(b.where + b.section + b.kind + b.label))
writeFileSync(OUT, JSON.stringify(rows, null, 2))
console.log(`${rows.length} controls`)
const by = {}
for (const r of rows) by[r.where] = (by[r.where] ?? 0) + 1
console.log(by)

await browser.close()
await board.stop()
process.exit(0)
