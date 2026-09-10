/**
 * Typing into a card with no process is recorded, never swallowed.
 *
 * The owner left Garden alone, came back, and could not type into his cards. Nothing on screen said
 * why and nothing in the logs said anything at all, because `session.input` returned bare when the
 * PTY was not live: the line left his keyboard, reached the server, and stopped.
 *
 * Two halves fixed it and this covers the server half. A dropped keystroke now writes an
 * `InputDropped` event carrying the reason and the text, so a lost line is visible afterwards rather
 * than being indistinguishable from a line that was never typed. The text is in the event because a
 * dropped Enter and a dropped sentence are different losses.
 *
 * Its own instance, its own port, its own directory. Never the owner's board.
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

const garden = await startInstance({ entry: 'tsx' })
const dir = mkdtempSync(join(tmpdir(), 'garden-swallow-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const state = { projects: [], sessions: [], events: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'event') state.events.push(m.event)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('the scratch project was added', !!project)

/*
 * `start: false` is the whole point. This is a card that exists on the board with no process behind
 * it, which is the state a board is in after a restart: the server revives only `working`,
 * `starting` and `needs-input` cards and deliberately leaves every idle one down, so an idle card
 * keeps its status and loses its pid.
 */
ws.send(JSON.stringify({
  t: 'session.create',
  projectId: project.id,
  adapterId: 'shell',
  title: 'Unstarted',
  start: false,
}))
await sleep(1500)
const card = state.sessions.find((s) => s.title === 'Unstarted')
check('the card exists with no process', !!card && card.pid === null, card ? `pid ${card.pid}` : 'no card')

const TYPED = 'a line the owner will never see arrive\r'
state.events.length = 0
ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: TYPED }))
await sleep(1200)

const dropped = state.events.find((e) => e.type === 'InputDropped' && e.sessionId === card.id)
check('the dropped line is recorded rather than swallowed', !!dropped,
  dropped ? '' : `${state.events.length} events, none InputDropped`)
check('and it says why', !!dropped?.payload?.reason, dropped?.payload?.reason ?? '')
check('and it keeps the text, so a lost Enter and a lost sentence are different losses',
  dropped?.payload?.text === TYPED, JSON.stringify(dropped?.payload?.text ?? null))

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
