/**
 * Proves a long line typed into a card arrives in the order it was typed.
 *
 * The owner's report: "when i type a long message into a card, it resets my cursor to the middle of
 * the input field of the card". That is the signature of a controlled input inside an expensive
 * render. The value lives in the card's own state, so every keystroke re-renders the whole card,
 * preview and subagent list included; when a render lands late React writes the lagging value back
 * into the DOM and the caret goes to the end of THAT, which is somewhere in the middle of what he
 * actually typed. Every character after that point lands in the wrong place.
 *
 * So this types a long line fast, the way he does, and asks the field what it holds. Nothing about
 * caret position is asserted directly: the caret is the mechanism, and the damage is the text.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Typing'] })
const card = board.cards[0]
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(3000)

/*
 * The card has to be PRINTING while he types, or none of this happens.
 *
 * A first run of this test typed into an idle card and passed cleanly, which is the wrong answer
 * arrived at honestly: an idle card renders once and a controlled input in a tree that is not
 * re-rendering cannot fall behind. His cards are working while he talks to them, and the miniature
 * on every one of them redraws several times a second off the byte stream. That is the render this
 * input is losing races with, so the test has to produce it.
 */
board.ws.send(
  JSON.stringify({
    t: 'session.input',
    sessionId: card.id,
    data: 'while($true){ Get-Date -Format o; Start-Sleep -Milliseconds 40 }' + String.fromCharCode(13),
  }),
)
await sleep(4000)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/*
 * A line as long as the ones he writes, with position markers in it.
 *
 * Every tenth character is a digit that says how far in it is, so a failure report says WHERE the
 * text was disturbed rather than only that it was. A scrambled result is far easier to read that
 * way than a wall of letters.
 */
const LINE =
  'Take the loader screen and leave the sim half alone, 0123456789 the route lines are ' +
  'code-fixed but visually unverified, 9876543210 and the label row is fixed except for a part ' +
  'that was never a board bug at all.'

const field = '.node-input input'
await page.waitForSelector(field)
await page.click(field)
// Fast enough to outrun a slow render, which is the whole point. A person typing a sentence they
// have already composed goes at about this rate.
await page.type(field, LINE, { delay: 8 })
await sleep(1200)

/*
 * And now the board changes underneath him, which is his own theory of the bug.
 *
 * "is it something thats unselecting the card so that my typing stops?" A card is redrawn from the
 * server on every status change, and the canvas re-sorts what it draws when cards come and go. If
 * that moves the card's element in the DOM, the browser blurs whatever was focused inside it, the
 * rest of the keystrokes go nowhere, and clicking back in leaves the caret wherever it stopped.
 * Which is exactly "it resets my cursor to the middle of the input field".
 *
 * So: type half, make the board move, type the rest, and ask who has the focus.
 */
const HALF = Math.floor(LINE.length / 2)
const focusedNow = () =>
  page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || ''}` : 'none'
  })

board.ws.send(
  JSON.stringify({ t: 'session.create', projectId: board.project.id, adapterId: 'shell', title: 'Interloper', start: true }),
)
await sleep(2500)

const heldFocus = await focusedNow()
check(
  'the input still has the focus after a card appears on the board',
  heldFocus.startsWith('input'),
  `focus is on ${heldFocus}`,
)

await page.keyboard.type(' and the rest of it.', { delay: 8 })
await sleep(800)

const got = await page.evaluate((sel) => document.querySelector(sel)?.value ?? '', field)

const WHOLE = LINE + ' and the rest of it.'
check('the whole line is there', got.length === WHOLE.length, `${got.length} characters, typed ${WHOLE.length}`)
check(
  'and it is in the order it was typed',
  got === WHOLE,
  got === WHOLE
    ? 'exactly as written'
    : `stops at character ${got.length} of ${WHOLE.length}: "${got.slice(-50)}"`,
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
