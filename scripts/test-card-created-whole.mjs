/**
 * A card exists whole, or it does not exist.
 *
 * Two failures this catches, both of which shipped and both of which look fine on the board.
 *
 * A card created switched on never got a PEERS.md. `startSession` wrote the mail files and only
 * inserted the row afterwards, and `refreshMail` looks the card up in the store and returns
 * silently when it is not there. So the card launched wired on screen and holding a file that told
 * it it had nobody to talk to, which is the one file an agent reads to find out how to send at all.
 *
 * A card created switched off never got a CLAUDE.md. The only thing that wrote one ran from the
 * ingest dependency literal, on a hook event fired by the card's own SessionStart, so a blueprint
 * card laid out on Monday and started on Friday reached its first turn with no instructions of its
 * own. A session with none reads only the project's and the machine's, and answers as whatever
 * those describe rather than as the role on the card.
 *
 * Checks the files on disk rather than the board, because the board looked correct in both cases.
 *
 * Runs against a server of its own, on its own port with its own workspace.
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

/*
 * The card's own notes directory, found the way the server finds it: by the id suffix, not the
 * title. The title is only there to make the folder readable and a renamed card keeps its old one.
 */
function briefOf(id) {
  const root = join(garden.home, 'memory')
  const suffix = id.slice(0, 8)
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name)
    for (const card of readdirSync(dir)) {
      if (card.endsWith(suffix)) return join(dir, card, 'CLAUDE.md')
    }
  }
  return join(root, `no-directory-ending-in-${suffix}`)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-whole-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
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

const make = async (title, roleClass, reportsTo, start) => {
  ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: project.id,
      adapterId: 'shell',
      title,
      roleClass,
      reportsTo,
      start,
    }),
  )
  await sleep(start ? 1500 : 700)
  return st.sessions.find((s) => s.title === title)
}

const boss = await make('Boss', 'boss', null, false)
check('a parent card to answer to', !!boss)

// --- a card created switched ON ---

const live = await make('Live worker', 'worker', boss.id, true)
check('a card created switched on exists', !!live)

const peers = readIf(mailFile(live.id, 'PEERS.md'))
check('and it has a PEERS.md at all', peers.length > 0, 'this is the file that was missing entirely')
check('which names the card it answers to', peers.includes('Boss'), peers.slice(0, 120))
check('and tells it how to send', /garden-send\.mjs/.test(peers))

// --- a card created switched OFF ---

const off = await make('Blueprint worker', 'worker', boss.id, false)
check('a card created switched off exists', !!off)
check('and is stopped, not running', off?.status === 'stopped', off?.status)

const brief = readIf(briefOf(off.id))
check('it has a CLAUDE.md of its own', brief.length > 0, 'this is the file that was missing entirely')
check('naming the role it was created as', /\*\*worker\*\*/.test(brief), brief.split('\n').find((l) => l.includes('worker')) ?? '')
check('and who it answers to', /\*\*Boss\*\*/.test(brief))
check('and quoting the tools it is denied', /Denied by the CLI/.test(brief))
check('its powers landed too', readIf(mailFile(off.id, 'POWERS.md')).length > 0)
check('and its peers', readIf(mailFile(off.id, 'PEERS.md')).includes('Boss'))

// The switched-on card should have a brief as well; it was the only one that ever did, and only
// once a hook had already fired. Nothing here fires one, so this is the launch path proving it.
const liveBrief = readIf(briefOf(live.id))
check('the switched-on card has its brief before any hook fires', liveBrief.length > 0)

ws.close()
await garden.stop()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
