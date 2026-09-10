/**
 * The ceiling counts what the owner can see, and counts subagents separately.
 *
 * The failure this exists for happened to him for real: starting a card was refused because the
 * board held 22 against a ceiling of 12, and 19 of those 22 were spent subagent cards that the
 * canvas no longer draws. Garden refused something and could not show him why, which is the one
 * thing this project exists to prevent. Before the fix, the assertion below that a card is still
 * created while sessions plus subagents exceed the ceiling is the one that goes red, and it goes red
 * with the refusal quoting a figure the board does not show anywhere.
 *
 * A subagent is a background tool a session used, not agent work holding a context window of its
 * own, so it is counted and shown on its own with no limit beside it. The cost of that is real and
 * is named rather than hidden: after this, nothing bounds concurrent subagent work by count. The
 * answer to that is the working ceiling, which is persisted and not yet enforced.
 *
 * No terminals anywhere in here. Cards are made switched off and subagents are born from hook
 * payloads, which is how the CLI makes them, so this measures the counting and nothing else.
 *
 * Runs against a server of its own: its own port, its own workspace, its own database.
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

const CARD_CEILING = 6

const garden = await startInstance()
const PORT = garden.port

const dir = mkdtempSync(join(tmpdir(), 'garden-ceiling-counts-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], errors: [], limits: null }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'limits') st.limits = m
  else if (m.t === 'error') st.errors.push(m.message)
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

ws.send(
  JSON.stringify({
    t: 'limits.set',
    projectId: project.id,
    limits: { running: 30, cardsPerProject: CARD_CEILING, childrenPerCard: 20, working: 5 },
  }),
)
await sleep(400)

/** Switched off throughout: this is about how many may exist, not about spending tokens. */
const make = async (title) => {
  const before = st.sessions.length
  st.errors.length = 0
  ws.send(
    JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }),
  )
  await sleep(400)
  return { made: st.sessions.length > before, said: st.errors[0] ?? null }
}

const hook = async (sessionId, event) =>
  fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })

/*
 * A dispatch the way the CLI reports one: the tool call that asked for it, then the start event that
 * names it. Nothing here reaches into the database, so a subagent card in this test is the same row
 * by the same path as one on his board.
 */
const dispatch = async (parent, n) => {
  const toolUseId = `tu-${parent.id}-${n}`
  await hook(parent.id, {
    hook_event_name: 'PreToolUse',
    session_id: `cli-${parent.id}`,
    tool_name: 'Task',
    tool_use_id: toolUseId,
    tool_input: { description: `read around thing ${n}`, subagent_type: 'general-purpose' },
  })
  await hook(parent.id, {
    hook_event_name: 'SubagentStart',
    session_id: `cli-${parent.id}`,
    tool_use_id: toolUseId,
    agent_id: `agent-${parent.id}-${n}`,
    agent_type: 'general-purpose',
  })
  await sleep(250)
}

const limits = async () => {
  st.limits = null
  ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
  for (let i = 0; i < 20 && !st.limits; i++) await sleep(100)
  return st.limits
}

// --- a board of three cards and five subagents ---

const cards = []
for (let i = 1; i <= 3; i++) cards.push(await make(`Card ${i}`))
check('three cards were made', cards.every((c) => c.made))

const parent = st.sessions.find((s) => s.title === 'Card 1')
for (let i = 1; i <= 5; i++) await dispatch(parent, i)
const subagentRows = st.sessions.filter((s) => s.kind === 'subagent').length
check('five subagent cards exist as rows', subagentRows === 5, `${subagentRows} rows`)

const shown = await limits()
check(
  'the ceiling counts the cards he can see, and not the subagents',
  shown?.counted?.cards === 3,
  `counted.cards is ${shown?.counted?.cards}, board holds 3 cards and 5 subagents`,
)
check('subagents are counted on their own', shown?.counted?.subagents === 5, `counted.subagents is ${shown?.counted?.subagents}`)
check(
  'and carry no ceiling of their own',
  shown?.limits !== undefined && shown.limits.subagents === undefined,
  `limits: ${Object.keys(shown?.limits ?? {}).join(', ')}`,
)

// --- the failure he actually hit ---

/*
 * Three cards and five subagents is eight rows against a ceiling of six. Before the fix this refuses
 * and says the board holds eight, which is a number he cannot see anywhere: the canvas draws three.
 */
const fourth = await make('Card 4')
check('a fourth card is made, because subagents do not fill the board', fourth.made, fourth.said ?? '')

// --- and the ceiling still bites when the cards themselves reach it ---

for (let i = 5; i <= CARD_CEILING; i++) await make(`Card ${i}`)
const overflow = await make('One too many')
check('the ceiling still refuses when the cards themselves reach it', !overflow.made, overflow.said ?? 'it was created')
check(
  'and the refusal names the count that actually refused',
  new RegExp(`holds ${CARD_CEILING}\\b`).test(overflow.said ?? ''),
  overflow.said ?? '',
)

// --- nothing bounds subagents by count ---

for (let i = 6; i <= 9; i++) await dispatch(parent, i)
const after = await limits()
check('more subagents are still born past the card ceiling', after?.counted?.subagents === 9, `counted.subagents is ${after?.counted?.subagents}`)
check('and none of that changed the card figure', after?.counted?.cards === CARD_CEILING, `counted.cards is ${after?.counted?.cards}`)

console.log(failures ? `\n${failures} failed` : '\nall good')
await stop(failures ? 1 : 0)
