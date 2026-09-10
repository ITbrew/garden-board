/**
 * Two shots of the same card's history: replayed at the size it was drawn at, and at another one.
 *
 * The owner's report is visual and has been for weeks: "columns overlapping/erasing words". No
 * number settles that. What settles it is a card on a board, photographed, handed to somebody who
 * has not seen this code.
 *
 * The card runs a fixture that draws the way every full-screen CLI draws: it wraps at the width it
 * was told and then moves the cursor back up to rewrite a line it has already printed. At the right
 * width the rewrite lands on the status line it was aimed at. At any other width it lands on the
 * data instead.
 *
 * The two shots differ by one thing only: whether the geometry Garden recorded beside the scrollback
 * is there to be read. Deleting it puts the server back on the spawn constants, which is exactly
 * what it answered with before this was fixed, so `01` is the old behaviour and `02` is the new one,
 * from one run of one build.
 *
 *   npm run build
 *   node scripts/capture-smear.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.SHOT_DIR || join(ROOT, 'docs', 'shots', 'smear')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const COLS = 100
const ROWS = 24

const board = await openBoard({ cards: [{ title: 'History' }] })
const card = board.cards[0]

/*
 * A hundred As, then words, then a rewrite one row up. At 100 columns the As fill the row exactly
 * and the words are a second row, so the rewrite replaces the words. At 120 they are all one row and
 * the same rewrite eats eleven characters of the data.
 */
writeFileSync(
  join(board.dir, 'draw.mjs'),
  [
    `const W = ${COLS}`,
    "process.stdout.write('\\u001b[2J\\u001b[H')",
    "process.stdout.write('A'.repeat(W) + 'a status line')",
    "process.stdout.write('\\r\\n')",
    "process.stdout.write('the answer itself, which is what he is reading')",
    "process.stdout.write('\\u001b[1A\\r')",
    "process.stdout.write('REWRITTEN..')",
    "process.stdout.write('\\u001b[2B\\r\\n')",
  ].join('\n'),
  'utf8',
)

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(2500)
board.ws.send(JSON.stringify({ t: 'session.resize', sessionId: card.id, cols: COLS, rows: ROWS }))
await sleep(800)
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'node draw.mjs\r' }))
await sleep(2500)
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(2000)

const sizeFile = join(board.home, 'scrollback', `${card.id}.size.json`)
const logFile = join(board.home, 'scrollback', `${card.id}.log`)
console.log('size file:', existsSync(sizeFile) ? 'written' : 'MISSING', sizeFile)
console.log('log file :', existsSync(logFile) ? `${readFileSync(logFile, 'utf8').length} bytes` : 'MISSING')
console.log('fixture drew:', existsSync(logFile) && readFileSync(logFile, 'utf8').includes('A'.repeat(40)) ? 'yes' : 'NO')
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1800, height: 1100, deviceScaleFactor: 1 },
  args: ['--window-size=1800,1100', '--force-device-scale-factor=1'],
})

const shoot = async (name, what) => {
  const page = await browser.newPage()
  await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
  await sleep(3500)
  // The card, not the whole board: the question is what one card's history looks like.
  const node = await page.$(".react-flow__node .node")
  await (node ?? page).screenshot({ path: join(OUT, `${name}.png`) })
  /*
   * And the same card's text, read out of the DOM.
   *
   * Not a substitute for the picture, which is the thing somebody else has to judge. This is here
   * because a capture that photographs the wrong element, or an empty one, looks exactly like a
   * capture that photographs a card with nothing wrong with it.
   */
  const text = await page.evaluate(() => {
    const el = document.querySelector(".mini")
    return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 180) : '(no preview element)'
  })
  await page.close()
  console.log('shot:', join(OUT, `${name}.png`), '--', what)
  console.log('      card reads:', text)
}

// Without the record, the server falls back to the size a session is spawned at, which is what it
// always did.
const kept = existsSync(sizeFile)
if (kept) rmSync(sizeFile)
await shoot('01-without-the-recorded-size', 'history replayed at the spawn size')

writeFileSync(sizeFile, JSON.stringify({ cols: COLS, rows: ROWS }), 'utf8')
await shoot('02-with-the-recorded-size', 'the same history replayed at the size it was drawn at')

writeFileSync(
  join(OUT, 'INDEX.md'),
  [
    '# What each shot is',
    '',
    'One card, one recorded history, photographed twice. Nothing between them changed except',
    'whether the size the process was drawing at was available to read.',
    '',
    '- `01-without-the-recorded-size.png`',
    '- `02-with-the-recorded-size.png`',
    '',
  ].join('\n'),
  'utf8',
)

await browser.close()
await board.stop()
