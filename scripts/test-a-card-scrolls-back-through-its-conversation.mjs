/**
 * A Claude card's conversation scrolls back through all of it.
 *
 * Since canon 02 revision 12 a Claude card opens on its terminal, at the owner's word ("i dont like
 * the conversational view"), so the card here is turned to its conversation first, the way he would
 * with the card's toggle. Everything below is about the conversation once it is showing.
 *
 * The owner, 2026-09-29: "the cards should also be scrollable the same way terminals are. currently
 * it only lets me scroll to the size of the window instead of the conversatioln". A Claude card's
 * terminal holds one screen and can hold no more, because the CLI repaints in place and never prints
 * a line that scrolls, so the conversation is read from the transcript instead, a page at a time
 * from the end. Canon 02 revision 10.
 *
 * What is held here, each because it is a way this can fail while looking fine:
 *
 * - The card shows the conversation it was turned to, and a shell card still shows its terminal.
 * - It opens at the newest turn and not the first, since a finished run's conclusion is at the end.
 * - Scrolling up reaches the first thing ever said, across many pages, and says it is the start.
 * - The row being read stays put on screen while older rows are added above it.
 * - A new turn arriving while he is scrolled back neither drops the older pages nor drags him down.
 *   That was two separate bugs: the push replaced the list with the last sixty turns, and the pane
 *   pinned itself to the bottom on every update whatever the list held.
 *
 * The transcript is a fixture and the path reaches the card through a real `Stop` hook posted to the
 * instance, which is exactly how a live CLI delivers it. No CLI is started and nothing is spent.
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({
  cards: [{ title: 'Talker', adapterId: 'claude' }, { title: 'Plain shell' }],
  projectName: 'scrollback',
})
const talker = board.cards[0]
const shell = board.cards[1]
check('a Claude card exists to test on', !!talker && talker.adapterId === 'claude', talker?.adapterId)

/*
 * Four hundred exchanges, so eight hundred turns, which is thirteen or more pages at sixty. Enough
 * that reaching the start proves paging rather than one lucky read. The first and last are worded so
 * they cannot be mistaken for any row in between.
 */
const transcript = join(board.dir, 'fixture-transcript.jsonl')
const line = (i, role, text) =>
  JSON.stringify({
    type: role,
    timestamp: new Date(Date.UTC(2026, 8, 29, 9, 0, i)).toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  }) + '\n'
let body = ''
for (let i = 1; i <= 400; i++) {
  body += line(i * 2, 'user', i === 1 ? 'the very first question' : `question number ${i}`)
  body += line(i * 2 + 1, 'assistant', i === 400 ? 'the most recent answer' : `answer number ${i}`)
}
writeFileSync(transcript, body, 'utf8')

/** Deliver a `Stop` for the card, the hook a live CLI sends when a turn ends. */
const stop = () =>
  fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `receivedAt` is part of every real hook body; without it the server records the event with no
    // time and refuses it, which is a hook this test made up rather than one a CLI would send.
    body: JSON.stringify({
      gardenSessionId: talker.id,
      receivedAt: Date.now(),
      event: { hook_event_name: 'Stop', session_id: 'fixture-session', transcript_path: transcript },
    }),
  })
await stop()
await sleep(1500)
board.ws.send(JSON.stringify({ t: 'session.setBodyView', sessionId: talker.id, bodyView: 'chat' }))
await sleep(600)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/** Everything a test needs to know about one card's body, read from the DOM. */
const body_ = (title) =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.node')].find(
      (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
    )
    if (!node) return null
    const pane = node.querySelector('.agent-summary')
    const text = pane?.innerText ?? ''
    return {
      conversation: !!pane,
      terminal: !!node.querySelector('.mini'),
      text,
      rows: pane ? pane.querySelectorAll('.agent-summary__row').length : 0,
      scrollTop: pane?.scrollTop ?? 0,
      atBottom: pane ? pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24 : false,
      start: text.includes('Start of this conversation.'),
    }
  }, title)

const first = await body_('Talker')
check('the Claude card turned to its conversation shows it', first?.conversation === true)
check('a shell card still opens on its terminal', (await body_('Plain shell'))?.terminal === true)
check('it opens at the newest turn', first?.text.includes('the most recent answer') === true)
check('and not at the first', first?.text.includes('the very first question') === false)
check('nor does it claim to be at the start yet', first?.start === false)

/*
 * With the mouse wheel, over the card on the board, which is how he scrolls. Everything after this
 * moves the pane by setting its position, and that never goes near the canvas, which also listens
 * for the wheel: "i still cant hover my mouse to scroll conversation your card either".
 */
const paneBox = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  const r = node?.querySelector('.agent-summary')?.getBoundingClientRect()
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, top: node.querySelector('.agent-summary').scrollTop } : null
}, 'Talker')
const zoomBefore = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '')
await page.mouse.move(paneBox.x, paneBox.y)
await page.mouse.wheel({ deltaY: -400 })
await sleep(600)
const wheeled = await body_('Talker')
const zoomAfter = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '')
check('the mouse wheel over the card scrolls its conversation', wheeled.scrollTop < paneBox.top - 100, `scrollTop ${paneBox.top} -> ${wheeled.scrollTop}`)
check('and does not zoom or pan the board instead', zoomBefore === zoomAfter, `${zoomBefore} -> ${zoomAfter}`)
await page.mouse.move(5, 5)

/** Scroll the card's conversation to its top, the way the wheel would, and wait for an answer. */
const toTop = (title) =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.node')].find(
      (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
    )
    const pane = node?.querySelector('.agent-summary')
    if (!pane) return null
    pane.scrollTop = 0
    pane.dispatchEvent(new Event('scroll'))
    const top = pane.querySelector('.agent-summary__row:not(.agent-summary__edge)')
    /*
     * The TEXT, not the row. Every row after the first carries a border and padding above it, so the
     * row that was first gains seven pixels inside its own box the moment older rows arrive above
     * it: its edge moves up while its words stay put. Measuring the edge failed by exactly seven for
     * a pane that had not moved anything a person reads.
     */
    const words = top?.lastElementChild
    return { text: top?.innerText ?? '', y: words ? words.getBoundingClientRect().top : 0 }
  }, title)

/*
 * The row being read stays where it was. Taken on the first scroll up: the top row is noted, the
 * page above arrives, and that same row should be in the same place on screen rather than having
 * been shoved down by everything added above it.
 */
const before = await toTop('Talker')
await sleep(1200)
const after = await page.evaluate(
  (t, want) => {
    const node = [...document.querySelectorAll('.node')].find(
      (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
    )
    const row = [...(node?.querySelectorAll('.agent-summary__row') ?? [])].find((r) => r.innerText === want)
    return row?.lastElementChild ? row.lastElementChild.getBoundingClientRect().top : null
  },
  'Talker',
  before?.text,
)
check(
  'the words being read stay put while older rows are added above them',
  after !== null && Math.abs(after - before.y) <= 4,
  `was at ${before?.y?.toFixed(0)}px, now ${after === null ? 'gone' : after.toFixed(0) + 'px'}`,
)

// Keep going up until the start, or give up after far more pages than the fixture has.
let reached = false
let scrolls = 1
for (; scrolls < 40 && !reached; scrolls++) {
  await toTop('Talker')
  await sleep(700)
  reached = (await body_('Talker'))?.start === true
}
const top = await body_('Talker')
check('scrolling up reaches the start of the conversation', reached, `after ${scrolls} scrolls, ${top?.rows} rows`)
check('and the first thing said is there', top?.text.includes('the very first question') === true)
check('with the newest still held below it', top?.text.includes('the most recent answer') === true)
check('every exchange is held once', (top?.text.match(/answer number 2\b/g) ?? []).length === 1)

/*
 * The snap-back, both halves of it. Scrolled well away from the bottom, a new turn arrives through
 * a real `Stop`. It must be added, the older pages must still be there, and he must not be moved.
 */
await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  const pane = node?.querySelector('.agent-summary')
  pane.scrollTop = 600
  pane.dispatchEvent(new Event('scroll'))
}, 'Talker')
await sleep(300)
const held = (await body_('Talker'))?.scrollTop
appendFileSync(transcript, line(900, 'user', 'a question asked just now') + line(901, 'assistant', 'a brand new answer'), 'utf8')
// Past the server's once-per-five-seconds limit on reading a card's transcript.
await sleep(5600)
await stop()
await sleep(2500)
const later = await body_('Talker')
check('a new turn arriving is added', later?.text.includes('a brand new answer') === true)
check('without dropping what he had scrolled back through', later?.text.includes('the very first question') === true)
check('and without dragging him to the bottom', later && Math.abs(later.scrollTop - held) <= 4, `was ${held}, now ${later?.scrollTop}`)

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
