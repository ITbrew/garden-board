/**
 * The same geometry question, asked of a real CLI drawing a real box.
 *
 * `test-terminal-geometry.mjs` asks it of a shell printing wrapped lines, and could not make the
 * fault appear on either build. The suspicion that produced this file: a shell that prints and stops
 * may simply not produce a stream where wrapping and cursor movement interact hard enough to
 * corrupt, while the owner's report is about Claude sessions, where a composer repaints its own box
 * on every keystroke and every resize. A full-screen TUI is a far harsher test of replay geometry.
 *
 * NO PROMPT IS EVER SENT. The CLI is launched, allowed to paint its interface, and stopped. That is
 * enough to fill the buffer with box drawing and cursor addressing, and it spends nothing: the
 * account is the owner's money and a test has no business spending it to look at a rectangle.
 *
 * WHERE THIS MUST RUN, and it asserts it rather than trusting it. The owner's live window is served
 * by Vite straight out of `C:\Garden\apps\web\src`, so flipping a source file there to get a
 * red-first result hot-reloads his app into the broken build. That is not a hypothetical: it is what
 * this task did to him before the rule was extended. Canon 14 says a test gets its own database and
 * its own port; the same reasoning covers the files the dev server is watching, and the check below
 * is the source-side equivalent of `/health` reporting zero sessions on the scratch port.
 */
import puppeteer from 'puppeteer-core'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = 'C:\\Garden'
check(
  'this test is NOT running out of the checkout the dev server watches',
  ROOT.toLowerCase() !== LIVE.toLowerCase(),
  `running from ${ROOT}`,
)
if (ROOT.toLowerCase() === LIVE.toLowerCase()) {
  console.log('\nRefusing to continue: flipping source here would hot-reload the owner\'s window.')
  process.exit(1)
}

const SPAWN_COLS = 120
const WINDOW = { width: 700, height: 760 }

const board = await openBoard({ projectName: 'termgeom-tui' })

// A real CLI rather than a shell, created directly so the adapter can be chosen.
board.ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: board.project.id,
    adapterId: 'claude',
    title: 'Composer',
    start: true,
  }),
)
await sleep(20000)

const card = board.state.sessions.find((s) => s.title === 'Composer')
check('the CLI card exists', !!card, card ? `pid ${card.pid}` : 'no card')
if (!card) {
  await board.stop()
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [`--window-size=${WINDOW.width},${WINDOW.height}`, '--no-sandbox'],
  defaultViewport: WINDOW,
})

try {
  const page = await browser.newPage()
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  await sleep(6000)

  /*
   * The reference, read while the process is still live. The preview was given the geometry before
   * any of this work, so it is the known-correct rendering of this byte stream.
   */
  const preview = await page.$$eval('.mini-row', (els) => els.map((e) => e.textContent ?? ''))
  const previewText = preview.join('').replace(/\s+/g, '')
  check('the CLI painted something into the card preview', previewText.length > 20, `${previewText.length} chars over ${preview.length} rows`)

  /*
   * Stopped before the dock opens, which is the trigger. A live session repairs itself: the pane
   * fits, the PTY is told, and the CLI redraws its whole screen at the new size. A stopped one has
   * nothing left to redraw with, so the bytes on disk have to carry their own geometry.
   */
  board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
  await sleep(4000)

  const node = await page.$('.react-flow__node')
  const box = await node.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + 14, { button: 'right' })
  await sleep(700)
  const opened = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.ctxmenu__item')].find(
      (el) => (el.textContent ?? '').trim() === 'Open terminal',
    )
    if (!item) return false
    item.click()
    return true
  })
  check('the card menu offers a terminal', opened)

  await page.waitForSelector('.dock-pane .xterm-rows', { timeout: 20000 })
  await sleep(5000)

  const dock = await page.$$eval('.dock-pane .xterm-rows > div', (els) => els.map((e) => e.textContent ?? ''))
  const dockText = dock.join('').replace(/\s+/g, '')
  check('the dock terminal drew something', dockText.length > 20, `${dockText.length} chars over ${dock.length} rows`)

  const dockCols = Math.max(...dock.map((r) => r.length))
  check(
    `the dock pane is not ${SPAWN_COLS} columns, so the widths really differ`,
    dockCols > 0 && dockCols !== SPAWN_COLS,
    `dock is about ${dockCols} columns`,
  )

  /*
   * Box drawing is what makes a TUI worth testing here. A vertical rule belongs at the edge of a
   * box; if the replay geometry is wrong the rules land mid-line and the count and placement go
   * wrong in ways plain text never would.
   */
  const rules = (rows) => rows.filter((r) => /[│┃|]/.test(r)).length
  console.log(`  preview rows with a vertical rule: ${rules(preview)} of ${preview.length}`)
  console.log(`  dock rows with a vertical rule:    ${rules(dock)} of ${dock.length}`)
  console.log(`  preview sample: ${JSON.stringify(preview.find((r) => r.trim()) ?? '')}`)
  console.log(`  dock sample:    ${JSON.stringify(dock.find((r) => r.trim()) ?? '')}`)

  /*
   * The decisive comparison, and it is width-independent: two views of one byte stream must carry
   * the same characters in the same order. Wrapping differs between a 120-column buffer and a
   * narrower pane by design, so whitespace is stripped; what cannot differ is the sequence.
   */
  check(
    'the dock and the preview agree on the characters, whitespace aside',
    previewText.length > 20 && (dockText.includes(previewText) || previewText.includes(dockText)),
    `preview ${previewText.length} chars, dock ${dockText.length}`,
  )
} finally {
  await browser.close()
  await board.stop()
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
