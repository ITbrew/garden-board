/**
 * History records changes, and stores only what something reads.
 *
 * Two complaints from the owner on 2026-09-08, one about what he opens and one about what it costs.
 *
 * What he opened was his own card's history, and found twenty consecutive pages titled "A message
 * just arrived on one of your wires", each ending "No writes were observed during this turn." A
 * harness wake-up makes exactly one tool call, and making a tool call was enough to earn a page, so
 * the bound on history bounded the count and not the content. He said what it is for: "its meant to
 * be historical event changes to the canon/code base to track changes for the app". So a page is a
 * change now, not an activity, and a page that exists is short.
 *
 * What it cost was 234,883 rows and 1,026 MB in about a month, of which 802 MB was `tool_response`,
 * the full body every tool returned. Nothing in the repository has ever read that field. It is
 * dropped at the point of writing now, along with everything else on a tool payload that has no
 * reader.
 *
 * Both halves are checked against what actually landed: files on disk, and rows in SQLite. Its own
 * instance, its own port, its own home. Never the owner's board.
 */
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

async function postHook(gardenSessionId, event, ts) {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: ts, event }),
  })
  if (!res.ok) throw new Error(`hook post failed: ${res.status}`)
}

let clock = Date.now() - 60 * 60 * 1000
const tick = () => (clock += 1000)

/** A body the size a real tool result reaches. This is the thing that must not reach the database. */
const FAT = 'x'.repeat(40_000)

/** An ask longer than a page should ever quote, with a second paragraph a page should not reach. */
const LONG_ASK = `${'why is this happening '.repeat(60)}\n\nand a second paragraph nobody should see on the page`

const dir = mkdtempSync(join(tmpdir(), 'garden-concise-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], groups: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'history.groups') st.groups = m.groups
  else if (m.t === 'error') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await garden.stop()
  process.exit(1)
}

ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Card', start: false }))
await sleep(700)
const session = st.sessions.find((s) => s.title === 'Card')
check('the card exists', !!session)
if (!session) {
  await garden.stop()
  process.exit(1)
}

// --- a turn that only looked at things ---
//
// Four tool calls, no write. Pre-fix this earned a full page saying it wrote nothing, which is the
// exact shape of the twenty pages the owner objected to.
await postHook(session.id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'look', prompt: 'READONLY: a message just arrived on one of your wires' }, tick())
for (const tool of ['Read', 'Grep', 'Glob', 'Bash']) {
  await postHook(
    session.id,
    { hook_event_name: 'PostToolUse', prompt_id: 'look', tool_name: tool, tool_input: { file_path: 'C:/scratch/looked-at.md' }, tool_response: FAT },
    tick(),
  )
}
await postHook(session.id, { hook_event_name: 'Stop', prompt_id: 'look' }, tick())

// --- a turn that changed something ---
await postHook(session.id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'write', prompt: LONG_ASK }, tick())
await postHook(
  session.id,
  {
    hook_event_name: 'PostToolUse',
    prompt_id: 'write',
    tool_name: 'Write',
    tool_input: { file_path: 'C:/scratch/changed.ts', content: FAT },
    tool_response: FAT,
  },
  tick(),
)
await postHook(session.id, { hook_event_name: 'Stop', prompt_id: 'write' }, tick())

st.groups = []
ws.send(JSON.stringify({ t: 'history.open', sessionId: session.id }))
await sleep(800)
for (const g of st.groups ?? []) {
  if (!g.group || g.group === 'conversation' || g.group === 'reports') continue
  ws.send(JSON.stringify({ t: 'history.open', sessionId: session.id, group: g.group }))
  await sleep(700)
}

const historyDir = join(garden.home, 'history', session.id)
const pages = readdirSync(historyDir).filter((f) => /^\d{3}-/.test(f))
const bodies = pages.map((f) => ({ name: f, text: readFileSync(join(historyDir, f), 'utf8') }))

// Pre-fix: `hasSubstance` passed anything with `toolCalls > 0`, so the read-only turn got a page.
check(
  'a turn that only read and searched earns no page',
  !bodies.some((b) => b.text.includes('READONLY')),
  bodies.map((b) => b.name).join(', '),
)
const changed = bodies.find((b) => b.text.includes('C:/scratch/changed.ts'))
check('a turn that wrote a file does', !!changed, pages.join(', '))

if (changed) {
  // Pre-fix: the page fenced up to 8000 characters of the ask, so a long question was the page.
  check('the page is short', changed.text.length < 1200, `${changed.text.length} bytes`)
  // Pre-fix: "- Tool calls: 1" was the fourth line of every page. It measures effort, not change.
  check('the page does not count tool calls', !/tool call/i.test(changed.text), changed.text.slice(0, 300))
  // The one thing the owner said history is for.
  check('the page names what changed', changed.text.includes('- C:/scratch/changed.ts'))
  // Pre-fix: nothing bounded the quote beyond 8000 characters, so a second paragraph came with it.
  check('the ask is quoted, not reproduced', !changed.text.includes('nobody should see on the page'))
  check('and enough of it survives to recognise the turn', changed.text.includes('why is this happening'))
}

// --- what actually reached the database ---

const db = new Database(join(garden.home, 'garden.db'), { readonly: true })
const rows = db
  .prepare("SELECT payload FROM events WHERE sessionId = ? AND type = 'PostToolUse'")
  .all(session.id)
db.close()

check('the tool calls were recorded', rows.length === 5, `${rows.length} PostToolUse rows`)
const payloads = rows.map((r) => JSON.parse(r.payload))

// Pre-fix: every one of these carried the full 40 KB body, and no reader has ever opened it.
check(
  'no stored tool event carries the tool response',
  payloads.every((p) => p.tool_response === undefined),
  `${payloads.filter((p) => p.tool_response !== undefined).length} of ${payloads.length} still carry it`,
)
// The write call's `content` is the same waste wearing a different key.
check(
  'nor the body of what was written',
  payloads.every((p) => p.tool_input?.content === undefined),
)
const biggest = Math.max(...rows.map((r) => r.payload.length))
check('so a stored tool event is small', biggest < 1000, `largest payload ${biggest} bytes`)

// Everything a reader does open has to survive the trim, or the trim has broken the pipeline, the
// dispatch tracker and the image list instead of just shrinking them.
const written = payloads.find((p) => p.tool_name === 'Write')
check('the tool name survives', written?.tool_name === 'Write')
check('the file path survives', written?.tool_input?.file_path === 'C:/scratch/changed.ts')
check('the prompt id survives', written?.prompt_id === 'write')

await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
