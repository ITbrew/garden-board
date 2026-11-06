/**
 * A card dropped into empty space stays where it was dropped.
 *
 * The failure this exists for, in the owner's words: dragging a card to the right snapped it away
 * into a corner, away from space that was visibly empty. Nothing was there. `occupiedRects` collects
 * every session row on the project without asking whether the board draws it, so a board drawing
 * three cards was built out of 24 rectangles: spent subagents the canvas stopped drawing, and cards
 * he had closed and parked, all still blocking space he could see was free. The board shoved his
 * card away from nothing and could not show him why, which is the one thing this app must not do.
 *
 * So the rule under test is that the rectangles the server avoids are exactly the rectangles the
 * canvas draws, and the two definitions live in one place rather than two that can drift apart.
 *
 * The two controls at the end are the point of the file rather than decoration: without them, a
 * server that had simply stopped avoiding anything at all would pass everything above.
 *
 * Runs against a server of its own. No terminals: cards are made switched off and the subagent is
 * born from hook payloads, which is how the CLI makes one.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const PORT = garden.port

const dir = mkdtempSync(join(tmpdir(), 'garden-invisible-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

const stop = async (code) => {
  ws.close()
  await garden.stop()
  process.exit(code)
}

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await stop(1)
}

const make = async (title) => {
  ws.send(
    JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }),
  )
  await sleep(450)
  const card = st.sessions.find((s) => s.title === title)
  if (!card) {
    console.log(`FAIL  could not create "${title}"`)
    await stop(1)
  }
  return card
}

const at = (id) => st.sessions.find((s) => s.id === id)

/** Drop a card at an exact point and hand back where the server actually put it. */
const dropAt = async (card, x, y) => {
  ws.send(JSON.stringify({ t: 'session.move', sessionId: card.id, x, y }))
  await sleep(450)
  const now = at(card.id)
  return { x: now.x, y: now.y, stayed: now.x === x && now.y === y }
}

const dragged = await make('Dragged')
const parent = await make('Parent')
const parked = await make('Parked')

// A dispatch, the way the CLI reports one. The card it creates is a row the canvas does not draw.
await fetch(`http://127.0.0.1:${PORT}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: parent.id,
    receivedAt: Date.now(),
    event: {
      hook_event_name: 'SubagentStart',
      session_id: `cli-${parent.id}`,
      agent_id: `agent-${parent.id}-1`,
      agent_type: 'general-purpose',
    },
  }),
})
await sleep(500)
const ghost = st.sessions.find((s) => s.kind === 'subagent')
check('a subagent row exists and the canvas would not draw it', !!ghost && ghost.closedAt === null)

// --- an invisible subagent must not hold ground ---

/*
 * Both cards are sent to the same far corner, well away from everything the board was seeded with,
 * so the only thing that could push the second one aside is the first.
 */
const FAR = { x: 6000, y: 6000 }
await dropAt(ghost, FAR.x, FAR.y)
const ontoGhost = await dropAt(dragged, FAR.x, FAR.y)
check(
  'a card dropped where only a subagent sits stays exactly there',
  ontoGhost.stayed,
  `asked for ${FAR.x},${FAR.y} and got ${ontoGhost.x},${ontoGhost.y}`,
)

// --- nor may a card the owner has closed ---

const PARKED_SPOT = { x: 9000, y: 9000 }
await dropAt(parked, PARKED_SPOT.x, PARKED_SPOT.y)
ws.send(JSON.stringify({ t: 'session.close', sessionId: parked.id }))
await sleep(600)
check('the parked card is closed', at(parked.id)?.closedAt !== null)

const ontoParked = await dropAt(dragged, PARKED_SPOT.x, PARKED_SPOT.y)
check(
  'a card dropped where only a closed card sits stays exactly there',
  ontoParked.stayed,
  `asked for ${PARKED_SPOT.x},${PARKED_SPOT.y} and got ${ontoParked.x},${ontoParked.y}`,
)

// --- the controls: a drawn card still holds its ground ---

const HOME = { x: 12000, y: 12000 }
await dropAt(parent, HOME.x, HOME.y)
const before = at(parent.id)
const ontoParent = await dropAt(dragged, HOME.x, HOME.y)
check(
  'a card dropped onto a card that IS drawn settles beside it instead',
  !ontoParent.stayed,
  `it landed on top at ${ontoParent.x},${ontoParent.y}`,
)
check(
  'and the card it was dropped on has not moved',
  at(parent.id).x === before.x && at(parent.id).y === before.y,
  `${at(parent.id).x},${at(parent.id).y} was ${before.x},${before.y}`,
)

console.log(failures ? `\n${failures} failed` : '\nall good')
await stop(failures ? 1 : 0)
