/**
 * The context web includes a Research column: what a project knows, as opposed to what it
 * instructs. Canon docs, worklogs, design notes and working papers, capped so a canon folder of
 * a hundred files does not become a column nobody can read.
 *
 * The project is built here rather than borrowed. It used to add `C:/Work/App/1.0`, a real
 * repository of the owner's, to whatever board was on 5178: his. What the cap and the grouping
 * actually need is a folder with more knowledge files than the cap allows, which is cheaper to
 * make than to find and does not change under the test when he edits his own docs.
 */
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
const st = { projects: [], sessions: [], docs: [] }
ws.on('message', (r) => {
  const m = JSON.parse(String(r))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(900)

for (const o of new Set(st.docs.filter((d) => d.web === 'context').map((d) => d.ownerId))) {
  ws.send(JSON.stringify({ t: 'context.close', sessionId: o }))
  await sleep(200)
}

/*
 * Sixty knowledge files, which is more than the cap, so the cap is exercised rather than assumed.
 * A project root file as well, because the assertion below is that research comes from knowledge
 * folders and not from the root, and that cannot be checked against a root with nothing in it.
 */
const dir = mkdtempSync(join(tmpdir(), 'garden-research-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch project for the research column test\n')
writeFileSync(join(dir, 'README.md'), 'a file in the root, which is not research\n')
mkdirSync(join(dir, 'docs', 'canonical'), { recursive: true })
for (let i = 1; i <= 60; i++) {
  const n = String(i).padStart(2, '0')
  writeFileSync(join(dir, 'docs', 'canonical', `${n}-chapter.md`), `# Chapter ${n}\n\nbody\n`)
}
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1600)
const project = st.projects[0]
check('a project with research to find', !!project, project?.path)
if (!project) { await garden.stop(); process.exit(1) }

const title = `ResTest ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2400)
const session = st.sessions.find((s) => s.title === title)

ws.send(JSON.stringify({ t: 'context.open', sessionId: session.id }))
await sleep(3200)
const web = st.docs.filter((d) => d.ownerId === session.id)

const byGroup = {}
for (const d of web) byGroup[d.group] = (byGroup[d.group] ?? 0) + 1
console.log('   groups:', JSON.stringify(byGroup))

check('a research column exists', (byGroup.research ?? 0) > 0, `${byGroup.research ?? 0} files`)
check('it is capped rather than unbounded', (byGroup.research ?? 0) <= 41, `${byGroup.research} files`)

const research = web.filter((d) => d.group === 'research')
console.log('   examples:', research.slice(0, 4).map((d) => d.title).join(' | '))
check('research files come from knowledge folders, not the project root',
  research.some((d) => /docs\//i.test(d.relPath)),
  research[0]?.relPath ?? 'none')

// Columns must not collide with each other either.
const cols = new Map()
for (const d of web) cols.set(Math.round(d.x), (cols.get(Math.round(d.x)) ?? 0) + 1)
check('every group got its own column', cols.size === Object.keys(byGroup).length,
  `${cols.size} columns for ${Object.keys(byGroup).length} groups`)

ws.send(JSON.stringify({ t: 'context.close', sessionId: session.id }))
await sleep(900)
ws.send(JSON.stringify({ t: 'session.delete', sessionId: session.id }))
await sleep(500)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
