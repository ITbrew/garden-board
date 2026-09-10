/**
 * The history web: one card per turn, each backed by a real file.
 *
 * What is being checked is that the card says what was asked and who asked it, and that opening
 * the card shows the file rather than a panel that vanishes with the app. The origin distinction
 * is the point of the feature: the owner could never tell which work he asked for and which
 * arrived from another agent.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

const garden = await target()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(gardenSessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(150)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-hist-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], docs: [], wires: [], content: {} }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'doc.content') st.content[m.cardId] = m.content
  else if (m.t === 'history.groups') st.groups = m.groups
  else if (m.t === 'wire.added') st.wires.push(m.wire)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const title = `HistTest ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2000)
const card = st.sessions.find((s) => s.title === title)
if (!card) { console.log('FAIL  scratch card'); process.exit(1) }

const SID = `hist-${Date.now()}`
await hook(card.id, { hook_event_name: 'SessionStart', session_id: SID })

// A turn the owner asked for.
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: 'p1', prompt: 'rename the loader module' })
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: SID, prompt_id: 'p1',
  tool_name: 'Write', tool_input: { file_path: 'C:/scratch/loader.ts' },
})
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: 'p1' })

// A turn another agent dispatched.
await hook(card.id, {
  hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p2',
  tool_name: 'Task', tool_use_id: 'tu-hist', tool_input: { description: 'check the rename', subagent_type: 'Explore' },
})
await hook(card.id, {
  hook_event_name: 'SubagentStart', session_id: SID, prompt_id: 'p2',
  tool_use_id: 'tu-hist', agent_id: 'ag-hist', agent_type: 'Explore',
})
const child = st.sessions.find((s) => s.parentId === card.id)
check('a subagent card exists to own dispatched work', !!child)
check('and is coloured by its role', !!child?.color, String(child?.color))

/*
 * Two steps now, and the first one draws nothing on purpose.
 *
 * A bare `history.open` used to put every turn a card had ever taken on the board at once, which on
 * the orchestrator meant dozens of cards arriving together; the owner's words for the same fault in
 * the roots were "makes it too laggy the way it is right now". So it answers with the days that
 * exist and draws nothing, and a day is unfolded by asking for that day by name (see the
 * `history.open` case in server/src/index.ts).
 *
 * This test asked once, with no day, and then checked the board for cards. It had been reporting
 * zero cards ever since, which reads as history being broken when it is the arrow doing what it was
 * changed to do. Nothing was wrong with the record: the work row carries the ask, the file touched
 * and the tool count exactly as before.
 */
ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id }))
await sleep(900)
check('asking with no day answers with the days that exist', (st.groups ?? []).length > 0,
  JSON.stringify(st.groups ?? []).slice(0, 120))

const day = (st.groups ?? []).find((g) => g.group && g.group !== 'conversation' && g.group !== 'reports')
if (!day) { console.log('FAIL  no day to open'); process.exit(1) }

ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id, group: day.group }))
await sleep(1200)
const web = st.docs.filter((d) => d.ownerId === card.id && d.web === 'history')
check('the history web unfolds one card per turn', web.length === 1, `${web.length} cards`)
check('the card is named after what was asked', web[0]?.title.includes('rename'), String(web[0]?.title))
/*
 * The group is the DAY now. Origin is shown in the card's name.
 *
 * These two asserted `group === 'asked'` and `group === 'dispatched'`, which was where the origin
 * lived when the arrow unfolded every turn at once. Days became the grouping when the arrow changed
 * to opening one day at a time, and the distinction the owner actually needs, work he asked for
 * against work another agent dispatched, moved to the card's name and its file. It is still there,
 * which is what these check now.
 */
check('a turn the owner asked for is not marked as coming from an agent', !/^from agent:/i.test(web[0]?.title ?? ''), String(web[0]?.title))

const wire = st.wires.find((w) => w.targetId === web[0]?.id)
check('the turn is wired to its session as history', wire?.kind === 'history', String(wire?.kind))

ws.send(JSON.stringify({ t: 'doc.read', cardId: web[0].id }))
await sleep(500)
const text = st.content[web[0].id] ?? ''
check('opening the card shows the real file', text.includes('rename the loader module'), text.slice(0, 60))
// Lower case and on the fact line since the pages were shortened on 2026-09-08; it was its own
// sentence ("Asked by you, typed into this session.") before that. The claim is unchanged: a page
// says whether the owner typed this or another card dispatched it.
check('the file says who asked', text.includes('asked by you'), text.includes('dispatched by') ? 'said dispatched' : 'no origin line')
check('the file lists what was written', text.includes('C:/scratch/loader.ts'), 'missing file list')

// The dispatched turn belongs to the child card, which is where it happened. Same two steps: ask
// which days it has, then unfold one.
st.groups = []
ws.send(JSON.stringify({ t: 'history.open', sessionId: child.id }))
await sleep(900)
const childDay = (st.groups ?? []).find((g) => g.group && g.group !== 'conversation' && g.group !== 'reports')
check('the subagent is offered a day of its own', !!childDay, JSON.stringify(st.groups ?? []).slice(0, 120))
ws.send(JSON.stringify({ t: 'history.open', sessionId: child.id, group: childDay?.group ?? 'dispatched' }))
await sleep(1100)
const childWeb = st.docs.filter((d) => d.ownerId === child.id && d.web === 'history')
check('the subagent has its own history', childWeb.length === 1, `${childWeb.length} cards`)
check('and a dispatched one says so in its name', /^from agent:/i.test(childWeb[0]?.title ?? ''), String(childWeb[0]?.title))
check('and named from the dispatch', childWeb[0]?.title.includes('check the rename'), String(childWeb[0]?.title))

ws.send(JSON.stringify({ t: 'doc.read', cardId: childWeb[0].id }))
await sleep(500)
const childText = st.content[childWeb[0].id] ?? ''
check('the dispatched file names the card that sent it', childText.includes(title), childText.slice(0, 80))

// Reopening must not stack duplicates.
ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id }))
await sleep(900)
check('reopening does not duplicate the web',
  st.docs.filter((d) => d.ownerId === card.id && d.web === 'history').length === 1,
  String(st.docs.filter((d) => d.ownerId === card.id && d.web === 'history').length))

ws.send(JSON.stringify({ t: 'history.close', sessionId: card.id }))
await sleep(600)
check('folding it away removes exactly its cards',
  st.docs.filter((d) => d.ownerId === card.id && d.web === 'history').length === 0 &&
  st.docs.filter((d) => d.ownerId === child.id && d.web === 'history').length === 1,
  'the other card kept its own')

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(600)
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(600)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
