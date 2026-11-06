/**
 * Two views of one byte stream must show the same characters.
 *
 * The owner reported text "all over the place" in terminals, sometimes curing itself when he opened
 * a pane. The account being tested: `session.scrollback` carries the geometry the bytes were drawn
 * against, `state.ts` handed it to the card preview and not to the dock terminals, so a snapshot was
 * replayed at whatever width the pane happened to be. A CLI sends drawing instructions computed for
 * a grid, not finished text, so replaying "move up three rows and write" against a different width
 * lands it on the wrong line. `pty-manager.ts:196-214` states the same failure at the other end.
 *
 * WHAT MAKES THIS A MEASUREMENT RATHER THAN A LOOK. The card preview already received the geometry
 * and is known-correct on this exact point, so it is the reference. The dock terminal is the thing
 * under test. Both are fed from the same snapshot of the same session. If they disagree about which
 * line got overwritten, one of them is wrong, and that is a fact rather than a judgement.
 *
 * The fixture is built to make the fault visible rather than to look realistic. Lines longer than
 * the spawn width wrap, so the row a cursor-up lands on depends entirely on the width in force, and
 * an overwrite token then marks it. At 120 columns it lands on one line; at the pane's width it
 * lands on another. Plain text alone would not do: unwrapped characters come out in the same order
 * at any width, which is why a naive fixture would pass on the broken build.
 *
 * Its own Garden on its own port with its own workspace, and it asserts that before it starts.
 * Needs `npm run build` first: the harness runs the BUILT app and the BUILT server.
 *
 * THIS FIXTURE IS TOO GENTLE, AND `test-terminal-geometry-tui.mjs` IS THE ONE THAT REPRODUCES.
 * A shell printing wrapped lines does not corrupt on either build: measured, three runs each way,
 * with the character sequences matching identically. Point the same question at a real CLI drawing
 * its composer and the fault appears every time on the broken build and never on the fixed one.
 * Keep this file as the narrower case, but do not read a pass here as evidence about the fix.
 *
 * THE KNOWN WEAKNESS, so nobody has to find it twice. This reads the rows xterm has RENDERED, and
 * xterm's DOM renderer only draws the visible viewport, so anything scrolled out of the pane is
 * invisible to these assertions. The stronger measurement would read the terminal's whole buffer,
 * and that is not available: no webgl or canvas addon is loaded (only `@xterm/addon-fit`), so the
 * characters really are DOM text and can be scraped, but the pool keeps its instances in a
 * module-level Map that is never attached to `window`, so there is no handle to `term.buffer` from
 * a page script. The one inconclusive result this test has produced, a run where the marker was
 * absent from view rather than in the wrong place, sits exactly in that blind spot.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/** The width a session is spawned at (`SPAWN_COLS` in pty-manager.ts). The bytes mean this. */
const SPAWN_COLS = 120

/*
 * Narrow on purpose. The whole fault needs the pane to be a different width from the process, and a
 * window this size puts the dock pane far below 120 columns. A test run at a window width that
 * happened to give 120 columns would pass on both builds and prove nothing, which is why the column
 * count is asserted below rather than assumed.
 */
const WINDOW = { width: 700, height: 760 }

const board = await openBoard({ projectName: 'termgeom', cards: [{ title: 'Wrapper' }] })
const card = board.cards[0]

// Isolation, proved rather than trusted: this is a Garden of its own and the owner's board is on
// another port entirely.
const health = await (await fetch(`${board.UI}/health`)).json().catch(() => null)
check(
  'the scratch backend is a Garden of its own',
  !!health,
  `port ${board.port}, home ${board.home}`,
)

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(6000)

/*
 * Six long lines, then a cursor-up and an overwrite.
 *
 * Each line is longer than 120 columns, so it occupies two rows at the spawn width and three at the
 * pane's. `ESC[4A` then moves up four ROWS, not four lines, so which line the token lands on is
 * decided by the wrapping, which is decided by the width. That is the entire mechanism the fix
 * claims to protect, expressed in the smallest fixture that shows it.
 */
board.ws.send(
  JSON.stringify({
    t: 'session.input',
    sessionId: card.id,
    /*
     * Every row carries its own line number, not just the first.
     *
     * The first version padded with a run of x's, and the overwrite landed on a continuation row
     * that carried no marker at all. Both views then returned the same "no marker" string and the
     * assertion that they agreed passed by comparing one failure with another. Repeating the label
     * across the whole line means any row the cursor lands on identifies itself, whichever width it
     * was wrapped at.
     */
    data:
    /*
     * The token is assembled at runtime so the shell's echo of this very command cannot contain it.
     *
     * It did on the first attempt: the terminal echoes what was typed, the typed text held the
     * literal marker, and both views duly found it on the echoed command line rather than on the
     * output. The assertion was reading the test's own input back to itself, which is the same
     * failure as a test matching its own message body, and it took a printed row to see it.
     */
      '$e=[char]27; 1..4 | ForEach-Object { Write-Host ("L$_." * 40) }; ' +
      'Write-Host ("$e[3A" + "OVER" + "WRITE" + "HERE")\r',
  }),
)
await sleep(7000)

/*
 * Stop the process before the dock ever opens, and this is the whole trigger rather than a detail.
 *
 * With a live process the fault cannot survive: the pane fits, `actions.resize` tells the PTY its
 * new size, and the CLI redraws the whole screen at that size, so the geometry matches before the
 * snapshot is even asked for. A first version of this test opened the dock on a live session and
 * passed on the broken build for exactly that reason. It is also, read the other way, why the owner
 * saw it "fix itself" when he opened a terminal: a live session repairs itself and a dead one has
 * nothing left to redraw with.
 *
 * Stopped, `scrollback` returns the bytes from disk with the spawn geometry (pty-manager.ts:213),
 * which is the case where the size must travel with the buffer because nothing can recompute it.
 */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [`--window-size=${WINDOW.width},${WINDOW.height}`, '--no-sandbox'],
  defaultViewport: WINDOW,
})

try {
  const page = await browser.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[geomprobe]')) console.log(`  ${t}`)
  })
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  await sleep(3000)

  /** The preview's rows, which are drawn from the same snapshot at the geometry it carried. */
  const previewRows = () =>
    page.$$eval('.mini-row', (els) => els.map((e) => e.textContent ?? ''))

  /*
   * The reference is read while the session is still live, because stopping it empties the pane:
   * the preview holds a live terminal's buffer and a stopped card says it kept no history for the
   * run. So the correct rendering is captured first, and the session is stopped afterwards.
   */
  const preview = await previewRows()
  check('the card preview drew the output', preview.some((r) => /L\d\./.test(r)), `${preview.length} rows`)

  /*
   * Stop the process before the dock opens, and this is the trigger rather than a detail.
   *
   * With a live process the fault cannot survive to be seen: the pane fits, `actions.resize` tells
   * the PTY, and the CLI redraws the whole screen at the new size, so the geometry agrees before the
   * snapshot is even asked for. The first version of this test opened the dock on a live session and
   * passed on the broken build for exactly that reason. Read the other way, that is also why the
   * owner saw it "fix itself" when he opened a terminal: a live session repairs itself and a dead
   * one has nothing left to redraw with.
   *
   * Stopped, `scrollback` returns the bytes from disk with the spawn geometry (pty-manager.ts:213),
   * which is precisely the case where the size has to travel with the buffer because nothing on the
   * other end can recompute it.
   */
  board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
  await sleep(3500)

  // Open the dock the way the owner does: right-click the card, then "Open terminal".
  const node = await page.$('.react-flow__node')
  const box = await node.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + 14, { button: 'right' })
  await sleep(700)
  const opened = await page.evaluate(() => {
    const item = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'Open terminal',
    )
    if (!item) return false
    item.click()
    return true
  })
  check('the card menu offers a terminal', opened)

  await page.waitForSelector('.dock-pane .xterm-rows', { timeout: 20000 })
  await sleep(4000)

  const dock = await page.$$eval('.dock-pane .xterm-rows > div', (els) =>
    els.map((e) => e.textContent ?? ''),
  )
  check('the dock terminal drew something', dock.some((r) => r.trim() !== ''), `${dock.length} rows`)

  /*
   * The control assertion, and without it the rest is worthless.
   *
   * The fault only exists when the pane is a different width from the process. A run where the pane
   * happens to be 120 columns would agree on both builds. The longest run of x's on a wrapped row is
   * the terminal's own column count, so this measures the width actually in force rather than
   * assuming the window produced one.
   */
  const dockCols = Math.max(...dock.map((r) => r.length))
  check(
    `the dock pane is not ${SPAWN_COLS} columns, so the widths really differ`,
    dockCols > 0 && dockCols !== SPAWN_COLS,
    `dock is about ${dockCols} columns`,
  )

  /*
   * Which line the overwrite landed on, in each view.
   *
   * This is the comparison that carries the result. Both views were fed the same bytes; the token
   * can only be on one line if both interpreted them at the same geometry.
   */
  /*
   * What the token OVERWROTE, read from what follows it, and this has to be wrap-independent.
   *
   * The first version asked which line number appeared first on the token's row. That is a reflow
   * artifact rather than a fact about the bytes: a 120-character line exactly fills a 120-column row,
   * xterm marks it wrapped, and rewrapping to a narrower pane legitimately puts that line's tail and
   * the next line's start on one row. It reported a disagreement on builds that agreed.
   *
   * The bytes say: the cursor went up to the start of line 2 and wrote 13 characters over it, so
   * whatever follows the token is line 2 continuing from offset 13. That is true at any width. If
   * the snapshot were replayed at the wrong width the cursor would land somewhere else entirely and
   * the following characters would carry a different line's number.
   */
  const marked = (rows) => {
    const row = rows.find((r) => r.includes('OVERWRITEHERE'))
    if (!row) return null
    const after = row.slice(row.indexOf('OVERWRITEHERE') + 'OVERWRITEHERE'.length)
    const m = after.match(/L?(\d)\./)
    return m ? m[1] : null
  }
  const previewMark = marked(preview)
  const dockMark = marked(dock)

  // Printed rather than only asserted, because when this disagrees the interesting thing is WHAT
  // each view thinks it is showing, and a bare FAIL sends the next person back to re-run it.
  console.log(`  preview overwrite row: ${JSON.stringify((preview.find((r) => r.includes('OVERWRITEHERE')) ?? '').slice(0, 70))}`)
  console.log(`  dock overwrite row:    ${JSON.stringify((dock.find((r) => r.includes('OVERWRITEHERE')) ?? '').slice(0, 70))}`)

  check('the preview shows the overwrite, on an identifiable line', previewMark !== null, `line ${previewMark}`)
  check('the dock shows the overwrite, on an identifiable line', dockMark !== null, `line ${dockMark}`)
  /*
   * Both marks must exist AND match. Requiring existence separately is the point: the first version
   * of this compared two "not found" results and called them agreement, which is a test passing on
   * its own failure.
   */
  check(
    'both views agree which line the overwrite landed on',
    previewMark !== null && dockMark !== null && previewMark === dockMark,
    `preview says line ${previewMark}, dock says line ${dockMark}`,
  )

  /*
   * And the whole visible text agrees, whitespace aside. Wrapping differs between the two by design,
   * so whitespace is stripped; what must survive is the sequence of characters. A snapshot replayed
   * at the wrong width does not merely rewrap, it overwrites the wrong cells, so the sequence itself
   * changes.
   */
  const squash = (rows) => rows.join('').replace(/\s+/g, '')
  const previewText = squash(preview)
  const dockText = squash(dock)
  check(
    'the dock contains every character the preview shows, in the same order',
    previewText.length > 40 && dockText.includes(previewText),
    previewText.length > 40
      ? `preview ${previewText.length} chars, dock ${dockText.length}`
      : `preview text too short to mean anything: ${previewText.length} chars`,
  )

  await page.screenshot({ path: 'docs/shots/11-terminal-geometry.png' })
  console.log('shot: docs/shots/11-terminal-geometry.png')
} finally {
  await browser.close()
  await board.stop()
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
