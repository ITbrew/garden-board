/**
 * Runs worth looking at, so the pipeline view can be judged on a real picture.
 *
 * A screenshot of a view whose every stage looks identical proves nothing about a design whose
 * entire point is that stages do not look identical. This puts four runs into one scratch card
 * that between them exercise every state and both provenances:
 *
 *   A  every stage reached, review inferred and everything else structured
 *   B  left deliberately OPEN, so its untouched stages are unknown rather than not-reached
 *   C  a plan seen only as an ExitPlanMode call, which is the other inferred case
 *   D  closed with nothing but the prompt, so every stage after intake is not-reached
 *
 * It posts real hook payloads at the running receiver, exactly as test-pipeline.mjs does, so the
 * events land through the same ingest path a live CLI uses rather than being written straight into
 * the database.
 *
 * It creates its own scratch project in a temp directory and never touches the owner's workspace.
 * Test scripts sharing his live board is how it got wrecked twice. Cleanup is a separate mode and
 * deletes only the two ids this script wrote down when it created them, never anything it found.
 *
 *   node scripts/seed-pipeline-runs.mjs           seed, and print the ids
 *   node scripts/seed-pipeline-runs.mjs --clean   remove exactly what the last seed created
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = join(ROOT, 'docs', 'shots', '.pipeline-seed.json')
const PORT = Number(process.env.GARDEN_PORT) || 5178
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'error') console.log('server refused:', m.message, m.forT ?? '')
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

// --- cleanup mode ---------------------------------------------------------

if (process.argv.includes('--clean')) {
  if (!existsSync(STAMP)) {
    console.log('nothing to clean: no seed stamp at', STAMP)
    ws.close()
    process.exit(0)
  }
  // Only the ids this script recorded at creation time. Never a project or card found by
  // scanning, because ownership inferred from a scan is how somebody else's data gets deleted.
  const seed = JSON.parse(readFileSync(STAMP, 'utf8'))
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: seed.sessionId }))
  await sleep(600)
  ws.send(JSON.stringify({ t: 'project.remove', projectId: seed.projectId }))
  await sleep(800)
  rmSync(STAMP, { force: true })
  if (seed.dir && seed.dir.toLowerCase().includes('garden-pipeline-')) rmSync(seed.dir, { recursive: true, force: true })
  console.log('removed scratch card', seed.sessionId, 'and project', seed.projectId)
  ws.close()
  process.exit(0)
}

// --- seed mode ------------------------------------------------------------

async function hook(gardenSessionId, event) {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })
  await res.text()
  await sleep(120)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-pipeline-'))
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAILED: scratch project was not added')
  process.exit(1)
}

const title = 'Pipeline sample'
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2400)
const card = st.sessions.find((s) => s.title === title && s.projectId === project.id)
if (!card) {
  console.log('FAILED: scratch card was not created')
  process.exit(1)
}

// Written before any events, so cleanup can undo the creation even if seeding dies halfway.
writeFileSync(STAMP, JSON.stringify({ projectId: project.id, sessionId: card.id, dir }, null, 2))

const SID = `pipe-seed-${Date.now()}`
await hook(card.id, {
  hook_event_name: 'SessionStart',
  session_id: SID,
  transcript_path: 'C:/nonexistent/transcript.jsonl',
  cwd: dir,
})

// Run A: the whole workflow, so a reader can see what a complete turn looks like. Review is the
// only inferred stage here, and it is inferred because a task description said the word.
const A = `seed-a-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: A, prompt: 'add the pipeline view end to end' })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, prompt_id: A, tool_name: 'Write', tool_input: { file_path: 'C:/proj/docs/canonical/pipeline-truth.md' } })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, prompt_id: A, tool_name: 'Write', tool_input: { file_path: 'C:/proj/.claude/work-orders/pipeline-view.md' } })
const AG = `seed-agent-${Date.now()}`
await hook(card.id, { hook_event_name: 'SubagentStart', session_id: SID, prompt_id: A, agent_id: AG, agent_type: 'general-purpose' })
await hook(card.id, { hook_event_name: 'SubagentStop', session_id: SID, prompt_id: A, agent_id: AG })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, prompt_id: A, tool_name: 'Edit', tool_input: { file_path: 'C:/proj/apps/web/src/pipeline-node.tsx' } })
await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, prompt_id: A, tool_name: 'Task', tool_input: { description: 'run a blind review of the change' } })
await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, prompt_id: A, tool_name: 'Bash', tool_input: { command: 'git commit -m "draw the pipeline"' } })
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: A })

// Run C before B, so the open run sorts last and is easy to find in a screenshot. Plan reached
// from an ExitPlanMode call alone: the agent says it presented a plan, no plan file exists.
const C = `seed-c-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: C, prompt: 'just talk me through the approach' })
await hook(card.id, { hook_event_name: 'PreToolUse', session_id: SID, prompt_id: C, tool_name: 'ExitPlanMode', tool_input: {} })
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: C })

// Run D: a closed turn carrying nothing but its prompt. Silence never flips a stage to reached,
// and a closed run says not-reached rather than unknown.
const D = `seed-d-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: D, prompt: 'what does this file do' })
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: D })

// Run B last and left open on purpose. No Stop event, so its untouched stages must read unknown.
// This is the run the whole review turns on: unknown drawn as blank collapses three states to two.
const B = `seed-b-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: B, prompt: 'fix the terminal focus bug' })
await hook(card.id, { hook_event_name: 'PostToolUse', session_id: SID, prompt_id: B, tool_name: 'Edit', tool_input: { file_path: 'C:/proj/apps/web/src/dock.tsx' } })

console.log('project   ', project.id, dir)
console.log('card      ', card.id, title)
console.log('runs      ', 'A full / C plan-only / D bare / B still open')
console.log('stamp     ', STAMP)
console.log('\nclean up with: node scripts/seed-pipeline-runs.mjs --clean')
ws.close()
process.exit(0)
