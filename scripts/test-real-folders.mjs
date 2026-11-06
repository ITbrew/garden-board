/**
 * Canon 29 section 5 on a scratch Garden: a project added through a link is recorded at its real
 * folder, and a project already recorded at a link is moved to its real folder at the next start,
 * cards included. Its own instance and workspace; the link is a junction this test makes and removes.
 */
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const root = mkdtempSync(join(tmpdir(), 'garden-real-folders-'))
const realA = join(root, 'real-a')
const realB = join(root, 'real-b')
const linkA = join(root, 'link-a')
const linkB = join(root, 'link-b')
for (const d of [realA, realB]) { mkdirSync(d); writeFileSync(join(d, 'CLAUDE.md'), '# scratch\n') }
execFileSync('cmd', ['/c', 'mklink', '/J', linkA, realA], { stdio: 'ignore' })
execFileSync('cmd', ['/c', 'mklink', '/J', linkB, realB], { stdio: 'ignore' })
const home = mkdtempSync(join(tmpdir(), 'garden-test-home-'))

async function session(port, fn) {
  const state = { projects: [], sessions: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
    else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'session.added') state.sessions.push(m.session)
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(500)
  try { return await fn(ws, state) } finally { ws.close() }
}

try {
  // 1. Added through a link: recorded at the real folder.
  let garden = await startInstance({ home, entry: 'tsx' })
  await session(garden.port, async (ws, state) => {
    ws.send(JSON.stringify({ t: 'project.add', path: linkA }))
    await sleep(1500)
    const p = state.projects.find((x) => x.name === 'link-a' || x.name === 'real-a')
    check('a project added through a link is recorded at its real folder', p?.path?.toLowerCase() === realA.toLowerCase(), p?.path)
    ws.send(JSON.stringify({ t: 'project.add', path: realB }))
    await sleep(1500)
    const b = state.projects.find((x) => x.path.toLowerCase() === realB.toLowerCase())
    ws.send(JSON.stringify({ t: 'session.create', projectId: b.id, adapterId: 'shell', title: 'Card B', start: false }))
    await sleep(800)
  })
  await garden.stop()

  // 2. A project recorded at a link (as older builds did), with a card inside a subfolder of it.
  const db = new Database(join(home, 'garden.db'))
  const b = db.prepare('SELECT id FROM projects WHERE lower(path) = lower(?)').get(realB)
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(linkB, b.id)
  db.prepare('UPDATE sessions SET cwd = ? WHERE projectId = ?').run(join(linkB, 'sub'), b.id)
  db.close()

  garden = await startInstance({ home, entry: 'tsx' })
  await session(garden.port, async (_ws, state) => {
    const p = state.projects.find((x) => x.id === b.id)
    check('a project recorded at a link is moved to its real folder at start', p?.path?.toLowerCase() === realB.toLowerCase(), p?.path)
    const card = state.sessions.find((s) => s.projectId === b.id)
    check('its card moves with it, keeping the subfolder', card?.cwd?.toLowerCase() === join(realB, 'sub').toLowerCase(), card?.cwd)
  })
  await garden.stop()
} finally {
  for (const l of [linkA, linkB]) try { execFileSync('cmd', ['/c', 'rmdir', l], { stdio: 'ignore' }) } catch {}
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
