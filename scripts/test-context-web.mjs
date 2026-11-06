/**
 * Proves the bottom connection point unfolds the files a session actually runs from, wired back
 * to it, and folds them away again without touching anything opened by hand.
 *
 * Run with: node scripts/test-context-web.mjs
 *
 * Starts its own board. It used to open a socket to 5178 and spawn a real shell session on whatever
 * the owner had in front of him, which is why the project below is a throwaway rather than his.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
const state = { projects: [], sessions: [], docs: [], wires: [] }

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, {
    projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires,
  })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'doc.added') state.docs.push(m.card)
  else if (m.t === 'doc.removed') state.docs = state.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'wire.added') state.wires.push(m.wire)
  else if (m.t === 'wire.removed') state.wires = state.wires.filter((w) => w.id !== m.wireId)
  else if (m.t === 'doc.content') state.lastContent = m
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

/*
 * A project folder of this run's own, with one file in it.
 *
 * It used to add `C:/Garden` itself, which meant a context web unfolded over the owner's checkout
 * and the assertions below depended on what happened to be in it that day. A folder with a known
 * CLAUDE.md in it makes the same assertions about the code instead.
 */
const dir = mkdtempSync(join(tmpdir(), 'garden-context-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch project for the context web test\n')
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = state.projects[0]
if (!project) { console.log('FAIL  could not add a project'); await garden.stop(); process.exit(1) }

ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell' }))
await sleep(2200)
const session = state.sessions[state.sessions.length - 1]

const docsBefore = state.docs.length
ws.send(JSON.stringify({ t: 'context.open', sessionId: session.id }))
await sleep(1500)

const web = state.docs.filter((d) => d.ownerId === session.id && d.web === 'context')
check('context web produced cards', web.length > 0, `${web.length} files`)
check('every card names a file that exists', web.every((d) => d.external ? existsSync(d.relPath) : true))

const webWires = state.wires.filter(
  (w) => w.sourceId === session.id && web.some((d) => d.id === w.targetId),
)
check('every card is wired to its session', webWires.length === web.length,
  `${webWires.length} wires for ${web.length} cards`)
check('web wires are marked as context', webWires.every((w) => w.kind === 'context'))
check('cards sit below the session', web.every((d) => d.y > session.y))

console.log('   files found:', web.map((d) => d.title).join(', ').slice(0, 200))

// A card in the web must actually open its file, including ones outside the project.
const external = web.find((d) => d.external)
if (external) {
  state.lastContent = null
  ws.send(JSON.stringify({ t: 'doc.read', cardId: external.id }))
  await sleep(900)
  check('a file outside the project still opens', !!state.lastContent?.content && !state.lastContent.error,
    external.relPath)
} else {
  console.log('note: no external file in this project, so that path was not exercised')
}

// Folding away removes exactly the web, and nothing else.
const handOpened = state.docs.filter((d) => d.web === null).length
ws.send(JSON.stringify({ t: 'context.close', sessionId: session.id }))
await sleep(1200)

check('folding removes every web card', state.docs.filter((d) => d.ownerId === session.id).length === 0)
check('folding leaves hand-opened cards alone', state.docs.filter((d) => d.web === null).length === handOpened)
check('folding removes the web wires', state.wires.filter((w) => w.sourceId === session.id).length === 0)

ws.send(JSON.stringify({ t: 'session.delete', sessionId: session.id }))
await sleep(600)

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
