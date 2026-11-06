/**
 * The hook spine, end to end.
 *
 * Posts real hook payloads at the receiver exactly as the CLI would, then checks what the board
 * actually holds. Every assertion reads the server's own state over the socket rather than
 * anything this script computed, because a test that believes its own arithmetic proves nothing.
 *
 * It builds its own scratch project and removes it afterwards. Test scripts sharing the owner's
 * live workspace is how his real board got wrecked twice.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

/** The newest subagent transcript this machine actually holds, or null if there are none. */
function globSubagentTranscript() {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return null
  let best = null
  for (const proj of readdirSync(root)) {
    const projDir = join(root, proj)
    let sessions
    try { sessions = readdirSync(projDir) } catch { continue }
    for (const sid of sessions) {
      const subs = join(projDir, sid, 'subagents')
      if (!existsSync(subs)) continue
      for (const f of readdirSync(subs)) {
        if (!f.endsWith('.jsonl')) continue
        const abs = join(subs, f)
        const m = statSync(abs).mtimeMs
        if (!best || m > best.m) best = { abs, m }
      }
    }
  }
  return best?.abs ?? null
}

const garden = await target()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(gardenSessionId, event) {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })
  await res.text()
  // The receiver answers before it processes, so give the board a moment to catch up.
  await sleep(180)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-hook-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [], work: [], pulses: [], docs: [], content: {} }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'session.removed') st.sessions = st.sessions.filter((s) => s.id !== m.sessionId)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'wire.pulse') st.pulses.push(m.wireId)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.content') st.content[m.cardId] = m.content
  else if (m.t === 'work') st.work = m.records
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('scratch project added', !!project, project?.path ?? dir)
if (!project) process.exit(1)

const title = `HookTest ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2200)
const card = st.sessions.find((s) => s.title === title)
check('a card to attribute events to', !!card)
if (!card) process.exit(1)

const cur = () => st.sessions.find((s) => s.id === card.id)
check('a launched card claims no more than launched', cur().status === 'idle', cur().status)

const CLAUDE_SID = `test-${Date.now()}`
const PROMPT = `prompt-${Date.now()}`

await hook(card.id, {
  hook_event_name: 'SessionStart',
  session_id: CLAUDE_SID,
  transcript_path: 'C:/nonexistent/transcript.jsonl',
  cwd: dir,
})
check('the CLI session id is learned, not guessed', cur().claudeSessionId === CLAUDE_SID, String(cur().claudeSessionId))

await hook(card.id, {
  hook_event_name: 'UserPromptSubmit',
  session_id: CLAUDE_SID,
  prompt_id: PROMPT,
  prompt: 'refactor the widget loader',
})
check('a prompt sets the card working', cur().status === 'working', cur().status)

ws.send(JSON.stringify({ t: 'work.list', sessionId: card.id }))
await sleep(300)
check('the turn is recorded with what was asked',
  st.work.some((w) => w.ask.includes('widget loader') && w.origin === 'owner'),
  JSON.stringify(st.work.map((w) => [w.origin, w.ask.slice(0, 24)])))

await hook(card.id, {
  hook_event_name: 'PostToolUse',
  session_id: CLAUDE_SID,
  prompt_id: PROMPT,
  tool_name: 'Edit',
  tool_input: { file_path: 'C:/scratch/loader.ts' },
})
ws.send(JSON.stringify({ t: 'work.list', sessionId: card.id }))
await sleep(300)
check('a file written during the turn is recorded',
  st.work.some((w) => w.filesTouched.includes('C:/scratch/loader.ts')),
  JSON.stringify(st.work[0]?.filesTouched ?? []))

// --- dispatch ---

const TOOL_USE = `tu-${Date.now()}`
await hook(card.id, {
  hook_event_name: 'PreToolUse',
  session_id: CLAUDE_SID,
  prompt_id: PROMPT,
  tool_name: 'Task',
  tool_use_id: TOOL_USE,
  tool_input: { description: 'audit the loader', subagent_type: 'Explore' },
})
const AGENT = `agent-${Date.now()}`
await hook(card.id, {
  hook_event_name: 'SubagentStart',
  session_id: CLAUDE_SID,
  prompt_id: PROMPT,
  tool_use_id: TOOL_USE,
  agent_id: AGENT,
  agent_type: 'Explore',
})

const child = st.sessions.find((s) => s.parentId === card.id)
check('a dispatch creates a child card', !!child, child?.title)
check('the child is named from the dispatch, not numbered', child?.title === 'audit the loader', child?.title)
check('the child carries its agent type', child?.role === 'Explore', String(child?.role))
check('the child is an agent, not a process', child?.kind === 'subagent' && child?.pid === null, `${child?.kind}/${child?.pid}`)

const wire = st.wires.find((w) => w.sourceId === card.id && w.targetId === child?.id)
check('parent and child are wired', !!wire, wire?.kind)
check('the wire is marked derived, not drawn', wire?.kind === 'derived', String(wire?.kind))
check('the wire pulsed when the dispatch fired', st.pulses.includes(wire?.id), `${st.pulses.length} pulses`)

// A child card must not be duplicated if the same start arrives twice.
await hook(card.id, {
  hook_event_name: 'SubagentStart',
  session_id: CLAUDE_SID,
  tool_use_id: TOOL_USE,
  agent_id: AGENT,
  agent_type: 'Explore',
})
check('a repeated start does not clone the card',
  st.sessions.filter((s) => s.parentId === card.id).length === 1,
  String(st.sessions.filter((s) => s.parentId === card.id).length))

await hook(card.id, {
  hook_event_name: 'SubagentStop',
  session_id: CLAUDE_SID,
  agent_id: AGENT,
  agent_transcript_path: 'C:/nonexistent/agent.jsonl',
})
const stopped = st.sessions.find((s) => s.id === child.id)
check('a finished subagent stays on the board', !!stopped, stopped?.status)
check('and reads as done rather than gone', stopped?.status === 'done', String(stopped?.status))
check('holding the path to its transcript', stopped?.transcriptPath === 'C:/nonexistent/agent.jsonl', String(stopped?.transcriptPath))

// --- waiting ---

await hook(card.id, {
  hook_event_name: 'Notification',
  session_id: CLAUDE_SID,
  waiting_for: 'permission prompt',
})
check('a permission prompt reads as needing the owner', cur().status === 'needs-input', cur().status)
check('and says what it is waiting for', cur().waitingFor === 'permission prompt', String(cur().waitingFor))
check('and when it started waiting', typeof cur().statusSince === 'number', String(cur().statusSince))

await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT })
check('finishing a turn returns the card to idle', cur().status === 'idle', cur().status)

ws.send(JSON.stringify({ t: 'work.list', sessionId: card.id }))
await sleep(300)
check('the turn is closed with an end time', st.work.some((w) => w.promptId === PROMPT && w.endedAt), JSON.stringify(st.work[0] ?? {}))

// An event naming a card that does not exist must be dropped, never applied to a neighbour.
const before = st.sessions.length
await hook('no-such-card', { hook_event_name: 'UserPromptSubmit', session_id: 'nope', prompt: 'x' })
check('an event for an unknown card changes nothing', st.sessions.length === before, `${before} -> ${st.sessions.length}`)

// --- the transcript a finished agent leaves behind ---

const real = globSubagentTranscript()
if (real) {
  await hook(card.id, {
    hook_event_name: 'SubagentStop',
    session_id: CLAUDE_SID,
    agent_id: AGENT,
    agent_transcript_path: real,
  })
  ws.send(JSON.stringify({ t: 'transcript.open', sessionId: child.id }))
  await sleep(1200)
  const doc = st.docs?.find((d) => d.ownerId === child.id && d.group === 'transcript')
  check('a finished agent opens its own transcript', !!doc, doc?.title)
  if (doc) {
    ws.send(JSON.stringify({ t: 'doc.read', cardId: doc.id }))
    await sleep(500)
    const body = st.content?.[doc.id] ?? ''
    check('and it holds the real conversation', body.includes('# Transcript') && body.length > 200, `${body.length} chars`)
  }
} else {
  console.log('SKIP  transcript rendering: no subagent transcript on this machine to read')
}

// --- cleanup ---

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(500)
check('deleting the parent takes its subagent cards with it',
  !st.sessions.some((s) => s.id === child.id),
  String(st.sessions.filter((s) => s.projectId === project.id).length))

ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(600)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
