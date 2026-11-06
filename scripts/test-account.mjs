/**
 * Proves the account is bound to the project and enforced by the server.
 *
 * Two Claude accounts are billed separately, so "the tab says Personal" is worthless unless a
 * session physically cannot run on the other one. This asks the server for a session on the
 * wrong profile and checks which config dir it actually got.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync } from 'node:fs'
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
const st = { projects: [], profiles: [], sessions: [] }
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, profiles: m.profiles, sessions: m.sessions })
  else if (m.t === 'profiles') st.profiles = m.profiles
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'project.updated') st.projects = st.projects.map((p) => (p.id === m.project.id ? m.project : p))
  else if (m.t === 'session.added') st.sessions.push(m.session)
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

/*
 * This test binds and unbinds accounts, so it MUST NOT be able to see a real one.
 *
 * It used to operate on projects[0] of the board on 5178, which is the owner's real board, and its
 * cleanup unbound that project's Claude account. The visible symptom was Garden asking which
 * account to use on every restart, and the app was blamed for forgetting. Later it moved to a
 * scratch project, which was still a scratch project on his board. Now the board itself is this
 * run's own, so there is nothing of his within reach and nothing to promise to clean up.
 */
const scratch = mkdtempSync(join(tmpdir(), 'garden-account-'))
ws.send(JSON.stringify({ t: 'project.add', path: scratch.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path === scratch)
if (!project) {
  console.log('FAIL  could not create a scratch project')
  await garden.stop()
  process.exit(1)
}

// Two profiles, standing in for two separately billed accounts.
ws.send(JSON.stringify({ t: 'profile.create', name: 'AcctA', adapterId: 'claude' }))
await sleep(600)
ws.send(JSON.stringify({ t: 'profile.create', name: 'AcctB', adapterId: 'claude' }))
await sleep(900)

const a = st.profiles.find((p) => p.name === 'AcctA')
const b = st.profiles.find((p) => p.name === 'AcctB')
check('two profiles exist', !!a && !!b)
check('each has its own config directory', a.configDir !== b.configDir)
check('config directories were created', existsSync(a.configDir) && existsSync(b.configDir))
check('no account claimed before sign in', a.accountEmail === null, `got ${a.accountEmail}`)

ws.send(JSON.stringify({ t: 'project.setProfile', projectId: project.id, adapterId: 'claude', profileId: a.id }))
await sleep(700)
check('project is bound to AcctA', st.projects.find((p) => p.id === project.id)?.profiles?.claude === a.id)

// Ask for a session on the WRONG profile. The server must ignore it.
ws.send(JSON.stringify({
  t: 'session.create', projectId: project.id, adapterId: 'claude', profileId: b.id,
}))
await sleep(2500)

const made = st.sessions[st.sessions.length - 1]
check('session ignored the requested profile and used the tab\'s', made?.profileId === a.id,
  `session got ${made?.profileId === b.id ? 'AcctB (WRONG)' : made?.profileId}`)

// Codex has its own slot, so a Claude and a Codex session can share one tab.
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'codex' }))
await sleep(2200)
const codex = st.sessions[st.sessions.length - 1]
check('a Codex session can live in the same tab', codex?.adapterId === 'codex')
check('and it does not take the Claude account slot', codex?.profileId !== a.id,
  `codex profileId=${codex?.profileId}`)
ws.send(JSON.stringify({ t: 'session.delete', sessionId: codex.id }))
await sleep(400)

ws.send(JSON.stringify({ t: 'session.delete', sessionId: made.id }))
await sleep(500)

/*
 * No unbinding, no profile deletes, no project remove.
 *
 * Deleting by the ids it captured was this test's way of leaving the owner's board as it found it,
 * and `14-how-tests-are-run.md` calls that a defect rather than a style: any early exit above skips
 * it entirely. The board being thrown away with the instance is what makes the tidying unnecessary,
 * so it is gone rather than kept as reassurance.
 */
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
