/**
 * Protocol test for the rule that matters most: a card is never lost.
 *
 * Drives the server over its real WebSocket and checks the database afterwards, because the bug
 * this guards against deleted the row while the screen still looked fine.
 *
 * Run with: node scripts/test-lifecycle.mjs
 *
 * On a board of its own. It used to drive the owner's on 5178 and read his database, which meant
 * it created and deleted a real card on the board he was working on every time it ran, and any
 * early exit below left that card behind.
 */
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const garden = await startInstance()
const WS = `ws://127.0.0.1:${garden.port}/ws`
// The database this instance was given, which is the one it is writing to.
const DB = join(garden.home, 'garden.db')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

function dbSession(id) {
  const db = new Database(DB, { readonly: true })
  try {
    return db.prepare('SELECT id,status,pid FROM sessions WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

const ws = new WebSocket(WS)
const state = { projects: [], sessions: [] }

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') {
    state.projects = m.projects
    state.sessions = m.sessions
  } else if (m.t === 'project.added') {
    state.projects.push(m.project)
  } else if (m.t === 'session.added') {
    state.sessions.push(m.session)
  } else if (m.t === 'session.updated') {
    state.sessions = state.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  } else if (m.t === 'session.removed') {
    state.sessions = state.sessions.filter((s) => s.id !== m.sessionId)
  }
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(600)

const dir = mkdtempSync(join(tmpdir(), 'garden-lifecycle-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch project for the lifecycle test\n')
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = state.projects[0]
if (!project) { console.log('FAIL  could not add a project'); await garden.stop(); process.exit(1) }

const before = state.sessions.length
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell' }))
await sleep(2500)

const created = state.sessions[state.sessions.length - 1]
check('session created', state.sessions.length === before + 1 && !!created?.pid)

// Turn off: the process must end, the card must remain.
ws.send(JSON.stringify({ t: 'session.stop', sessionId: created.id }))
await sleep(2500)

const afterStop = state.sessions.find((s) => s.id === created.id)
check('card still on the board after turn off', !!afterStop)
check('status reports stopped', afterStop?.status === 'stopped', `got ${afterStop?.status}`)
check('row still in the database', !!dbSession(created.id), 'this is the regression that shipped')

// Turn on again: same card, new process.
ws.send(JSON.stringify({ t: 'session.start', sessionId: created.id }))
await sleep(2500)

const afterStart = state.sessions.find((s) => s.id === created.id)
check('same card turned back on', afterStart?.id === created.id && !!afterStart?.pid)
/*
 * Alive, and nothing more than alive.
 *
 * This used to expect "working", which was a lie the app told about every session it launched: a
 * process being spawned says nothing about whether the CLI inside it is busy, idle or sitting on
 * a permission prompt. Those three now arrive from the CLI's own hooks and session file, so a
 * freshly started card reports idle until it is told otherwise.
 */
check('turned back on and honest about it', afterStart?.status === 'idle', `got ${afterStart?.status}`)

// Delete: the only thing that removes it.
ws.send(JSON.stringify({ t: 'session.delete', sessionId: created.id }))
await sleep(1500)

check('card gone after explicit delete', !state.sessions.find((s) => s.id === created.id))
check('row gone from the database', !dbSession(created.id))

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
