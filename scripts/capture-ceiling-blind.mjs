/**
 * Screenshots for a blind review of the two VISIBLE halves of `ceiling-2026-08-13`.
 *
 * The work was verified by measurement: `test-ceiling-counts.mjs` reads a socket and
 * `test-invisible-cards-do-not-block.mjs` compares coordinates. Neither of those is an eye. Both
 * behaviours end at something the owner looks at, so both need somebody who sees only the picture:
 * the figure the panel prints beside "Agent cards", and where a dragged card actually comes to rest.
 *
 * What is deliberately here:
 *
 *   The panel is shot beside the board that produced it, so a reviewer can count the card-shaped
 *   things himself and compare. The failure this is looking for is a board drawing three and a panel
 *   saying eight, which is only visible if both are in the same frame.
 *
 *   A card is then put down on ground held only by a row the canvas does not draw, and after that on
 *   a card that IS drawn. The second one is the control and it is the point rather than decoration:
 *   without it, a board that had simply stopped moving anything at all would look perfect in the
 *   first shot and a reviewer would have no way to tell the difference.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Run `npm run build`
 * first or the shots are of an old bundle.
 *
 *   npm run build
 *   node scripts/capture-ceiling-blind.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots', 'ceiling-blind')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 2560
const HEIGHT = 1400

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({
  projectName: 'ceilingshots',
  cards: [{ title: 'Alpha' }, { title: 'Bravo' }, { title: 'Dragged' }],
})
const { ws, state } = board

/*
 * Where the cards actually are, which is not what `openBoard` tracks.
 *
 * It applies `state`, `session.added` and the rest, and nothing else, so the rows it holds carry the
 * position each card was CREATED at. Everything below aims a real mouse at a board coordinate, and
 * the first run of this script did it against those stale numbers: the server had adjusted every
 * card as it was placed, the transform read from two of them was wrong, and the check against the
 * third caught it at 1523px. So a `session.updated` is applied here, and the transform is still
 * checked before it is trusted, because a silent 1500px error is exactly what would have produced a
 * confident set of screenshots of the wrong thing.
 */
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated') {
    state.sessions = state.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  }
})

/** A dispatch the way the CLI reports one, so these rows arrive by the path the owner's do. */
const dispatch = async (parent, n) => {
  const tu = `tu-${parent.id}-${n}`
  const post = (event) =>
    fetch(`http://127.0.0.1:${board.port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gardenSessionId: parent.id, receivedAt: Date.now(), event }),
    })
  await post({
    hook_event_name: 'PreToolUse',
    session_id: `cli-${parent.id}`,
    tool_name: 'Task',
    tool_use_id: tu,
    tool_input: { description: `read around thing ${n}`, subagent_type: 'general-purpose' },
  })
  await post({
    hook_event_name: 'SubagentStart',
    session_id: `cli-${parent.id}`,
    tool_use_id: tu,
    agent_id: `agent-${parent.id}-${n}`,
    agent_type: 'general-purpose',
  })
  await sleep(250)
}

const [alpha, bravo, dragged] = board.cards
for (let n = 1; n <= 5; n++) await dispatch(alpha, n)

const subagents = state.sessions.filter((s) => s.kind === 'subagent')
if (subagents.length !== 5) {
  console.log(`ABORT: expected 5 subagent rows, got ${subagents.length}`)
  await board.stop()
  process.exit(1)
}

const at = (id) => state.sessions.find((s) => s.id === id)
const move = async (id, x, y) => {
  ws.send(JSON.stringify({ t: 'session.move', sessionId: id, x, y }))
  await sleep(400)
  return at(id)
}

/*
 * Somewhere with nothing else near it, so the only thing that could push the dragged card aside is
 * the row put there on purpose. Both targets are on the same horizontal line as the cards the
 * transform is read from, which keeps the drag inside the window at the zoom the board opens at.
 */
await move(alpha.id, 200, 300)
await move(bravo.id, 900, 300)
await move(dragged.id, 200, 900)
const ghost = await move(subagents[0].id, 1600, 300)
console.log(`the invisible subagent sits at ${ghost.x},${ghost.y} and the canvas does not draw it`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.stack || String(e)))

await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

/*
 * Frame every card before shooting, and the reason is a review that has already gone wrong once.
 *
 * The first set of these shots was taken at whatever viewport the board happened to be at, and two
 * of the four had a card sitting half past the edge of the window. A reviewer who saw only the
 * images reported a card "flung out of the visible working area" in both, twice, and was right about
 * the picture: the card was where it had been put, and the frame was mine. An image that makes a
 * correct placement look like a fault wastes the reviewer and discredits the rest of the set.
 *
 * So the board is fitted first. The cost is that the viewport is not the same between shots, which
 * makes "did it move" unanswerable by eye, and that is honest: whether a card is at the coordinate
 * it was dropped at is arithmetic, it is measured elsewhere, and it was never something an eye could
 * settle. What the eye is left with is what the eye is good for, whether the result looks like a
 * board or like a pile.
 */
const fit = async () => {
  await page.evaluate(() => {
    document.querySelector('.react-flow__controls-fitview')?.click()
  })
  await sleep(1200)
}

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log('shot:', join(OUT, `${name}.png`))
}

const drawn = await page.$$eval('.react-flow__node', (ns) =>
  ns.map((n) => {
    const r = n.getBoundingClientRect()
    return { text: (n.textContent || '').slice(0, 40), x: r.x, y: r.y, w: r.width, h: r.height }
  }),
)
console.log(`the canvas draws ${drawn.length} nodes`)

await fit()
await shot('01-board-and-panel')

const panelBox = await page.evaluate(() => {
  const el = document.querySelector('.rail-limits')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
if (!panelBox) {
  console.log('NOT FOUND: .rail-limits, so there is no panel shot')
} else {
  await sleep(400)
  const b = await page.evaluate(() => {
    const r = document.querySelector('.rail-limits').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await page.screenshot({
    path: join(OUT, '02-panel.png'),
    clip: {
      x: Math.max(0, b.x - 16),
      y: Math.max(0, b.y - 44),
      width: Math.min(WIDTH - Math.max(0, b.x - 16), b.width + 32),
      height: Math.min(HEIGHT - Math.max(0, b.y - 44), b.height + 60),
    },
  })
  console.log('shot:', join(OUT, '02-panel.png'))
}

/*
 * Cards are put down over the socket rather than by driving a synthetic mouse, and that is a
 * decision rather than a shortcut.
 *
 * `Canvas.tsx:1610` ends a drag in `onDragStop`, which reaches `actions.move` in `state.ts:1088`,
 * which sends `{ t: 'session.move', sessionId, x, y }` and nothing else. That is the identical
 * message used below and the identical message `test-invisible-cards-do-not-block.mjs` sends, so
 * there is no second path down which a mouse could behave differently from a socket, and a shot
 * taken this way is a shot of what a drop does.
 *
 * The mouse version of this file existed and was thrown away, which is worth recording because its
 * output looked convincing. Puppeteer drags near the edge of the window make the canvas pan under
 * the cursor, so the card lands somewhere the arithmetic did not predict, and the first run reported
 * a 468px gap that read exactly like the server shoving a card away from nothing. It was the
 * harness. A drop onto empty ground as a baseline is what caught it, and without that baseline this
 * file would have produced a confident screenshot of a bug that is not there.
 *
 * What an eye can and cannot settle here is worth being plain about. Whether a card sits at the
 * coordinate it was dropped at is arithmetic and is measured, not seen. What is seen, and what the
 * reviewer is asked, is whether the board looks like a board afterwards: nothing overlapping,
 * nothing flung into a corner, the moved card where the others are not.
 */
const place = async (card, x, y, name, what) => {
  ws.send(JSON.stringify({ t: 'session.move', sessionId: card.id, x, y }))
  await sleep(1200)
  const now = at(card.id)
  const stayed = now.x === x && now.y === y
  console.log(`${what}: asked for ${x},${y} and the server put it at ${now.x},${now.y}${stayed ? ' (unchanged)' : ' (MOVED by the server)'}`)
  await fit()
  await shot(name)
  return now
}

// Onto ground held only by the row the canvas does not draw. It should stay exactly there.
const ghostNow = at(ghost.id)
await place(dragged, ghostNow.x, ghostNow.y, '03-on-invisible', 'dropped where only the invisible row sits')

// The control: onto a card that IS drawn. This one should be pushed aside, and visibly.
const bravoAt = { x: at(bravo.id).x, y: at(bravo.id).y }
await place(dragged, bravoAt.x, bravoAt.y, '04-on-drawn', 'dropped onto a card that is drawn')
const bravoAfter = at(bravo.id)
console.log(
  `and Bravo is at ${bravoAfter.x},${bravoAfter.y}, was ${bravoAt.x},${bravoAt.y}` +
    `${bravoAfter.x === bravoAt.x && bravoAfter.y === bravoAt.y ? ' (unchanged, as it must be)' : ' (IT MOVED, which is wrong)'}`,
)

if (errors.length) console.log('page errors:', errors.slice(0, 5))
await browser.close()
await board.stop()
console.log('done')
