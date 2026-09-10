/**
 * The board has a size, and it is somebody's decision.
 *
 * The failure this exists for: one request produced thirty-eight cards with twenty sessions running
 * at once, and no card had misbehaved. Each hired what its brief allowed, one manager brought up six
 * workers against an instruction of two, and nothing anywhere counted the total. `teamSize` was
 * written onto every card at creation and never read back, so the figure the owner set was a note to
 * himself rather than a limit.
 *
 * Three things are checked, and the third is the one that matters most: the refusal happens in the
 * `session.create` handler, so a scratch script sending raw WebSocket frames meets it too. Enforcing
 * only at the hiring endpoint would leave the exact path that caused the runaway wide open.
 *
 * The counts are read out of SQLite rather than off the board, because the board looking right is
 * what let this run for a whole afternoon.
 *
 * Runs against a server of its own, on its own port with its own workspace.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const PORT = garden.port

const dir = mkdtempSync(join(tmpdir(), 'garden-ceiling-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], errors: [], limits: null, events: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'limits') st.limits = m
  else if (m.t === 'event') st.events.push(m.event)
  else if (m.t === 'error') st.errors.push(m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await garden.stop()
  process.exit(1)
}

const setLimits = async (limits) => {
  ws.send(JSON.stringify({ t: 'limits.set', projectId: project.id, limits }))
  await sleep(400)
}

/** Created switched off throughout: this is about how many may exist, not about spending tokens. */
const make = async (title, reportsTo = null) => {
  const before = st.sessions.length
  st.errors.length = 0
  ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: project.id,
      adapterId: 'shell',
      title,
      roleClass: 'worker',
      reportsTo,
      start: false,
    }),
  )
  await sleep(450)
  return { made: st.sessions.length > before, said: st.errors[0] ?? null }
}

// --- the ceiling refuses, and says what stopped it ---

await setLimits({ running: 6, cardsPerProject: 5, childrenPerCard: 4 })
check('the ceiling can be set while the board is running', st.limits?.limits?.cardsPerProject === 5)

const made = []
for (let i = 1; i <= 5; i++) made.push(await make(`Card ${i}`))
check('five cards fit under a ceiling of five', made.every((r) => r.made))

const sixth = await make('Card 6')
check('the sixth is refused', !sixth.made, sixth.said ?? 'it was created')
check('and the refusal names the ceiling', /5/.test(sixth.said ?? ''), sixth.said ?? '')
check('and names what is already there', /holds 5|at its limit/.test(sixth.said ?? ''), sixth.said ?? '')

/*
 * Nothing is recorded for this one, and that is the design rather than a gap. An event belongs to a
 * card, and this create came from the renderer with no asker and no parent, which means the owner's
 * own hands: the refusal is already on his screen. Inventing a card to hang it on would be worse.
 * The recorded case is the one below, where a card asked and there is somewhere to file it.
 */
check('a refusal with nobody to file it against is not invented', !st.events.some((e) => e.type === 'hire.refused'))

// --- the refusal is real: nothing was written ---

const rows = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
check('and no session row was written for it', rows.sessions === 5, `health says ${rows.sessions}`)

// --- raising it mid-run works, which is the whole point of it being a setting ---

await setLimits({ running: 6, cardsPerProject: 7, childrenPerCard: 4 })
const seventh = await make('Card 6, again')
check('raising the ceiling lets the next one through', seventh.made, seventh.said ?? '')

// --- lowering it below the board never touches what exists ---

const standing = st.sessions.length
await setLimits({ running: 6, cardsPerProject: 2, childrenPerCard: 4 })
await sleep(400)
check('lowering it below the board deletes nothing', st.sessions.length === standing, `${st.sessions.length} of ${standing}`)
const afterLower = await make('One too many')
check('but the next card is refused', !afterLower.made, afterLower.said ?? 'it was created')

// --- a parent's own teamSize is finally consulted ---

await setLimits({ running: 6, cardsPerProject: 40, childrenPerCard: 4 })
ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: 'Manager of two',
    roleClass: 'manager',
    teamSize: 2,
    start: false,
  }),
)
await sleep(500)
const manager = st.sessions.find((s) => s.title === 'Manager of two')
check('a manager told to keep two helpers', manager?.teamSize === 2, String(manager?.teamSize))

const first = await make('Helper 1', manager.id)
const second = await make('Helper 2', manager.id)
const third = await make('Helper 3', manager.id)
check('gets its two', first.made && second.made)
check('and is refused the third', !third.made, third.said ?? 'it was created')
check('with the refusal naming the card and its figure', /Manager of two/.test(third.said ?? '') && /2/.test(third.said ?? ''), third.said ?? '')

// --- and that one is recorded, because there is a card it belongs to ---

const refusal = st.events.find((e) => e.type === 'hire.refused')
check('the attempt is recorded, not merely blocked', !!refusal)
check('as structured, because every field was read rather than matched', refusal?.provenance === 'structured')
check('saying which count stopped it', refusal?.payload?.which === 'children', String(refusal?.payload?.which))
check('and filed against the card it would have answered to', refusal?.sessionId === manager.id)

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
