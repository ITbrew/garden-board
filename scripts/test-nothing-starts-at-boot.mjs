/**
 * Proves no card starts when Garden starts, and that one can still be turned on afterwards. Canon 03
 * revision 18. The owner, 2026-11-05: "change it so nothing starts up at the start and ill manually
 * wake up orchestrator per tab and they have instructions to turn on sleeping/off cards".
 *
 * Revision 20: "after reset the orchestrators that were on can turn back on". An orchestrator that was
 * on returns and is told what was running; one that was off stays off, and so does every other card.
 *
 * A working card and an idle one go through a reboot of the same scratch workspace. Mail restored at
 * boot is not covered here; canon 06 has that rule and its own tests. Runs from source (`tsx`) because the built copy may be older than the change. Shell
 * cards, because the question is who gets a process, and a real CLI would spend a session on it.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  for (let i = 0; i < 40 && state.projects.length === 0; i++) await sleep(250)
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
a.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Boss', roleClass: 'orchestrator', start: false }))
await sleep(600)
a.ws.send(JSON.stringify({ t: 'session.start', sessionId: a.of('Boss').id }))
await sleep(1500)
const otherDir = mkdtempSync(join(tmpdir(), 'garden-noboot-other-'))
a.ws.send(JSON.stringify({ t: 'project.add', path: otherDir.replace(/\\/g, '/') }))
await sleep(1500)
const otherProject = a.state.projects.find((p) => p.path.toLowerCase() === otherDir.toLowerCase())
a.ws.send(JSON.stringify({ t: 'session.create', projectId: otherProject.id, adapterId: 'shell', title: 'Sleeping boss', roleClass: 'orchestrator', start: false }))
await sleep(800)
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
check('the orchestrator that was on comes back', b.of('Boss')?.pid != null, `pid ${b.of('Boss')?.pid ?? 'none'}`)
check('the orchestrator that was off stays off', b.of('Sleeping boss')?.pid == null, `pid ${b.of('Sleeping boss')?.pid ?? 'none'}`)
const findInbox = (dir, id, depth = 0) => {
  const direct = join(dir, 'mail', id, 'INBOX.md')
  if (existsSync(direct)) return direct
  if (depth > 1 || !existsSync(dir)) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const found = findInbox(join(dir, e.name), id, depth + 1)
    if (found) return found
  }
  return null
}
const inbox = findInbox(home, b.of('Boss').id)
const told = inbox ? readFileSync(inbox, 'utf8') : ''
check('and is told what was running', /Working: was working/.test(told) && /Idle: was idle/.test(told), told.slice(-300))

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
