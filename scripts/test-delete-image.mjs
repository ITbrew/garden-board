/**
 * Reproduces "right click delete isn't working for images": right-clicks an image card, takes the
 * remove entry, and checks the card is actually gone.
 *
 * The menu item and its confirmation have both changed since this was first written. It used to
 * read "Delete" and ask for confirmation; it now reads "Remove from the board" and asks nothing,
 * on purpose (Canvas.tsx:1109-1139): a browser stops honouring `confirm()` once the owner has
 * ticked "prevent this page from creating additional dialogs", so the old dialog made Delete
 * silently do nothing with no error anywhere, and removing a doc card is not destructive in the
 * first place, since the file on disk is untouched. The check that matters, that the card is
 * actually gone afterwards, is unchanged.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A 1x1 PNG, real bytes rather than a text file wearing a .png extension. The delete path this
// test is chasing lives entirely in the card's own menu and never reads a pixel, but an image
// card that fails to decode is still a card that draws differently, and this rules that out.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const board = await openBoard({ projectName: 'delete-image' })
const UI = board.UI

// openBoard's `files` option writes straight into the project root and does not make
// subdirectories, so the assets folder is made here before the file lands in it.
mkdirSync(join(board.dir, 'assets'), { recursive: true })
writeFileSync(join(board.dir, 'assets', 'garden.png'), PNG_1PX)
board.ws.send(JSON.stringify({ t: 'doc.open', projectId: board.project.id, relPath: 'assets/garden.png' }))
await sleep(1200)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 3840, height: 1600, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
// A dialog here would now mean the old confirm() crept back in, which browsers silently ignore
// once "prevent additional dialogs" is ticked, and which is what made this menu item look broken
// in the first place. Accept it if it shows up so it cannot hang the test, and note that it did.
let dialogSeen = false
page.on('dialog', async (d) => {
  dialogSeen = true
  await d.accept()
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const before = await page.$$eval('.node--doc', (n) => n.length)
const img = await page.$('.node--doc .doc-icon--img')
check('an image card is on the board', !!img)
if (!img) {
  await browser.close()
  await board.stop()
  process.exit(1)
}

// Right-click the image card's header, the way a person would.
const box = await (await img.evaluateHandle((el) => el.closest('.react-flow__node'))).asElement().boundingBox()
await page.mouse.click(box.x + box.width / 2, box.y + 12, { button: 'right' })
await sleep(700)

const menuOpen = await page.$('.ctxmenu')
check('the right-click menu opened on an image card', !!menuOpen)

const items = await page.$$eval('.ctxmenu__item .ctxmenu__label', (n) => n.map((e) => e.textContent))
console.log('   menu items:', items.join(' | '))
check('the menu offers Remove from the board', items.some((t) => t === 'Remove from the board'))

const removeItem = await page.evaluateHandle(() => {
  const el = [...document.querySelectorAll('.ctxmenu__item')].find(
    (n) => n.querySelector('.ctxmenu__label')?.textContent === 'Remove from the board',
  )
  return el || null
})
const remove = removeItem.asElement()
if (remove) {
  await remove.click()
  await sleep(1200)
}

check('removing a doc card asks nothing, on purpose', !dialogSeen)
const after = await page.$$eval('.node--doc', (n) => n.length)
check('the image card was removed', after === before - 1, `${before} -> ${after}`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
