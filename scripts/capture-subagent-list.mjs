/**
 * Shots of the Subagents / Tools list, on a scratch board of its own.
 *
 * `capture.mjs` builds a fixture of four ordinary cards and never dispatches anything, so no shot
 * it produces can show this list at all. Reviewing the subagent change against those images would
 * have been reviewing a screen the change cannot reach, which is worse than not reviewing it: the
 * pass would have come back clean and meant nothing.
 *
 * The child cards here are made the way real ones are, by posting `SubagentStart` at the scratch
 * backend's own `/hook`, rather than by inserting rows. The point of the shot is what the app draws
 * from a real dispatch, and a fixture that takes a shortcut around the path being changed proves
 * only that the shortcut works.
 *
 *   npm run build
 *   node scripts/capture-subagent-list.mjs
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md. Nothing here
 * touches the live board.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 3840
const HEIGHT = 1600

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({
  projectName: 'salist-shots',
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Loader department', roleClass: 'manager', reportsTo: 0 },
  ],
})

/*
 * Four dispatches against the manager card, one of them still without a recorded end.
 *
 * Four rather than one because the failure this list exists to prevent is a column of look-alike
 * cards, and a single row cannot show whether that was solved. The last one carries no transcript
 * path on purpose: an agent whose CLI has not named a transcript yet is a real state, and the shot
 * should say whether the app admits that or draws a control that would fail on click.
 */
const parent = board.cards[1]
const DISPATCHES = [
  { agent: 'a-1', label: 'find every call site of overCeiling', transcript: 'C:\\tmp\\a1.jsonl', stop: true },
  { agent: 'a-2', label: 'read the mail guards', transcript: 'C:\\tmp\\a2.jsonl', stop: true },
  { agent: 'a-3', label: 'blind-review', transcript: 'C:\\tmp\\a3.jsonl', stop: false },
  { agent: 'a-4', label: 'camera-diag', transcript: null, stop: false },
]

async function hook(event) {
  await fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: parent.id, receivedAt: Date.now(), event }),
  })
}

for (const d of DISPATCHES) {
  // The dispatch call first, so the child is born with the description as its name, which is the
  // path a real Agent tool call takes.
  await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: `tu-${d.agent}`,
    tool_input: { description: d.label, subagent_type: 'general-purpose' },
  })
  await sleep(120)
  await hook({
    hook_event_name: 'SubagentStart',
    tool_use_id: `tu-${d.agent}`,
    agent_id: d.agent,
    agent_type: 'general-purpose',
    agent_transcript_path: d.transcript,
  })
  await sleep(200)
  if (d.stop) {
    await hook({ hook_event_name: 'SubagentStop', agent_id: d.agent })
    await sleep(120)
  }
}

await sleep(800)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: [`--window-size=${WIDTH},${HEIGHT}`],
})
const page = await browser.newPage()
await page.goto(board.UI, { waitUntil: 'networkidle2' })
await sleep(2500)

const shot = async (name) => {
  const file = join(OUT, name)
  await page.screenshot({ path: file })
  console.log(`shot: ${file}`)
}

await shot('20-salist-shut.png')

/*
 * Open the list by clicking its own header, not by setting state from outside.
 *
 * Clicking is the only way to prove the control the owner would use actually opens it. A shot of a
 * panel forced open by script says the panel renders and says nothing about whether anyone can get
 * to it, and "the control was there but did nothing" is a failure this project has already shipped
 * once.
 */
const opened = await page.evaluate((ownerId) => {
  const list = document.querySelector(`.salist[data-owner="${ownerId}"]`)
  if (!list) return 'no list drawn'
  const head = list.querySelector('.salist-head')
  if (!head) return 'no header'
  head.click()
  return 'clicked'
}, parent.id)
console.log(`open: ${opened}`)
await sleep(700)

await shot('21-salist-open.png')

// Close in, so the rows are legible at the size a reviewer actually reads them.
await page.evaluate((ownerId) => {
  const list = document.querySelector(`.salist[data-owner="${ownerId}"]`)
  list?.scrollIntoView({ block: 'center', inline: 'center' })
}, parent.id)
await sleep(400)

const box = await page.evaluate((ownerId) => {
  const list = document.querySelector(`.salist[data-owner="${ownerId}"]`)
  if (!list) return null
  const r = list.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}, parent.id)

if (box && box.width > 0) {
  const pad = 160
  await page.screenshot({
    path: join(OUT, '22-salist-close.png'),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(WIDTH, box.width + pad * 2),
      height: Math.min(HEIGHT, box.height + pad * 2),
    },
  })
  console.log(`shot: ${join(OUT, '22-salist-close.png')}`)
} else {
  console.log('no close shot: the list has no box')
}

/*
 * The Ceiling panel, close in, in the state that matters.
 *
 * The board behind it holds two cards and four dispatched agents, so the two figures being
 * separated are both non-zero and visibly different. A shot taken with no subagents on the board
 * would show the new row reading zero, which is exactly the state that cannot demonstrate whether
 * the separation works.
 */
const rail = await page.evaluate(() => {
  const el = document.querySelector('.rail-limits')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
if (rail && rail.width > 0) {
  const pad = 40
  await page.screenshot({
    path: join(OUT, '23-ceiling.png'),
    clip: {
      x: Math.max(0, rail.x - pad),
      y: Math.max(0, rail.y - pad),
      width: Math.min(WIDTH, rail.width + pad * 2),
      height: Math.min(HEIGHT, rail.height + pad * 2),
    },
  })
  console.log(`shot: ${join(OUT, '23-ceiling.png')}`)
} else {
  console.log('no ceiling shot: .rail-limits was not found')
}

/*
 * What the board actually holds, printed rather than judged. A count is a fact a screenshot cannot
 * carry, and the claim being made is about how many cards are drawn against how many exist.
 */
const drawn = await page.evaluate(() => document.querySelectorAll('.react-flow__node').length)
console.log(`cards drawn on the canvas: ${drawn}`)
console.log(`sessions in the store: ${board_count()}`)
function board_count() {
  return board.state.sessions.filter((s) => s.closedAt === null).length
}
console.log(
  `of those, subagent kind: ${board.state.sessions.filter((s) => s.closedAt === null && s.kind === 'subagent').length}`,
)

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
console.log(errors.length ? `console errors: ${errors.join('; ')}` : 'no console errors')

await browser.close()
await board.stop()
