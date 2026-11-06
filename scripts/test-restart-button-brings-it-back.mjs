/**
 * Proves the restart control stops the server and brings it and the board back.
 *
 * Asked for because a server change is not live until the backend restarts, and there was no way to
 * ask for that from the app. His own question was whether closing a board counted, and it does not:
 * `project.close` kills every process in that board and leaves the same server running, so it costs
 * the sessions and changes nothing about the code.
 *
 * The thing worth testing is not that a message was accepted. It is that the port goes away, comes
 * back on its own, and that a card which was running is running again afterwards, because a restart
 * that leaves the board dark is worse than no button.
 */
import WebSocket from 'ws'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const listening = (port) =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(700)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(false)
    })
    probe.on('error', () => done(false))
  })

const home = mkdtempSync(join(tmpdir(), 'garden-restart-home-'))
const dir = mkdtempSync(join(tmpdir(), 'garden-restart-proj-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const garden = await startInstance({ home })
const PORT = garden.port

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
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(700)
  return { ws, st }
}

const a = await talk()
a.ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = a.st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Working', start: true }))
await sleep(2500)
/*
 * Given something to do, because since 2026-09-05 only a card that was holding work comes back.
 *
 * A card with a process and nothing to do is now deliberately left down after a restart (canon 03
 * revision 3), so a test that started one and expected it back was asserting a promise Garden no
 * longer makes. The hook endpoint is the same door `server/hooks/garden-hook.mjs` posts through, so
 * the status this produces is a real one rather than a value written into the store.
 */
await fetch(`http://127.0.0.1:${PORT}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: a.st.sessions.find((s) => s.title === 'Working')?.id,
    receivedAt: Date.now(),
    event: { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
  }),
})
await sleep(1200)
const before = a.st.sessions.find((s) => s.title === 'Working')
check('a card is running before the restart', before?.pid != null, `pid ${before?.pid ?? 'none'}`)
check('and it is holding work, so a restart owes it a process', before?.status === 'working', `status ${before?.status}`)

// --- the button ------------------------------------------------------------------------------------

a.ws.send(JSON.stringify({ t: 'server.restart' }))

/*
 * Polled tight, because the gap is the evidence and it is short.
 *
 * A first version looked every 250ms and never caught the port closed, then passed the check that
 * it had come back. Both cannot be true of a server that never stopped, so the loop was the thing
 * at fault rather than the restart: the helper waits only until the port frees and starts the
 * replacement immediately, so the whole window is about a second. Measured rather than asserted, and
 * the figure is printed so a future change that makes the gap longer is visible rather than silent.
 */
let downAt = 0
for (let i = 0; i < 400; i++) {
  await sleep(50)
  if (!(await listening(PORT))) {
    downAt = Date.now()
    break
  }
}
check('the server actually stops', downAt > 0, downAt ? 'the port closed' : 'it never let go of the port')

let upAt = 0
for (let i = 0; i < 240; i++) {
  await sleep(250)
  if (await listening(PORT)) {
    upAt = Date.now()
    break
  }
}
check(
  'and starts again by itself',
  upAt > 0,
  upAt && downAt ? `back after ${((upAt - downAt) / 1000).toFixed(1)}s` : upAt ? 'it is listening again' : 'it never came back',
)

// --- and the board is still a board ---------------------------------------------------------------

if (upAt > 0) {
  await sleep(6000)
  const b = await talk()
  const after = b.st.sessions.find((s) => s.title === 'Working')
  check('the card survived the restart', !!after, after ? `"${after.title}"` : '(gone)')
  check(
    'and it is running again, on a new process',
    after?.pid != null && after.pid !== before?.pid,
    `was ${before?.pid}, now ${after?.pid ?? 'none'}`,
  )
  b.ws.close()
}

try {
  a.ws.close()
} catch {
  // The socket died with the server it was talking to, which is the point.
}
// Started by the helper rather than by the harness, so it is not the harness's to stop.
try {
  const done = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok)
  if (done) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise((r) => ws.on('open', r))
    ws.close()
  }
} catch {
  // Nothing listening is fine here.
}
await garden.stop()
try {
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows holds files a killed server had open.
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
