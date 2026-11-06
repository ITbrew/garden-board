/**
 * Arranging the board moves cards and touches nothing else.
 *
 * The owner said it plainly: "arrange the board is purely cosmetic for me to better visualize
 * systems, wiring retains the same throughout changing styles." That is a promise worth a test
 * rather than a comment, because the arrangements now change which SIDE of a card a wire attaches
 * to, and it would be easy for that to grow into changing the wire itself.
 *
 * So every wire row is snapshotted before and after the arrangement and compared exactly: same ids,
 * same ends, same kind, same direction. Only x and y may move.
 *
 * The four styles this was written against are gone from the rail at the owner's request, and Tidy
 * layout in the canvas menu is what it holds to the promise now. See the comment beside the click.
 */
import puppeteer from 'puppeteer-core'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const UI_TIMEOUT = 20000
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A board of its own, with no cards from openBoard's own seeding: the hierarchy below is built by
// hand from real hook events (PreToolUse -> SubagentStart), the same flow a live spawn fires, and
// openBoard's plain `session.create` + `reportsTo` would draw a different kind of wire ('manual')
// than what a real hire draws ('derived'). This test is specifically about the derived kind.
const board = await openBoard({ projectName: 'cosmetic' })
const UI = board.UI
const project = board.project
const st = board.state

// This instance's own database, in its own home directory, never ~/.garden.
const db = new Database(join(board.home, 'garden.db'), { readonly: true })
const wireSnapshot = (projectId) =>
  JSON.stringify(
    db.prepare('SELECT id, sourceId, targetId, kind, label, bidirectional FROM wires WHERE projectId = ? ORDER BY id')
      .all(projectId),
  )

async function hook(sessionId, event) {
  await (await fetch(`${UI}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
    signal: AbortSignal.timeout(UI_TIMEOUT),
  })).text()
  await sleep(200)
}

board.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Lead' }))
await sleep(2000)
const lead = st.sessions.find((s) => s.projectId === project.id && s.title === 'Lead')
const SID = `cos-${Date.now()}`
await hook(lead.id, { hook_event_name: 'SessionStart', session_id: SID })

// Three departments, one of which hires, so there is a real hierarchy to rearrange.
const spawn = async (parentId, tu, ag, type, desc) => {
  await hook(parentId, {
    hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p1',
    tool_name: 'Task', tool_use_id: tu, tool_input: { description: desc, subagent_type: type },
  })
  await hook(parentId, {
    hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p1',
    tool_use_id: tu, agent_id: ag, agent_type: type,
  })
  return st.sessions.find((s) => s.agentId === ag)
}
const creative = await spawn(lead.id, 'tu-1', 'ag-1', 'creative', 'the creative team')
await spawn(lead.id, 'tu-2', 'ag-2', 'coder', 'the coding team')
await spawn(lead.id, 'tu-3', 'ag-3', 'ads', 'the advertising team')
await spawn(creative.id, 'tu-4', 'ag-4', 'creative', 'a copywriter')

const before = wireSnapshot(project.id)
check('there are wires to protect', JSON.parse(before).length >= 4, `${JSON.parse(before).length} wires`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 3000, height: 1500 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('   [pageerror]', String(e.message).slice(0, 200)))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(1500)
await page.evaluate((name) => {
  const tab = [...document.querySelectorAll('button, .tab')].find((b) => (b.textContent || '').trim().startsWith(name))
  if (tab) tab.click()
}, project.name)
await sleep(1600)

/*
 * Read where the cards are DRAWN, not where the database says they are.
 *
 * `board.tidy` (server/src/index.ts, the `board.tidy` case) calls `clearManualPositions` and
 * rebroadcasts. It writes no coordinates: the repacking happens in the canvas, for cards whose
 * manual position has been cleared. So a check against `sessions.x/y` reads a table Tidy does not
 * touch and reports "nothing moved" no matter what the owner sees happen, which is exactly what it
 * did. What he is promised is that the cards move and the wires do not change, so the cards are
 * measured on screen and the wires in the database, each where the truth for it actually lives.
 */
const positionsOf = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.node')]
      .map((n) => {
        const r = n.getBoundingClientRect()
        return `${Math.round(r.left)},${Math.round(r.top)}`
      })
      .sort()
      .join('|'),
  )

/*
 * One arrangement now, and it is in the canvas menu rather than the rail.
 *
 * This used to run over Web, Tree, Sequential and Waterfall, four buttons in the sidebar. The owner
 * had all four removed (canon 02 revision 3): he reported that their styles did not produce the
 * shapes they named, and the rail section went with them. So this had been failing on four missing
 * buttons ever since, which is a test with no subject rather than a test finding anything.
 *
 * Tidy layout survived and moves cards, so the promise this file exists to hold is now about that
 * one. The promise itself is unchanged and is still the owner's words: arranging is purely
 * cosmetic, and the wiring is the same afterwards.
 */
const label = 'Tidy layout'

/*
 * Shove a card somewhere silly first, or the assertion below cannot fail.
 *
 * These cards arrive from real spawn events, so the canvas has already packed them and Tidy has
 * nothing left to do: it ran, moved nothing, and "actually moved the cards" read as a defect in
 * Tidy rather than as a board that was already tidy. Displacing one first makes the check mean what
 * it says, and it also makes the wire comparison stronger, since the wire now has a real distance
 * to be redrawn across.
 */
const displaced = st.sessions.find((s) => s.projectId === project.id && s.title !== 'Lead')
board.ws.send(JSON.stringify({ t: 'session.move', sessionId: displaced.id, x: 9000, y: 7000 }))
await sleep(1200)

const wasAt = await positionsOf()
await page.mouse.click(1800, 900, { button: 'right' })
await sleep(600)
const clicked = await page.evaluate((want) => {
  const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((n) =>
    (n.textContent || '').trim().startsWith(want),
  )
  if (!b) return false
  b.click()
  return true
}, label)
await sleep(2200)
check(`${label} is in the canvas menu`, clicked)
const nowAt = await positionsOf()
check(`${label} actually moved the cards`, nowAt !== wasAt, `before ${wasAt} / after ${nowAt}`)
const now = wireSnapshot(project.id)
check(`${label} left every wire exactly as it was`, now === before,
  now === before ? '' : `before ${before}
         after  ${now}`)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
