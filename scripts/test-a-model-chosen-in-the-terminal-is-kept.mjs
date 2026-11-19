/**
 * A /model or /effort the owner types in a card's terminal becomes its saved choice (canon 03).
 *
 * The owner, 2026-11-18: "i need garden to save model as current model not the model it started as".
 * A card chosen as Fable got /model Opus 5.5 in its terminal; Garden kept showing "fable pending" and
 * would have restarted it on Fable. A reply on another model with no /model line before it is the CLI
 * falling back on overload, and must not change the choice.
 *
 * Runs on its own instance, port and directory. Uses a real transcript file, because the reader
 * reads the file rather than anything posted over the wire.
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
async function until(fn, seconds) {
  for (let i = 0; i < seconds * 5 && !fn(); i++) await sleep(200)
  return fn()
}

const dir = mkdtempSync(join(tmpdir(), 'garden-model-choice-'))
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
if (!project) { console.log('FAIL  no scratch project'); await garden.stop(); process.exit(1) }

const title = `Model ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await until(() => st.sessions.some((s) => s.title === title), 10)
const card = st.sessions.find((s) => s.title === title)
const cur = () => st.sessions.find((s) => s.id === card.id)
ws.send(JSON.stringify({ t: 'session.setRole', sessionId: card.id, modelChoice: 'claude-fable-5-2', effortChoice: 'high' }))
await until(() => cur()?.modelChoice === 'claude-fable-5-2', 10)
check('the card starts chosen as Fable', cur()?.modelChoice === 'claude-fable-5-2', String(cur()?.modelChoice))

const SID = `model-${Date.now()}`
const transcript = join(dir, `${SID}.jsonl`)
// Stamped when written, as the CLI does, so the order of choices is the real order.
const at = () => new Date().toISOString()
const reply = (model, ms) => JSON.stringify({ type: 'assistant', timestamp: at(ms), message: { model, usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n'
const stdout = (text, ms) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } }) + '\n'
writeFileSync(transcript, reply('claude-fable-5-2', 0))
await hook(card.id, { hook_event_name: 'SessionStart', session_id: SID, transcript_path: transcript.replace(/\\/g, '/'), cwd: dir })

async function turn() {
  const P = `p-${Date.now()}`
  await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: P, prompt: 'ask' })
  await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: P })
}

// A fallback: replies on another model with no /model line. The choice must not move.
await turn()
appendFileSync(transcript, reply('claude-sonnet-5-5', 1000))
await turn()
await sleep(3500)
check('a fallback reply leaves the choice alone', cur()?.modelChoice === 'claude-fable-5-2', String(cur()?.modelChoice))

// The owner types /model Opus 5.5 and /effort max in the terminal.
appendFileSync(transcript, stdout('Set model to `Opus 5.5` and saved as your default for new sessions', 2000))
appendFileSync(transcript, stdout('Set effort level to max (this session only): Maximum capability', 2500))
appendFileSync(transcript, reply('claude-opus-5-5', 3000))
await turn()
await until(() => cur()?.modelChoice === 'claude-opus-5-5', 10)
check('/model in the terminal becomes the saved choice', cur()?.modelChoice === 'claude-opus-5-5', String(cur()?.modelChoice))
check('/effort in the terminal becomes the saved choice', cur()?.effortChoice === 'max', String(cur()?.effortChoice))
check('and the label has no pending', cur()?.model === 'claude-opus-5-5', `running ${cur()?.model}`)

// A later choice made in Garden outranks the old /model line still in the transcript.
ws.send(JSON.stringify({ t: 'session.setRole', sessionId: card.id, modelChoice: 'claude-fable-5-2' }))
await until(() => cur()?.modelChoice === 'claude-fable-5-2', 10)
appendFileSync(transcript, reply('claude-opus-5-5', 4000))
await turn()
await sleep(3500)
check('a later choice in Garden is not overridden by the old line', cur()?.modelChoice === 'claude-fable-5-2', String(cur()?.modelChoice))

ws.close()
await garden.stop()
console.log(failures ? `${failures} FAILED` : 'ALL PASS')
process.exit(failures ? 1 : 0)
