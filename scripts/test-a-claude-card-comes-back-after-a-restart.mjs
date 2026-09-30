/**
 * An idle Claude card comes back by itself after Restart server. Canon 03 revision 14.
 *
 * The owner, after a restart that left his Orchestrator off: "why do i have to press turn on button
 * to start u up again". Restarts had been proved to bring back idle cards, but only with shell cards.
 * A Claude card differs in one way that mattered: when Garden ends it, the CLI sends a SessionEnd hook
 * on its way out, the server still going down received it, and SessionEnd marked the card `done`.
 * The next boot only brings back cards that were alive, and `done` is not alive, so the card stayed
 * off. Seen on his board on 2026-09-30: SessionEnd recorded at 01:50:39.3, one second before the new
 * server started.
 *
 * The CLI is a fake `claude` first on PATH for this instance only, sending SessionStart and Stop as
 * Claude does. A fake inside Garden's terminal is ended without a signal it could answer, so the
 * SessionEnd is posted from here, from just after shutdown begins until the old server stops
 * answering, and the count that landed is checked so this cannot pass by delivering none. Restart is
 * asked for over the socket exactly as the board's button sends it, so the real shutdown runs. Its own
 * Garden on its own port and workspace, serving the BUILT app: run `npm run build` first.
 */
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { connect as tcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}
const listening = (port) =>
  new Promise((done) => {
    const probe = tcp({ port, host: '127.0.0.1' })
    probe.setTimeout(700)
    probe.on('connect', () => (probe.destroy(), done(true)))
    probe.on('timeout', () => (probe.destroy(), done(false)))
    probe.on('error', () => done(false))
  })

const bin = mkdtempSync(join(tmpdir(), 'garden-fake-claude-'))
const transcript = join(bin, 'transcript.jsonl')
writeFileSync(transcript, '', 'utf8')
writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs"\r\n`, 'utf8')
process.env.PATH = `${bin};${process.env.PATH}`

const home = mkdtempSync(join(tmpdir(), 'garden-claude-revive-home-'))
const dir = mkdtempSync(join(tmpdir(), 'garden-claude-revive-proj-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
const garden = await startInstance({ home })
const PORT = garden.port
const hookUrl = `http://127.0.0.1:${PORT}/hook`

// Written now, with this board's own port in it; `claude.cmd` only runs it when a card starts.
writeFileSync(
  join(bin, 'fake-claude.mjs'),
  String.raw`
const post = (name) =>
  fetch(${JSON.stringify(hookUrl)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gardenSessionId: process.env.GARDEN_SESSION_ID,
      receivedAt: Date.now(),
      event: { hook_event_name: name, session_id: 'fake-session', transcript_path: ${JSON.stringify(transcript)} },
    }),
  }).catch(() => {})
process.stdout.write('\x1b[H\x1b[2J> \r\n')
await post('SessionStart')
setTimeout(() => post('Stop'), 1500)
process.stdin.resume()
setInterval(() => {}, 1 << 30)
`,
  'utf8',
)

const talk = async () => {
  const st = { projects: [], sessions: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') {
      const i = st.sessions.findIndex((s) => s.id === m.session.id)
      if (i >= 0) st.sessions[i] = m.session
    }
  })
  ws.on('error', () => {})
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(700)
  return { ws, st, card: () => st.sessions.find((s) => s.title === 'Claude card') }
}

const a = await talk()
a.ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = a.st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'claude', title: 'Claude card', start: true }))
for (let i = 0; i < 40 && a.card()?.status !== 'idle'; i++) await sleep(500)
const before = a.card()
check('a Claude card is running and idle before the restart', before?.pid != null && before?.status === 'idle', `pid ${before?.pid}, status ${before?.status}`)

a.ws.send(JSON.stringify({ t: 'server.restart' }))
let landed = 0
let downAt = 0
await sleep(320)
for (let i = 0; i < 400 && !downAt; i++) {
  try {
    const r = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gardenSessionId: before?.id,
        receivedAt: Date.now(),
        event: { hook_event_name: 'SessionEnd', session_id: 'fake-session', transcript_path: transcript, reason: 'other' },
      }),
    })
    if (r.ok) landed++
  } catch {
    // The server has gone, which ends the window this covers.
  }
  if (!(await listening(PORT))) downAt = Date.now()
  await sleep(40)
}
let upAt = 0
for (let i = 0; i < 240 && downAt && !upAt; i++) {
  await sleep(250)
  if (await listening(PORT)) upAt = Date.now()
}
check('the server went down and came back', downAt > 0 && upAt > 0)
check('a SessionEnd reached the server while it was going down, as Claude’s did on the owner’s board', landed > 0, `${landed} delivered`)

if (upAt) {
  const b = await talk()
  let after = b.card()
  for (let i = 0; i < 40 && !(after?.pid != null && after.status !== 'starting'); i++) {
    await sleep(500)
    after = b.card()
  }
  check('the idle Claude card comes back by itself', after?.pid != null && after.pid !== before?.pid && after.status !== 'done', `pid ${after?.pid ?? 'none'}, status ${after?.status}`)
  check('on a new process', after?.pid != null && after.pid !== before?.pid, `was ${before?.pid}, now ${after?.pid}`)
  check('and does not read as finished', after?.status !== 'done', `status ${after?.status}`)
  try {
    b.ws.send(JSON.stringify({ t: 'session.stop', sessionId: after?.id }))
  } catch {}
  await sleep(800)
  b.ws.close()
}

// The replacement was started by Garden's restart helper, not by this script, so it is found by this
// test's own port and ended here. Never any other port.
try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue).OwningProcess`],
    { encoding: 'utf8' },
  )
  for (const pid of out.split(/\s+/).filter(Boolean)) {
    if (Number(pid) > 0) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
  }
} catch {
  // Nothing listening is fine.
}
await garden.stop()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
