/**
 * What a card is told agrees with its role, and with itself. Canon 12 revision 8.
 *
 * The owner asked for the role files and the briefs to be reviewed so that "there is clarity on
 * those things". The review found cards reading two answers in one startup: a worker whose
 * POWERS.md said Agent was denied and, a few lines later, to spawn as many subagents as it needed;
 * any card with no reporting line told it answered to the owner and nobody else, above a brief
 * naming its manager; a boss card reading a role file for a chain that no longer exists; empty deny
 * lists printed as "Denied by the CLI: ."; and a to-do command no shell expands.
 *
 * Runs against a server of its own, on its own port with its own workspace, and reads the files
 * Garden wrote for cards created switched off, and the roots it seeded into that fresh workspace.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
const mailFile = (id, name) => join(garden.home, 'mail', id, name)
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

/** The card's own directory, found by the id suffix the way the server finds it. */
function cardDir(id) {
  const root = join(garden.home, 'memory')
  const suffix = id.slice(0, 8)
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const card of readdirSync(join(root, project.name))) {
      if (card.endsWith(suffix)) return join(root, project.name, card)
    }
  }
  return join(root, `no-directory-ending-in-${suffix}`)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-told-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], context: new Map() }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'context.list') st.context.set(m.sessionId, m.entries)
  else if (m.t === 'error') console.log('   server said:', m.message)
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

const make = async (title, roleClass, reportsTo) => {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, roleClass, reportsTo, start: false }))
  await sleep(700)
  return st.sessions.find((s) => s.title === title)
}

const orch = await make('Orchestrator', 'orchestrator', null)
const mgr = await make('Manager', 'manager', orch?.id ?? null)
const worker = await make('Worker', 'worker', mgr?.id ?? null)
const loose = await make('Loose worker', 'worker', null)
const boss = await make('Old boss', 'boss', orch?.id ?? null)
check('five cards to read', !!(orch && mgr && worker && loose && boss))

// --- a worker is not told to do what its CLI refuses ---

const workerPowers = readIf(mailFile(worker.id, 'POWERS.md'))
check('a worker is told Agent is denied', /Denied by the CLI:.*Agent/.test(workerPowers))
// Whitespace-tolerant, because the generated text wraps: the old sentence broke between "as" and "many".
const invited = /as\s+many\s+subagents|A\s+subagent\s+is\s+for/.exec(workerPowers)
check('and is not told to spawn subagents anyway', !invited, invited ? invited[0].replace(/\s+/g, ' ') : '')
check('it is told it may not spawn one', /You may not spawn subagents/.test(workerPowers))
check('and is not handed the procedure for hiring', !/garden-hire\.mjs/.test(workerPowers))

// --- a manager asks for cards, and uses subagents sparingly ---

const mgrPowers = readIf(mailFile(mgr.id, 'POWERS.md'))
check('a manager is handed the hire command with --reports-to and --owns',
  /garden-hire\.mjs"[^\n]*\n[^\n]*--reports-to \S+ --owns /.test(mgrPowers))
check('and pointed at the guide for writing a brief', mgrPowers.includes('composing-roots.md'))
check('and told most work needs none or one subagent', mgrPowers.includes('Most work needs none or one'))

// --- who a card answers to ---

const orchBrief = readIf(join(cardDir(orch.id), 'CLAUDE.md'))
const looseBrief = readIf(join(cardDir(loose.id), 'CLAUDE.md'))
check('the orchestrator is told it answers to the owner', /You answer to the owner directly\./.test(orchBrief))
check('a worker with no reporting line is not told the owner is its only boss',
  !/Nobody else on this board is above you/.test(looseBrief))
check('it is told no line is set, and to report where its brief says',
  /No reporting line is set on this card\. If your brief names who you report to, report there/.test(looseBrief))
check('and its POWERS.md says the same', readIf(mailFile(loose.id, 'POWERS.md')).includes('No reporting line is set on this card.'))

// --- territory ---

check('a hired worker with no paths is told what "yours" means',
  readIf(mailFile(loose.id, 'POWERS.md')).includes('No paths were assigned to you'))
check('the orchestrator is not told to ask before editing',
  readIf(mailFile(orch.id, 'POWERS.md')).includes('nothing narrows where you may work'))

// --- empty lists are said in words ---

check('an empty deny list reads as a sentence in the brief',
  orchBrief.includes('Nothing is denied to you by the CLI.') && !/fail quietly: \./.test(orchBrief))
check('and in POWERS.md', !/Denied by the CLI: \./.test(readIf(mailFile(orch.id, 'POWERS.md'))))

// --- role files ---

ws.send(JSON.stringify({ t: 'context.list', sessionId: boss.id }))
for (let i = 0; i < 20 && !st.context.has(boss.id); i++) await sleep(100)
const roleEntry = (st.context.get(boss.id) ?? []).find((e) => /\(this role\)/.test(e.title))
check("a boss card reads the manager's role file", !!roleEntry && /roles[\\/]manager\.md$/.test(roleEntry.display),
  roleEntry ? roleEntry.display : 'no role file listed')

const roots = join(garden.home, 'roots')
check('no boss or delegator file is seeded',
  !existsSync(join(roots, 'roles', 'boss.md')) && !existsSync(join(roots, 'roles', 'delegator.md')))
check('a verifier has a role file', existsSync(join(roots, 'roles', 'verifier.md')))
check('the guide for writing a brief is seeded', existsSync(join(roots, 'detail', 'composing-roots.md')))
check('the to-do procedure is seeded', existsSync(join(roots, 'detail', 'the-to-do-list.md')))

const shared = readIf(join(roots, 'ALL.md')).trim().length
const largest = Math.max(0, ...readdirSync(join(roots, 'roles')).map((f) => readIf(join(roots, 'roles', f)).trim().length))
check('ALL.md and the largest role file fit the 3400 the startup hook reserves', shared + largest <= 3400, `${shared} + ${largest}`)

const seeded = [
  join(roots, 'ALL.md'),
  ...readdirSync(join(roots, 'roles')).map((f) => join(roots, 'roles', f)),
  ...readdirSync(join(roots, 'detail')).map((f) => join(roots, 'detail', f)),
]
const dashed = seeded.filter((f) => readIf(f).includes('—'))
check('no seeded file carries an em dash', dashed.length === 0, dashed.join(', '))
const cmdVars = seeded.filter((f) => /%GARDEN_BIN%/.test(readIf(f)))
check('no seeded file carries a %VAR% command neither shell expands', cmdVars.length === 0, cmdVars.join(', '))

// --- reading index ---

const orchIndex = readIf(join(cardDir(orch.id), 'ROOTS.md'))
check("the orchestrator's reading index points at the guide", orchIndex.includes('composing-roots.md'))
check('and carries no em dash', !orchIndex.includes('—'))
check("a worker's reading index does not", !readIf(join(cardDir(worker.id), 'ROOTS.md')).includes('composing-roots.md'))

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
