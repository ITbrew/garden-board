/**
 * Proves the context gauge follows a compaction, and that a fixed window table reaches old rows.
 *
 * The owner's report: "Live-Match UIUX is showing 85% context with only a few messages ever."
 * His card had compacted seven minutes earlier. The CLI wrote its own `compact_boundary` line into
 * the transcript, `preTokens: 838017, postTokens: 13607`, and Garden's usage scan walked straight
 * past it to the newest `message.usage` line, which still described the conversation the CLI had
 * already thrown away. Nine of his eleven live cards had compacted that same day, so this is not
 * an edge case, it is most of the board most of the time.
 *
 * Second half: `contextUsed` used to be a fraction baked in at write time from whatever the window
 * table said that day. Three of his sonnet-5 subagents were pinned at a hard 100% from an older
 * table that gave sonnet-5 a 200,000 window instead of a million, and no later fix to the table
 * could reach a row already written. This checks that the fraction is derived at read time from
 * the token count and the model, so one correction to the table reaches every row.
 *
 * Uses a real transcript file on disk, because `readUsage` reads the file directly rather than
 * trusting anything posted over the wire.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
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
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
  })
  await res.text()
  await sleep(180)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-compact-'))
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
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('scratch project added', !!project)
if (!project) process.exit(1)

const title = `Compact ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2200)
const card = st.sessions.find((s) => s.title === title)
check('a card to attribute the transcript to', !!card)
if (!card) process.exit(1)
const cur = () => st.sessions.find((s) => s.id === card.id)

const CLAUDE_SID = `compact-${Date.now()}`
const transcript = join(dir, `${CLAUDE_SID}.jsonl`)
writeFileSync(transcript, '')

await hook(card.id, {
  hook_event_name: 'SessionStart',
  session_id: CLAUDE_SID,
  transcript_path: transcript.replace(/\\/g, '/'),
  cwd: dir,
})

// --- a full conversation, then a compaction that throws almost all of it away -----------------

const usageLine = (tokens) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 2, output_tokens: 0 },
    },
  }) + '\n'

const PROMPT = `p-${Date.now()}`
appendFileSync(transcript, usageLine(838017))
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT, prompt: 'ask' })
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT })
await sleep(2800) // the Stop handler reads usage twice, the second time on a 2.5s delay

check('before the compaction, the gauge reads the real spend', cur().tokensUsed === 838017, String(cur().tokensUsed))
check(
  'against a million-token window for Opus',
  Math.abs((cur().contextUsed ?? 0) - 838017 / 1_000_000) < 0.001,
  String(cur().contextUsed),
)

appendFileSync(
  transcript,
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 838017, postTokens: 13607 },
  }) + '\n',
)

const PROMPT2 = `p2-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT2, prompt: 'ask again' })
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT2 })
await sleep(2800)

check(
  'the gauge follows the compaction rather than the stale usage line before it',
  cur().tokensUsed === 13607,
  `stayed at ${cur().tokensUsed}, expected 13607`,
)
check(
  'and reads as a mostly-empty window, not 84% full',
  (cur().contextUsed ?? 1) < 0.02,
  String(cur().contextUsed),
)

// --- a fresh turn after the compaction overrides it again, as the newest real usage ------------

appendFileSync(transcript, usageLine(20000))
const PROMPT3 = `p3-${Date.now()}`
await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SID, prompt_id: PROMPT3, prompt: 'one more' })
await hook(card.id, { hook_event_name: 'Stop', session_id: CLAUDE_SID, prompt_id: PROMPT3 })
await sleep(2800)

check(
  'a turn taken after the compaction outranks the boundary itself',
  cur().tokensUsed === 20000,
  String(cur().tokensUsed),
)

ws.close()
await garden.stop?.()

// --- a fraction baked in under an old, wrong window table self-corrects on read -----------------

/*
 * Against the Store directly, in a throwaway database, rather than through the running server:
 * the running server always computes `contextUsed` correctly at write time now, so there is no
 * way to get a stale fraction onto a row by going through it. The bug this guards is in
 * `hydrateSession`, which reads a row back, so a row is written by hand with the fraction an
 * older window table would have produced and this checks what comes back out.
 */
const { Store } = await import('../server/src/store.ts')
const dbDir = mkdtempSync(join(tmpdir(), 'garden-stale-fraction-db-'))
const store = new Store(join(dbDir, 'test.db'))
const base = {
  id: 's1',
  projectId: 'p1',
  profileId: null,
  adapterId: 'claude',
  kind: 'subagent',
  title: 'atk-callchain',
  cwd: dir,
  pid: null,
  status: 'done',
  waitingFor: null,
  statusSince: Date.now(),
  agentId: null,
  parentId: null,
  transcriptPath: null,
  claudeSessionId: null,
  model: 'claude-sonnet-5',
  permissionMode: null,
  managed: false,
  x: 0,
  y: 0,
  width: 340,
  height: 260,
  renderState: 'preview',
  pinned: false,
  manualPos: false,
  collapsed: false,
  color: null,
  role: null,
  size: 'normal',
  tokensUsed: 235889,
  // Written as if by the old table, which gave sonnet-5 a 200,000 window: 235,889 / 200,000
  // clamped to 1, a hard 100%.
  contextUsed: 1,
  contextSource: 'transcript',
  roleClass: null,
  roleClassRunning: null,
  closedAt: null,
  ownedPaths: null,
  canSpawnAgents: true,
  canUseTeams: true,
  effort: null,
  modelChoice: null,
  effortChoice: null,
  teamSize: null,
  reportsTo: null,
  baseWidth: null,
  baseHeight: null,
  fontSize: null,
  bodyView: null,
  createdAt: Date.now(),
  exitedAt: null,
  exitCode: null,
}
store.upsertSession(base)
const back = store.getSession('s1')

check(
  'a fraction baked in under the old 200k sonnet-5 window is not trusted as-is',
  back?.contextUsed !== 1,
  String(back?.contextUsed),
)
check(
  'and reads against the current million-token window instead',
  Math.abs((back?.contextUsed ?? 0) - 235889 / 1_000_000) < 0.0001,
  String(back?.contextUsed),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
