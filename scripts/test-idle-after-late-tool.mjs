/**
 * A card that has stopped is idle, even when a tool event arrives after its Stop.
 *
 * The Keeper's own events on 24 September, in order: Stop, then a PreToolUse (ScheduleWakeup) 2 s
 * later with no PostToolUse, then a SubagentStop, then the CLI's idle notice a minute on. The late
 * PreToolUse put the card back to working and nothing cleared it, so it read as working for 29
 * minutes and a false card-quiet finding was raised. The idle notice is the CLI saying it is at an
 * empty prompt, so it has to win.
 *
 * Its own instance, port and home through `target()`. Needs `npm run build` first.
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

async function hook(sessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(300)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-late-tool-'))
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
await sleep(800)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); await garden.stop(); process.exit(1) }

const title = `Late tool ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
let card = null
for (let i = 0; i < 40 && !card; i++) { await sleep(250); card = st.sessions.find((s) => s.title === title) }
if (!card) { console.log('FAIL  scratch card'); await garden.stop(); process.exit(1) }
const status = () => st.sessions.find((s) => s.id === card.id)?.status

const SID = `late-${Date.now()}`
await hook(card.id, { hook_event_name: 'SessionStart', session_id: SID })
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: 'p1', prompt: 'patrol' })
await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo' } })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo' } })
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: 'p1' })
check('the Stop leaves the card idle', status() === 'idle', status())

// A background subagent's tool calls come in under the card, marked with agent_type, and are not its turn.
await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_use_id: 's1', agent_type: 'general-purpose', tool_input: { file_path: 'x' } })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Read', tool_use_id: 's1', agent_type: 'general-purpose', tool_input: { file_path: 'x' } })
check('a background subagent working leaves the card idle', status() === 'idle', status())

await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'ScheduleWakeup', tool_use_id: 't2', tool_input: { delaySeconds: 1800 } })
await hook(card.id, { hook_event_name: 'SubagentStop', session_id: SID })
// What the Keeper saw: the late tool event reads as a turn. This is the state the fix has to clear.
check('the late PreToolUse still reads as working (a tool call is proof of a turn)', status() === 'working', status())

await hook(card.id, { hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
check('the idle notice puts it back to idle', status() === 'idle', status())

// And the notice never lowers a question: a card waiting on a permission prompt stays that way.
await hook(card.id, { hook_event_name: 'Notification', session_id: SID, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
check('a permission prompt still reads as needs-input', status() === 'needs-input', status())
await hook(card.id, { hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
check('and a later idle notice does not clear the question', status() === 'needs-input', status())

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
