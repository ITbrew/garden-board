/**
 * Proves the owner can click into a message card, edit the file, and have it saved as he types.
 *
 * His ask was two steps. First "an edit function where i can click into the window to edit the file
 * right on the card", then "make the message card auto-save instead of requiring button press, which
 * should also work better with messages being sent during edits", and finally "remove save button".
 *
 * That last clause is the interesting one and it is what most of this file checks. With a button, a
 * card replying mid-edit was a refusal: the file had moved underneath, so the write was turned away
 * and he was told why. Auto-saving makes a refusal useless, because it would fire every time he
 * paused typing. The card at the other end only ever appends, so what is on disk beginning with the
 * bytes he started from means everything past that point is new, and it belongs on the end of his
 * copy. Both survive and nothing is inferred.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Orchestrator'] })
const card = board.cards[0]
const channels = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'channel.added' || m.t === 'channel.updated') channels.push(m.channel)
})
board.ws.send(JSON.stringify({ t: 'channel.create', projectId: board.project.id, x: 620, y: 60 }))
await sleep(1000)
const channel = channels[0]
board.ws.send(
  JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: channel.id, targetId: card.id }),
)
await sleep(1500)
const notes = join(board.home, 'mail', card.id, 'NOTES.md')

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1700, height: 1100 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const editorText = () => page.evaluate(() => document.querySelector('.channel-edit__text')?.value ?? null)
const notes_ = () => page.evaluate(() => [...document.querySelectorAll('.channel-note')].map((n) => n.textContent).join(' | '))
/** Type into the editor the way a person does, so the debounce and the change events are real. */
const type = (s) => page.type('.channel-edit__text', s, { delay: 12 })

await page.click('.channel-log')
await sleep(600)
check('clicking the conversation opens the file for editing', (await editorText()) !== null)
check(
  'and it is the file itself, not the conversation as drawn',
  (await editorText())?.startsWith('# Notes between the owner'),
  (await editorText())?.split('\n')[0],
)
/*
 * Scoped to the card, because the board has a save of its own.
 *
 * A first version scanned every button on the page and failed on the sidebar's "Save board", which
 * is a real control that has nothing to do with this one. The claim being made is about the message
 * card, so the question has to be asked of the message card.
 */
check(
  'there is no save button on the card to press',
  await page.evaluate(
    () => ![...document.querySelectorAll('.channel button, .channel-edit button')].some((b) => /save/i.test(b.textContent)),
  ),
  await page.evaluate(() =>
    [...document.querySelectorAll('.channel button, .channel-edit button')].map((b) => b.textContent.trim()).join(', '),
  ),
)

// --- typing alone writes the file ------------------------------------------------------------------

const EDIT = 'A line the owner typed straight into the card.'
await page.focus('.channel-edit__text')
await page.evaluate(() => {
  const ta = document.querySelector('.channel-edit__text')
  ta.setSelectionRange(ta.value.length, ta.value.length)
})
await type(`\n${EDIT}\n`)
// Past the debounce, with room for the round trip. Nothing was clicked.
await sleep(2500)

check('typing alone writes it to the file, with nothing pressed', readFileSync(notes, 'utf8').includes(EDIT))
check(
  'and the card says the save was confirmed rather than assumed',
  /saved \d/.test(await notes_()),
  await notes_(),
)

// --- and the card replying mid-edit keeps both --------------------------------------------------

const REPLY = 'The card answered while he was still typing.'
appendFileSync(notes, `\n## Orchestrator, now\n\n${REPLY}\n`, 'utf8')
// The server polls once a second, so this is the push arriving while the editor is open.
await sleep(2500)

check(
  'a reply arriving mid-edit appears in the editor rather than being lost',
  (await editorText())?.includes(REPLY),
  (await editorText())?.includes(REPLY) ? 'folded into what he is editing' : 'the editor never saw it',
)

const MORE = 'And another line after the reply arrived.'
await page.focus('.channel-edit__text')
await page.evaluate(() => {
  const ta = document.querySelector('.channel-edit__text')
  ta.setSelectionRange(ta.value.length, ta.value.length)
})
await type(`${MORE}\n`)
await sleep(2500)

const onDisk = readFileSync(notes, 'utf8')
check('carrying on typing does not erase the reply', onDisk.includes(REPLY), `${onDisk.length} bytes`)
check('and the earlier edit is still there', onDisk.includes(EDIT))
check('and so is the new one', onDisk.includes(MORE))
check(
  'and nothing was reported as a conflict, because nothing was lost',
  !/rewritten|not saved/i.test(await notes_()),
  await notes_(),
)

// --- closing the editor leaves the file as he left it ---------------------------------------------

await page.keyboard.press('Escape')
await sleep(1200)
check('escape closes the editor', (await editorText()) === null)
check('and what he typed is still on disk', readFileSync(notes, 'utf8').includes(MORE))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
