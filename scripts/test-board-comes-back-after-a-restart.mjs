/**
 * Proves the cards that were running are running again once the backend comes back.
 *
 * `markAllExitedOnBoot` has always returned the list of cards that were live a moment ago, and the
 * comment above the call at `server/src/index.ts:92` has always said they are started again "once
 * the server is listening (see `revive` at the bottom of this file)". There was no `revive`. The
 * list was computed and dropped, and every restart left a board of stopped cards behind it. The
 * owner's words, quoted in that same comment: "the only thing that should kill the board is if i
 * kill all or a major update, but u should restart it to live state not just kill it leaving me
 * hanging".
 *
 * A card the owner had already switched off must stay off, or "restart to live state" turns into
 * "start everything", which is a different and much worse promise.
 *
 * WHAT "WAS RUNNING" MEANS CHANGED, 2026-09-05. Reviving everything that happened to be live made a
 * restart more expensive every time the board grew, and most of what is live at any moment is idle.
 * So `WORTH_REVIVING` is now working, starting and needs-input, and a card that merely had a process
 * stays off. Canon 03 revision 3 records it. This test asserted the older promise and passed until
 * that commit, which is why the working card below is made genuinely working through the hook door
 * rather than being assumed to count: a card with a process and nothing to do is exactly the case
 * that is now deliberately left down, and asserting on it tests nothing.
 *
 * Shell cards rather than CLI ones: what is being tested is who gets a process back, and spawning
 * two real Claude sessions to answer that spends a context window on a question that does not need
 * one.
 */
import WebSocket from 'ws'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const projectDir = mkdtempSync(join(tmpdir(), 'garden-revive-'))
writeFileSync(join(projectDir, 'CLAUDE.md'), '# scratch\n')

// One workspace, opened by two servers in turn. Held here rather than by either of them, because
// the whole question is what the second one finds after the first has gone.
const home = mkdtempSync(join(tmpdir(), 'garden-revive-home-'))

/** Connect, collect the board, and hand back a way to ask it things. */
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
  await sleep(500)
  return { ws, state, of: (title) => state.sessions.find((s) => s.title === title) }
}

// --- a board with one card working and one deliberately switched off -----------------------------

const first = await startInstance({ home })
const a = await connect(first.port)

a.ws.send(JSON.stringify({ t: 'project.add', path: projectDir.replace(/\\/g, '/') }))
await sleep(1200)
const project = a.state.projects.find((p) => p.path.toLowerCase() === projectDir.toLowerCase())

for (const title of ['Working', 'Idle', 'Put down']) {
  a.ws.send(
    JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, start: false }),
  )
  await sleep(500)
}

for (const title of ['Working', 'Idle']) {
  a.ws.send(JSON.stringify({ t: 'session.start', sessionId: a.of(title).id }))
  await sleep(1200)
}
await sleep(1500)

/*
 * One of them is given something to do, through the same door a real card reports through.
 *
 * A shell card has no CLI to submit a prompt, so the hook endpoint is posted directly. That is the
 * route `server/hooks/garden-hook.mjs` uses and `ingest.handle` is the only thing that reads it, so
 * the status this produces is the status a real working card has, not a value poked into the store.
 */
await fetch(`http://127.0.0.1:${first.port}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: a.of('Working').id,
    // The real hook stamps this; without it the event row has no timestamp and is refused.
    receivedAt: Date.now(),
    event: { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
  }),
})
await sleep(1500)

check('the card that is meant to be running has a process', a.of('Working')?.pid != null)
check(
  'and it is holding work, which is what decides whether it comes back',
  a.of('Working')?.status === 'working',
  `status ${a.of('Working')?.status}`,
)
check('the idle card has a process too', a.of('Idle')?.pid != null, `status ${a.of('Idle')?.status}`)
check('and the one that is not started, has not', a.of('Put down')?.pid == null)

// --- the backend goes down and comes back --------------------------------------------------------

a.ws.close()
await first.stop()

const second = await startInstance({ home })
// The revive is staggered on purpose so five cards do not spawn inside one tick. Well past it.
await sleep(6000)
const b = await connect(second.port)

check(
  'the card that was working is running again',
  b.of('Working')?.pid != null,
  `pid ${b.of('Working')?.pid ?? 'none'}, status ${b.of('Working')?.status}`,
)
check(
  'and it is a new process, because a Windows one cannot be re-parented',
  b.of('Working')?.pid != null && b.of('Working')?.pid !== a.of('Working')?.pid,
  `was ${a.of('Working')?.pid}, now ${b.of('Working')?.pid}`,
)
check(
  'the card he had switched off is still off',
  b.of('Put down')?.pid == null,
  `pid ${b.of('Put down')?.pid ?? 'none'}`,
)
check(
  'and the card that was only sitting there is left down, deliberately',
  b.of('Idle')?.pid == null,
  `pid ${b.of('Idle')?.pid ?? 'none'}, status ${b.of('Idle')?.status}`,
)

b.ws.close()
await second.stop()
try {
  rmSync(home, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
} catch {
  // Windows holds files a killed server had open. Leaving a temp directory behind is not a failure.
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
