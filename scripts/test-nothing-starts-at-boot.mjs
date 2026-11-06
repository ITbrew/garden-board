/**
 * Proves no card starts when Garden starts, and that one can still be turned on afterwards. Canon 03
 * revision 18. The owner, 2026-11-05: "change it so nothing starts up at the start and ill manually
 * wake up orchestrator per tab and they have instructions to turn on sleeping/off cards".
 *
 * A working card and an idle one go through a reboot of the same scratch workspace. Mail restored at
 * boot is not covered here; canon 06 has that rule and its own tests. Runs from source (`tsx`) because the built copy may be older than the change. Shell
 * cards, because the question is who gets a process, and a real CLI would spend a session on it.
 */
import WebSocket from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const projectDir = mkdtempSync(join(tmpdir(), 'garden-noboot-'))
const home = mkdtempSync(join(tmpdir(), 'garden-noboot-home-'))
delete process.env.GARDEN_REVIVE

async function connect(port) {
  const state = { projects: [], sessions: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
    else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'session.added') state.sessions.push(m.session)
    else if (m.t === 'session.updated') {
      const i = state.sessions.findIndex((s) => s.id === m.session.id)
      if (i >= 0) state.sessions[i] = m.session
    }
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(800)
  return { ws, state, of: (title) => state.sessions.find((s) => s.title === title) }
}

const first = await startInstance({ home, entry: 'tsx' })
const a = await connect(first.port)
a.ws.send(JSON.stringify({ t: 'project.add', path: projectDir.replace(/\\/g, '/') }))
await sleep(1500)
const project = a.state.projects.find((p) => p.path.toLowerCase() === projectDir.toLowerCase())
for (const title of ['Working', 'Idle']) {
  a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }))
  await sleep(600)
  a.ws.send(JSON.stringify({ t: 'session.start', sessionId: a.of(title).id }))
  await sleep(1500)
}
await fetch(`http://127.0.0.1:${first.port}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gardenSessionId: a.of('Working').id, receivedAt: Date.now(), event: { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' } }),
})
await sleep(1500)
check('both cards are running before the restart', a.of('Working')?.pid != null && a.of('Idle')?.pid != null)
check('and one of them is mid-work', a.of('Working')?.status === 'working', `status ${a.of('Working')?.status}`)
a.ws.close()
await first.stop()

const second = await startInstance({ home, entry: 'tsx' })
// Well past the 1.5 s the revive waits and the 4 s between cards, so a revive would have shown by now.
await sleep(12000)
const b = await connect(second.port)
check('the card that was working stays off', b.of('Working')?.pid == null, `pid ${b.of('Working')?.pid ?? 'none'}`)
check('the card that was idle stays off', b.of('Idle')?.pid == null, `pid ${b.of('Idle')?.pid ?? 'none'}`)

b.ws.send(JSON.stringify({ t: 'session.start', sessionId: b.of('Idle').id }))
await sleep(2500)
check('a card can still be turned on afterwards', b.of('Idle')?.pid != null, `pid ${b.of('Idle')?.pid ?? 'none'}`)
check('and only that card came on', b.of('Working')?.pid == null)
b.ws.close()
await second.stop()

// The old path is kept for the tests about it, and only runs when asked for by name.
process.env.GARDEN_REVIVE = '1'
const third = await startInstance({ home, entry: 'tsx' })
await sleep(9000)
const c = await connect(third.port)
check('GARDEN_REVIVE=1 still brings a card back', c.of('Idle')?.pid != null, `pid ${c.of('Idle')?.pid ?? 'none'}`)
c.ws.close()
await third.stop()

try {
  rmSync(home, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
} catch {
  // Windows holds files a killed server had open. A leftover temp directory is not a failure.
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
