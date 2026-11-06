/**
 * Canon 29 on a scratch Garden: every project is bound to Garden's own account directories, a card
 * whose directory is signed in as another account is refused at start with the reason, and the
 * picker cannot bind a project to another account.
 *
 * Its own instance, its own workspace, invented `example.invalid` accounts. Nothing real is read.
 * The allowed case is not launched: that would start a real CLI, and the unit test covers it.
 */
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'garden-test-home-'))
const claudeDir = join(home, 'acct', 'claude')
const codexDir = join(home, 'acct', 'codex')
const otherDir = join(home, 'acct', 'other')
for (const d of [claudeDir, codexDir, otherDir]) mkdirSync(d, { recursive: true })
// Garden's Claude directory signed in as some other account: every Claude card must be refused.
writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.invalid' } }))
writeFileSync(join(otherDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.invalid' } }))
writeFileSync(
  join(home, 'accounts.json'),
  JSON.stringify({ allowed: ['garden@example.invalid'], claude: claudeDir, codex: codexDir }),
)

const garden = await startInstance({ home, entry: 'tsx' })
const project = mkdtempSync(join(tmpdir(), 'garden-one-account-'))
writeFileSync(join(project, 'CLAUDE.md'), '# scratch\n')

const state = { projects: [], sessions: [], profiles: [], errors: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'project.updated') state.projects = state.projects.map((p) => (p.id === m.project.id ? m.project : p))
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'profiles') state.profiles = m.profiles
  else if (m.t === 'error') state.errors.push(String(m.message ?? m.error ?? JSON.stringify(m)))
})

try {
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(500)
  ws.send(JSON.stringify({ t: 'project.add', path: project.replace(/\\/g, '/') }))
  await sleep(1500)
  const p = state.projects.find((x) => x.path.toLowerCase() === project.toLowerCase())
  check('the scratch project was added', !!p)

  // The rule binds within one refresh (five seconds).
  await sleep(6000)
  const bound = state.projects.find((x) => x.id === p?.id)
  check('the project runs Claude on Garden\'s account', bound?.profiles?.claude === 'garden-account:claude', JSON.stringify(bound?.profiles))
  check('the project runs Codex on Garden\'s account', bound?.profiles?.codex === 'garden-account:codex', JSON.stringify(bound?.profiles))

  // A Claude card on that project: its directory is signed in as another account.
  ws.send(JSON.stringify({ t: 'session.create', projectId: p.id, adapterId: 'claude', title: 'Wrong account', start: true }))
  await sleep(2500)
  const refused = state.errors.find((e) => /Wrong account not started/.test(e))
  check('a card on another account is refused at start', !!refused, refused ?? state.errors.join(' | '))
  check('the refusal says why', /not Garden's account/.test(refused ?? ''))

  // A Codex card: its directory is not signed in at all.
  ws.send(JSON.stringify({ t: 'session.create', projectId: p.id, adapterId: 'codex', title: 'Signed out', start: true }))
  await sleep(2500)
  check('a Codex card that is not signed in is refused', state.errors.some((e) => /Signed out not started: .*not signed in/.test(e)))

  // The picker: binding the project to another account's directory is refused.
  const other = state.profiles.find((x) => x.configDir?.toLowerCase() === otherDir.toLowerCase())
  ws.send(JSON.stringify({ t: 'profile.refresh' }))
  await sleep(800)
  const anyOther = other ?? state.profiles.find((x) => x.id !== 'garden-account:claude' && x.adapterId === 'claude')
  if (anyOther) {
    const before = state.errors.length
    ws.send(JSON.stringify({ t: 'project.setProfile', projectId: p.id, adapterId: 'claude', profileId: anyOther.id }))
    await sleep(800)
    check('the picker cannot bind another account', state.errors.slice(before).some((e) => /not Garden's account|not signed in/.test(e)))
  } else {
    console.log('SKIP  picker refusal: this scratch instance has no second Claude profile to pick')
  }
  ws.send(JSON.stringify({ t: 'project.setProfile', projectId: p.id, adapterId: 'claude', profileId: null }))
  await sleep(800)
  check('the picker cannot unbind to the default account', state.projects.find((x) => x.id === p.id)?.profiles?.claude === 'garden-account:claude')
} finally {
  try { ws.close() } catch {}
  await garden.stop()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
