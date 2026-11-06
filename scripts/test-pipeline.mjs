/**
 * The derived pipeline, end to end.
 *
 * Posts real hook payloads at the running receiver exactly as test-hook-spine.mjs does, so the
 * events land in the server's own database through the same ingest path a live CLI uses. Then it
 * reads the pipeline back with `derivePipeline`, imported from the built server output, against
 * the same database file the server itself has open (never GARDEN_DB, never a database of its
 * own), because the point is to prove what the real ingest path produces, not what this script
 * computed.
 *
 * It builds its own scratch project and removes it afterwards, same as every other hook test.
 * Test scripts sharing the owner's live workspace is how his real board got wrecked twice, and
 * `pipeline.ts` is not wired into the WebSocket protocol yet, so there is no message to ask the
 * server for its own view: reading its database directly is the honest option, not a shortcut.
 */
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../server/dist/store.js'
import { derivePipeline } from '../server/dist/pipeline.js'
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
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })
  await res.text()
  await sleep(150)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-pipeline-'))

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('scratch project added', !!project, project?.path ?? dir)
if (!project) process.exit(1)

const title = `PipelineTest ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2200)
const card = st.sessions.find((s) => s.title === title)
check('a card to attribute events to', !!card)
if (!card) process.exit(1)

const CLAUDE_SID = `pipe-${Date.now()}`
await hook(card.id, {
  hook_event_name: 'SessionStart',
  session_id: CLAUDE_SID,
  transcript_path: 'C:/nonexistent/transcript.jsonl',
  cwd: dir,
})

/*
 * Reads the database belonging to the instance this test just started, named explicitly.
 *
 * It used to take the default path, which was the same file as the running server's only because
 * the test was posting its hooks at the owner's live Garden. Once the test got a server of its own,
 * the hooks went into the instance's database and this handle went on reading his, so every run
 * came back missing and the test failed while the code was correct.
 *
 * Opening a second better-sqlite3 handle on a WAL database for reads is safe while the server holds
 * the writer.
 */
const store = new Store(join(garden.home, 'garden.db'))

function findRun(runs, ask) {
  return runs.find((r) => r.ask === ask)
}
function stage(run, id) {
  return run.stages.find((s) => s.id === id)
}

// --- Run A: every stage reached ---

const PROMPT_A = `prompt-a-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT_A, prompt: 'run the full workflow' })
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_A,
  tool_name: 'Write', tool_input: { file_path: 'C:/proj/docs/canonical/feature-truth.md' },
})
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_A,
  tool_name: 'Write', tool_input: { file_path: 'C:/proj/.claude/work-orders/feature.md' },
})
const AGENT_A = `agent-a-${Date.now()}`
await hook(card.id, { hook_event_name: 'SubagentStart', session_id: CLAUDE_SID, prompt_id: PROMPT_A, agent_id: AGENT_A, agent_type: 'general-purpose' })
await hook(card.id, { hook_event_name: 'SubagentStop', session_id: CLAUDE_SID, prompt_id: PROMPT_A, agent_id: AGENT_A })
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_A,
  tool_name: 'Edit', tool_input: { file_path: 'C:/proj/src/feature.ts' },
})
await hook(card.id, {
  hook_event_name: 'PreToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_A,
  tool_name: 'Task', tool_input: { description: 'run a blind review of the change' },
})
await hook(card.id, {
  hook_event_name: 'PreToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_A,
  tool_name: 'Bash', tool_input: { command: 'git commit -m "feature"' },
})
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT_A })

let runs = derivePipeline(store, card.id)
let runA = findRun(runs, 'run the full workflow')
check('run A found', !!runA)
if (runA) {
  for (const id of ['intake', 'canon', 'plan', 'dispatch', 'code', 'review', 'close']) {
    const s = stage(runA, id)
    check(`run A: ${id} reached`, s?.state === 'reached', `${s?.state} -- ${s?.why}`)
  }
  check('run A: canon is structured', stage(runA, 'canon')?.provenance === 'structured')
  check('run A: canon evidence names the file', stage(runA, 'canon')?.evidence[0]?.detail.includes('feature-truth.md'))
  check('run A: dispatch is structured', stage(runA, 'dispatch')?.provenance === 'structured')
  check('run A: review is inferred, not structured', stage(runA, 'review')?.provenance === 'inferred')
  check('run A: close evidence is the literal command', stage(runA, 'close')?.evidence[0]?.detail.includes('git commit'))
}

// --- Run B: canon never written, run still open ---
// An open run must read as unknown, with a specific reason, never as reached. Reaching this from
// silence is exactly what the pipeline must never do.

const PROMPT_B = `prompt-b-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT_B, prompt: 'skip the canon doc' })
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_B,
  tool_name: 'Edit', tool_input: { file_path: 'C:/proj/src/other.ts' },
})

runs = derivePipeline(store, card.id)
let runB = findRun(runs, 'skip the canon doc')
check('run B found', !!runB)
if (runB) {
  const canon = stage(runB, 'canon')
  check('run B: canon is unknown, not reached', canon?.state === 'unknown', canon?.state)
  check('run B: canon gives a specific reason', canon?.why.includes('no canon write seen'), canon?.why)
  check('run B: code is reached from the real edit', stage(runB, 'code')?.state === 'reached')
}

await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT_B })
runs = derivePipeline(store, card.id)
runB = findRun(runs, 'skip the canon doc')
check('run B once closed: canon reads not-reached, still never reached', stage(runB, 'canon')?.state === 'not-reached', stage(runB, 'canon')?.state)

// --- Run C: only ExitPlanMode fired ---

const PROMPT_C = `prompt-c-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT_C, prompt: 'just show me the plan' })
await hook(card.id, {
  hook_event_name: 'PreToolUse', session_id: CLAUDE_SID, prompt_id: PROMPT_C,
  tool_name: 'ExitPlanMode', tool_input: {},
})
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT_C })

runs = derivePipeline(store, card.id)
const runC = findRun(runs, 'just show me the plan')
check('run C found', !!runC)
if (runC) {
  const plan = stage(runC, 'plan')
  check('run C: plan reached from ExitPlanMode alone', plan?.state === 'reached', plan?.state)
  check('run C: plan is inferred, not structured, without a plan file', plan?.provenance === 'inferred', plan?.provenance)
}

// --- Run D: a closed turn with nothing but the prompt ---
// The invariant this whole file exists to check: silence never flips a stage to reached.

const PROMPT_D = `prompt-d-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT_D, prompt: 'do nothing at all' })
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT_D })

runs = derivePipeline(store, card.id)
const runD = findRun(runs, 'do nothing at all')
check('run D found', !!runD)
if (runD) {
  for (const id of ['canon', 'plan', 'dispatch', 'code', 'review', 'close']) {
    const s = stage(runD, id)
    check(`run D: ${id} is not-reached, never reached from silence`, s?.state === 'not-reached', s?.state)
  }
}

// --- cleanup ---

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(600)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
