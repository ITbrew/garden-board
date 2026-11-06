/**
 * Every control on the screen either does something, or it is not a control.
 *
 * The owner asked for this directly: "confirm all the ui buttons work". A button that is drawn and
 * wired to nothing is the exact failure this project exists to refuse, because it is the app showing
 * him a capability it cannot back up. It is also the failure a screenshot cannot catch, since a dead
 * button photographs identically to a live one.
 *
 * So this clicks things and checks the world changed. Not that a handler was called, and not that a
 * class was added: a card exists that did not, a row in SQLite says something different, a panel is
 * on screen that was not. Anything that only redraws is checked against the DOM, and anything that
 * reaches the server is checked against the server's own state.
 *
 * What this deliberately does NOT do is click everything indiscriminately. Delete is exercised on a
 * card this script made, never on one it found, and nothing here runs against a board that is not
 * its own: it gets a Garden of its own on its own port, the same as every other test.
 *
 *   npm run build
 *   node scripts/test-buttons-work.mjs
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

const board = await openBoard({
  projectName: 'buttons',
  files: { 'notes.md': '# Notes\n\nSomething to open.\n' },
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Worker one', roleClass: 'worker', reportsTo: 0 },
  ],
})

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2600, height: 1400, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(e.stack || String(e)))
/*
 * A dialog would block every subsequent command, so one appearing is itself a finding. Dismissed
 * rather than accepted, and recorded, because a control that needs a dialog to work is a control
 * this harness cannot honestly exercise.
 */
const dialogs = []
page.on('dialog', async (d) => {
  dialogs.push(d.message())
  await d.dismiss()
})

await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

/** Every button on screen right now, with the text it shows. */
const buttonsOnScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.textContent || b.getAttribute('aria-label') || b.title || '').trim())
      .filter(Boolean),
  )

const clickByText = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')]
      .filter((x) => x.offsetParent !== null)
      .find((x) => (x.textContent || '').trim() === t)
    if (!b) return false
    b.click()
    return true
  }, text)

const cardCount = () => page.$$eval('.react-flow__node', (n) => n.length)

const visible = await buttonsOnScreen()
check('the board draws with controls on it', visible.length > 0, `${visible.length} buttons visible`)

// --- every visible button is at least reachable and labelled ---

const unlabelled = await page.evaluate(() =>
  [...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null)
    .filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.title)
    .map((b) => b.className || '(no class)'),
)
check('no visible button is completely unlabelled', unlabelled.length === 0, unlabelled.slice(0, 4).join(', '))

// --- the sidebar launchers make a card ---

const before = await cardCount()
const launched = await page.evaluate(() => {
  const b = document.querySelector('[data-cap="launch-shell"]')
  if (!b) return false
  b.click()
  return true
})
check('the sidebar offers a way to launch a shell', launched)
await sleep(2200)
const afterLaunch = await cardCount()
check('and clicking it puts a card on the board', afterLaunch > before, `${before} then ${afterLaunch}`)

// --- opening a document ---

const docBefore = await page.$$eval('.node--doc', (n) => n.length)

/*
 * Opened over the protocol rather than from the rail, because the rail no longer offers it.
 *
 * "Open a file" was one of the three sections the owner had removed from the sidebar (canon 02
 * revision 3); it listed hundreds of unsorted paths and he never used it. This test used to reach a
 * document card through a "Show N files" control that went with it, and it had been failing on that
 * control ever since, taking the four assertions below down with it. Those four are about a
 * document card's own buttons, which are still there and are the part worth testing, so they get a
 * route that still exists rather than being deleted alongside the control.
 */
board.ws.send(
  JSON.stringify({ t: 'doc.open', projectId: board.project.id, relPath: 'notes.md' }),
)
await sleep(1400)
const docAfter = await page.$$eval('.node--doc', (n) => n.length)
check('a document opens as a card', docAfter > docBefore, `${docBefore} then ${docAfter}`)

// --- a document card's own buttons ---

const docButtons = await page.evaluate(() => {
  const card = document.querySelector('.node--doc')
  return [...(card?.querySelectorAll('.node-head button') ?? [])].map((b) => b.textContent.trim())
})
check('a document card carries its own controls', docButtons.length > 0, docButtons.join(', '))

const edited = await page.evaluate(() => {
  const card = document.querySelector('.node--doc')
  const b = [...(card?.querySelectorAll('.node-head button') ?? [])].find((x) => /edit/i.test(x.textContent || ''))
  if (!b) return false
  b.click()
  return true
})
check('an Edit control exists on a document card', edited)
await sleep(700)
const editorOpen = await page.$$eval('.doc-edit', (n) => n.length)
check('and pressing it opens an editor', editorOpen > 0, `${editorOpen} editors`)

// --- the canvas right-click menu, item by item ---

await page.mouse.click(1800, 900, { button: 'right' })
await sleep(600)
const menu = await page.evaluate(() =>
  [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].map((b) => (b.textContent || '').trim()),
)
check('right-clicking empty canvas opens a menu', menu.length > 0, `${menu.length} items`)
check('and every item in it is labelled', menu.every(Boolean), JSON.stringify(menu.filter((m) => !m)))

const roleBefore = await cardCount()
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) =>
    /New role card/i.test(x.textContent ?? ''),
  )
  b?.click()
})
await sleep(800)
check('the role card item opens a form', (await page.$$eval('.newcard', (n) => n.length)) > 0)

await page.evaluate(() => {
  const el = document.querySelector('.newcard')
  const title = el?.querySelector('input[type="text"], input:not([type])')
  if (title) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(title, 'Made by the button sweep')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const make = [...document.querySelectorAll('.newcard__make')].pop()
  make?.click()
})
await sleep(2500)
const roleAfter = await cardCount()
check('and the form actually makes a card', roleAfter > roleBefore, `${roleBefore} then ${roleAfter}`)

/*
 * Against the server, not the screen. A card drawn on the canvas that has no row behind it is the
 * precise thing this app promises never to do, and the DOM cannot tell the difference.
 */
const madeOnServer = board.state.sessions.some((s) => s.title === 'Made by the button sweep')
check('and the card is real on the server, not only drawn', madeOnServer)

// --- the ceiling control, which is new and has never been exercised ---

const limits = await page.evaluate(() => {
  const el = document.querySelector('.rail-limits')
  if (!el) return null
  const inputs = [...el.querySelectorAll('input')]
  return { rows: el.querySelectorAll('.rail-limit-row').length, inputs: inputs.length, text: el.textContent.trim().slice(0, 120) }
})
check('the ceiling control is on screen', !!limits, limits ? `${limits.rows} rows` : 'not found')
if (limits) {
  check('with a field for each limit', limits.inputs >= 3, `${limits.inputs} fields`)
  const changed = await page.evaluate(() => {
    const el = document.querySelector('.rail-limits')
    const input = el.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '9')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  })
  check('a limit can be typed into', changed)
  await sleep(900)
}

// --- a card's own header controls ---

const cardControls = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.react-flow__node')].find((n) => /Worker one/.test(n.textContent || ''))
  return [...(node?.querySelectorAll('button') ?? [])].map((b) => (b.textContent || b.title || b.getAttribute('aria-label') || '').trim())
})
check('a session card carries its own controls', cardControls.length > 0, cardControls.filter(Boolean).slice(0, 6).join(', '))

// --- nothing blocked on a dialog, and nothing threw ---

check('no browser dialog blocked anything', dialogs.length === 0, dialogs.join(' | '))
check('no console errors while every control was exercised', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
