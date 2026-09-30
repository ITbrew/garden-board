/**
 * The wheel over a card's terminal scrolls what the dock would scroll. Canon 02 revision 12.
 *
 * The owner: "i dont like the conversational view. i want the terminal view to be sscrollable".
 * Claude Code keeps no history in its terminal. It repaints one screen in place, so the card's
 * miniature holds one screen and scrolling it shows nothing new. What scrolls in the dock is the CLI
 * itself: it switches mouse reporting on, the dock's terminal sends a report for each wheel step, and
 * the CLI moves its own view. This checks that a card now does the same, and that nothing else
 * changed on the way:
 *
 * - A wheel over a card whose program asked for the mouse reaches that program as a report, up and
 *   down, naming a cell on the rows the card is drawing, and what the program draws back shows on
 *   the card.
 * - It still works for a page loaded after the program's request left the 256 KB of history the
 *   server keeps, because the server says the modes again at the end of that history.
 * - A shell that never asked keeps the card's own scroll, and is never sent a report, which a shell
 *   would take as typed characters.
 * - A report aimed at a card with no process is not recorded as lost typing, and real typing still is.
 * - A Claude card opens on its terminal, not its conversation.
 *
 * The program behind the card is a small fixture that asks for the mouse exactly as Claude Code does
 * (1000, 1002, 1003 and 1006) and prints what reaches it, so no CLI is started and nothing is spent.
 * Its own Garden on its own port, serving the BUILT app: run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/*
 * Asks for the mouse, then prints about 330 KB in frame-sized batches, so the request is well out of
 * the history the server keeps by the time the page loads. Batches rather than one burst because
 * ConPTY paints per frame and never emits a line that scrolled in and out between two frames.
 */
const FIXTURE = String.raw`
const out = (s) => process.stdout.write(s)
out('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
const pad = 'x'.repeat(100)
let i = 0
const batch = () => {
  for (let n = 0; n < 20 && i < 3000; n++, i++) out('filler ' + i + ' ' + pad + '\r\n')
  if (i < 3000) return setTimeout(batch, 20)
  out('mouse-echo ready\r\n')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (d) => {
    const s = d.toString('latin1')
    if (s.includes('\x03')) process.exit(0)
    out('GOT ' + s.replace(/\x1b/g, 'ESC') + '\r\n')
  })
}
batch()
`

const board = await openBoard({
  projectName: 'wheel',
  files: { 'mouse-echo.mjs': FIXTURE },
  cards: [{ title: 'Mouse' }, { title: 'Plain' }, { title: 'Off' }, { title: 'Claude card', adapterId: 'claude' }],
})
const [mouseCard, plainCard, offCard, claudeCard] = board.cards

const events = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'event') events.push(m.event)
})

/** The raw bytes the server hands a page for this card, and the geometry they were drawn at. */
function scrollback(id) {
  return new Promise((resolve) => {
    const on = (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t !== 'session.scrollback' || m.sessionId !== id) return
      board.ws.off('message', on)
      resolve(m)
    }
    board.ws.on('message', on)
    board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: id }))
  })
}
const type = (id, data) => board.ws.send(JSON.stringify({ t: 'session.input', sessionId: id, data }))

for (const c of [mouseCard, plainCard]) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(6000)
// ConPTY asks the terminal who it is when it starts and holds the first input while it waits for an
// answer nobody here gives, so an Enter goes first and is the one that is spent.
type(mouseCard.id, '\r')
type(plainCard.id, '\r')
await sleep(800)
type(mouseCard.id, `node "${board.dir}\\mouse-echo.mjs"\r`)
type(plainCard.id, '1..120 | ForEach-Object { "line $_ of the scrollback" }\r')

let ready = null
for (let i = 0; i < 40 && !ready; i++) {
  await sleep(500)
  const sb = await scrollback(mouseCard.id)
  if (sb.data.includes('mouse-echo ready')) ready = sb
}
check('the fixture asked for the mouse and printed past the kept history', !!ready)

// --- the server says the modes again after the bytes ---

const MODES = '\x1b[?1003h\x1b[?1006h'
const body = ready ? ready.data.slice(0, ready.data.length - MODES.length) : ''
/*
 * The request is long gone from the bytes. A running card's snapshot is its serialized screen now
 * (canon 03 revision 17), which states the modes the program switched on itself, so what matters is
 * only that they are there, however long ago they were asked for.
 */
check(
  'the modes are in the snapshot, though the request was printed long ago',
  !!ready && body.includes('\x1b[?1003h') || !!ready && ready.data.endsWith(MODES),
  ready ? `${ready.data.length} bytes` : 'no scrollback',
)
check(
  'and the history ends by saying the modes the program has on',
  !!ready && ready.data.endsWith(MODES),
  ready ? JSON.stringify(ready.data.slice(-40)) : '',
)

// --- the page ---

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1800,1100', '--no-sandbox'],
  defaultViewport: { width: 1800, height: 1100 },
})
const pageErrors = []

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.mini', { timeout: 20000 })
  await sleep(3000)

  /** One card's node, found by its title. */
  const node = (title) =>
    page.evaluateHandle(
      (t) => [...document.querySelectorAll('.react-flow__node')].find((n) => n.querySelector('.node-title')?.textContent?.trim() === t) ?? null,
      title,
    )
  const miniBox = async (title) => {
    const n = await node(title)
    const mini = await n.asElement()?.$('.mini')
    return mini ? mini.boundingBox() : null
  }
  const miniText = (title) =>
    page.evaluate(
      (t) =>
        [...document.querySelectorAll('.react-flow__node')]
          .find((n) => n.querySelector('.node-title')?.textContent?.trim() === t)
          ?.querySelector('.mini')?.textContent ?? '',
      title,
    )
  const rowsDrawn = (title) =>
    page.evaluate(
      (t) =>
        [...document.querySelectorAll('.react-flow__node')]
          .find((n) => n.querySelector('.node-title')?.textContent?.trim() === t)
          ?.querySelectorAll('.mini .mini-row').length ?? 0,
      title,
    )

  const kind = await page.evaluate((t) => {
    const n = [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t)
    if (!n) return 'no card'
    return n.querySelector('.agent-summary') ? 'conversation' : n.querySelector('.mini') ? 'terminal' : 'neither'
  }, claudeCard.title)
  check('a Claude card opens on its terminal', kind === 'terminal', kind)

  // Wheel up, then down, over the middle of the card.
  const box = await miniBox(mouseCard.title)
  check('the card whose program asked for the mouse draws its terminal', !!box)
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel({ deltaY: -120 })
    await sleep(900)
    await page.mouse.wheel({ deltaY: 120 })
    await sleep(1500)
  }
  const after = await scrollback(mouseCard.id)
  const got = [...after.data.matchAll(/GOT ESC\[<(\d+);(\d+);(\d+)M/g)].map((m) => m.slice(1).map(Number))
  const up = got.find((g) => g[0] === 64)
  const down = got.find((g) => g[0] === 65)
  check('a wheel up over the card reaches the program as a wheel-up report', !!up, JSON.stringify(got))
  check('and a wheel down as a wheel-down report', !!down)
  check('one report per wheel step, not a burst', got.length === 2, `${got.length} reports`)

  const drawn = await rowsDrawn(mouseCard.title)
  const inWindow = (g) => g && g[1] >= 1 && g[1] <= after.cols && g[2] > after.rows - drawn && g[2] <= after.rows
  check(
    'naming a cell on the rows the card is drawing',
    inWindow(up) && inWindow(down),
    `${JSON.stringify(up)} on a ${after.cols}x${after.rows} screen, card drawing its last ${drawn} rows`,
  )
  await sleep(800)
  check('and what the program draws back shows on the card', (await miniText(mouseCard.title)).includes('GOT ESC[<64;'))
  check(
    'the card offers no scrollbar of its own while the program has the wheel',
    !(await page.evaluate(
      (t) =>
        !![...document.querySelectorAll('.react-flow__node')]
          .find((n) => n.querySelector('.node-title')?.textContent?.trim() === t)
          ?.querySelector('.mini-scroll'),
      mouseCard.title,
    )),
  )

  // A shell that never asked: the card scrolls itself, and nothing is typed into the shell.
  const plain = await miniBox(plainCard.title)
  if (plain) {
    await page.mouse.move(plain.x + plain.width / 2, plain.y + plain.height / 2)
    await page.mouse.wheel({ deltaY: -400 })
    await sleep(900)
  }
  const held = await page.evaluate(
    (t) =>
      !![...document.querySelectorAll('.react-flow__node')]
        .find((n) => n.querySelector('.node-title')?.textContent?.trim() === t)
        ?.querySelector('.mini-follow'),
    plainCard.title,
  )
  check('a shell card still scrolls back through its own terminal', held)
  const plainBytes = (await scrollback(plainCard.id)).data
  check('and its shell is sent nothing', !plainBytes.includes('<64;') && !plainBytes.includes('<65;'))
} finally {
  await browser.close()
}

// --- a card with no process ---

const before = events.length
type(offCard.id, '\x1b[<64;10;5M')
await sleep(700)
const afterMouse = events.slice(before).filter((e) => e.type === 'InputDropped' && e.sessionId === offCard.id)
check('a mouse report to a card with no process is not recorded as lost typing', afterMouse.length === 0, `${afterMouse.length} recorded`)
type(offCard.id, 'hello')
await sleep(700)
const afterText = events.slice(before).filter((e) => e.type === 'InputDropped' && e.sessionId === offCard.id)
check('while real typing to it still is', afterText.length === 1, `${afterText.length} recorded`)

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))

type(mouseCard.id, '\x03')
await sleep(300)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
