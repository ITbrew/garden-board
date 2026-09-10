/**
 * Every card can show its conversation, and the choice is the card's rather than the window's.
 *
 * A session card had exactly one body: a miniature of its terminal. That is a picture of drawing
 * instructions, capped at 256 KB, reset by every restart and unreadable the moment a full-screen CLI
 * takes the screen over. The conversation Garden already reads out of the CLI's own transcript was
 * rendered only on subagent cards, so the cards the owner actually works with had no readable record
 * of what was said at all.
 *
 * Three things are checked, and the third is the one that makes it a preference rather than a
 * gesture: the toggle is on the card, it changes what the body draws, and it is still there after
 * the page is reloaded, because it lives in the session row and not in the browser.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const title = `Talker ${Date.now().toString().slice(-6)}`

/*
 * A Claude card, and switched off. The conversation is read from a Claude Code transcript, so a
 * shell card is deliberately not offered the switch at all and would be the wrong subject here. It
 * stays off because nothing in this test needs a process: what is being checked is which body the
 * card draws and whether that choice is stored, and launching a real CLI to look at a panel would
 * spend the owner's money on a rectangle.
 */
const board = await openBoard({ cards: [] })
board.ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: board.project.id,
    adapterId: 'claude',
    title,
    start: false,
  }),
)
await sleep(1500)
const card = board.state.sessions.find((s) => s.title === title)
check('the Claude card was created', !!card)
if (!card) {
  await board.stop()
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless: 'new',
  defaultViewport: { width: 2400, height: 1300 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const bodyKind = () =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.node')].find(
      (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
    )
    if (!node) return 'no card'
    if (node.querySelector('.agent-summary')) return 'chat'
    if (node.querySelector('.mini')) return 'terminal'
    return 'neither'
  }, title)

check('a session card opens on its terminal', (await bodyKind()) === 'terminal', await bodyKind())

/** Press the card's own view toggle, found by what its tooltip offers rather than by position. */
async function pressToggle() {
  return page.evaluate((t) => {
    const node = [...document.querySelectorAll('.node')].find(
      (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
    )
    if (!node) return false
    const btn = [...node.querySelectorAll('button')].find((b) => /Show the (conversation|terminal)/.test(b.title || ''))
    if (!btn) return false
    btn.click()
    return true
  }, title)
}

check('the card offers a way to switch', await pressToggle())
await sleep(1200)
check('and pressing it shows the conversation', (await bodyKind()) === 'chat', await bodyKind())

// The conversation says which silence it is looking at rather than drawing an empty box, which is
// the provenance rule: a card with no transcript must not read as a run that did nothing.
const said = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  return node?.querySelector('.agent-summary')?.textContent?.trim() ?? ''
}, title)
check(
  'and it says why it is empty instead of just being empty',
  said.length > 20,
  said.slice(0, 120),
)

// The whole point of storing it: a reload is a different page, and the card keeps its choice.
await page.reload({ waitUntil: 'networkidle2' })
await sleep(3000)
check('the choice survives a reload', (await bodyKind()) === 'chat', await bodyKind())

// And it is on the session row, not in this browser: a second window sees it too.
const second = await browser.newPage()
await second.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)
const inSecond = await second.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  if (!node) return 'no card'
  return node.querySelector('.agent-summary') ? 'chat' : node.querySelector('.mini') ? 'terminal' : 'neither'
}, title)
check('and a second window agrees', inSecond === 'chat', inSecond)

// --- and the same choice at 1:1 in the dock ---

/*
 * The pane below the canvas is where the owner reads a session properly, so a conversation that only
 * existed as a card miniature would be half the feature. The card is already on `chat` from above,
 * so opening its pane should land on the conversation without being asked twice: the choice belongs
 * to the card, not to the surface drawing it.
 */
// Right-click the card rather than the sidebar's list, which only carries sessions with a process.
const node = await page.$('.react-flow__node')
const box = await node.boundingBox()
await page.mouse.click(box.x + box.width / 2, box.y + 14, { button: 'right' })
await sleep(700)
const openedPane = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.ctxmenu__item')].find(
    (el) => (el.textContent ?? '').trim() === 'Open terminal',
  )
  if (!item) return false
  item.click()
  return true
})
check('the pane opened', openedPane)
await sleep(2500)

const paneKind = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.dock-pane')
    if (!pane) return 'no pane'
    if (pane.querySelector('.agent-summary--dock')) return 'chat'
    if (pane.querySelector('.term-host')) return 'terminal'
    return 'neither'
  })

check('the pane opens on the same view the card is on', (await paneKind()) === 'chat', await paneKind())

const flipped = await page.evaluate(() => {
  const pane = document.querySelector('.dock-pane')
  const btn = [...(pane?.querySelectorAll('button') ?? [])].find((b) => /Show the terminal/.test(b.title || ''))
  if (!btn) return false
  btn.click()
  return true
})
check('the pane offers a way back to the terminal', flipped)
await sleep(2000)
check('and pressing it mounts the terminal', (await paneKind()) === 'terminal', await paneKind())

// Switching the pane switched the card too, because there is one stored choice rather than two.
check('and the card followed, since the choice is the card\'s', (await bodyKind()) === 'terminal', await bodyKind())

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
