/**
 * A wire that carries something.
 *
 * Checks the files on disk rather than the board, because the point of the mailbox is that it
 * exists outside Garden: an agent finds its peers and its messages by reading files it was handed
 * the path to, with no live connection to the app.
 */
import WebSocket from 'ws'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

const garden = await target()
const PORT = garden.port
/* The instance's own workspace, never the owner's ~/.garden. */
const GARDEN_HOME = garden.home ?? join(homedir(), '.garden')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}
const mailFile = (id, name) => join(GARDEN_HOME, 'mail', id, name)
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

const dir = mkdtempSync(join(tmpdir(), 'garden-mail-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], wires: [], pulses: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'wire.removed') st.wires = st.wires.filter((w) => w.id !== m.wireId)
  else if (m.t === 'wire.pulse') st.pulses.push(m.wireId)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const stamp = Date.now().toString().slice(-5)
for (const n of ['Lead', 'Coder']) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: `${n} ${stamp}` }))
  await sleep(1800)
}
const lead = st.sessions.find((s) => s.title === `Lead ${stamp}`)
const coder = st.sessions.find((s) => s.title === `Coder ${stamp}`)
check('two sessions to wire together', !!lead && !!coder)
if (!lead || !coder) process.exit(1)

ws.send(JSON.stringify({
  t: 'wire.create', projectId: project.id, sourceId: lead.id, targetId: coder.id, label: 'work orders',
}))
await sleep(700)
const wire = st.wires.find((w) => w.sourceId === lead.id && w.targetId === coder.id)
check('the wire exists', !!wire)

const leadPeers = readIf(mailFile(lead.id, 'PEERS.md'))
const coderPeers = readIf(mailFile(coder.id, 'PEERS.md'))
check('the sender learns who it is wired to', leadPeers.includes(`Coder ${stamp}`), leadPeers.slice(0, 80))
check('the receiver learns it from its side too', coderPeers.includes(`Lead ${stamp}`), coderPeers.slice(0, 80))
/*
 * A wire drawn by hand is two-way unless it is told otherwise. It used to be born one-way whatever
 * the caller asked for, so a card the owner had just connected could be spoken to and could not
 * answer until he found the toggle in a right-click menu.
 */
check('a wire drawn by hand is two-way to begin with', !!wire?.bidirectional)
check('and both ends read it that way',
  leadPeers.includes('both ways') && coderPeers.includes('both ways'), leadPeers.slice(0, 80))

// A one-way wire and a two-way one must not read the same, since only one of them permits a reply.
ws.send(JSON.stringify({ t: 'wire.setDirection', wireId: wire.id, bidirectional: false }))
await sleep(600)
check('made one way, the sender is told it cannot be replied to',
  readIf(mailFile(lead.id, 'PEERS.md')).includes('you send to them'))
check('and the receiver is told it cannot reply',
  readIf(mailFile(coder.id, 'PEERS.md')).includes('they send to you'))

ws.send(JSON.stringify({ t: 'wire.setDirection', wireId: wire.id, bidirectional: true }))
await sleep(600)
check('a two-way wire says so on both sides',
  readIf(mailFile(lead.id, 'PEERS.md')).includes('both ways') &&
  readIf(mailFile(coder.id, 'PEERS.md')).includes('both ways'),
  'direction not carried')
ws.send(JSON.stringify({ t: 'wire.setDirection', wireId: wire.id, bidirectional: false }))
await sleep(600)
check('the wire label travels with it', leadPeers.includes('work orders'), 'label missing')

ws.send(JSON.stringify({ t: 'wire.send', wireId: wire.id, text: 'take the loader refactor, canon doc is written' }))
await sleep(600)
const inbox = readIf(mailFile(coder.id, 'INBOX.md'))
check('the message lands in the receiver\'s inbox', inbox.includes('take the loader refactor'), inbox.slice(0, 80))
check('and says who sent it', inbox.includes(`Lead ${stamp}`), 'sender missing')
check('the wire pulsed when it carried something', st.pulses.includes(wire.id), `${st.pulses.length} pulses`)

const senderInbox = readIf(mailFile(lead.id, 'INBOX.md'))
check('the sender does not receive its own message', !senderInbox.includes('take the loader refactor'), 'echoed back')

// A second message appends rather than replacing the first: an inbox is a record.
ws.send(JSON.stringify({ t: 'wire.send', wireId: wire.id, text: 'second note' }))
await sleep(500)
const inbox2 = readIf(mailFile(coder.id, 'INBOX.md'))
check('messages accumulate rather than overwrite',
  inbox2.includes('take the loader refactor') && inbox2.includes('second note'), inbox2.slice(-60))

ws.send(JSON.stringify({ t: 'wire.delete', wireId: wire.id }))
await sleep(600)
const afterPeers = readIf(mailFile(lead.id, 'PEERS.md'))
check('deleting the wire removes the peer', !afterPeers.includes(`Coder ${stamp}`), afterPeers.slice(0, 90))
check('but the inbox keeps what was already delivered',
  readIf(mailFile(coder.id, 'INBOX.md')).includes('take the loader refactor'), 'history lost')

for (const s of [lead, coder]) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(400)
}
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(600)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
