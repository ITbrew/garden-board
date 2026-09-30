/**
 * "Agent cards running at once" holds a card that mail would start. Canon 15 revision 14.
 *
 * The owner: "'agent cards running at once' is the budget orchestrator is allowed to have cards
 * running at once". Every start went through that limit except the one mail makes: a message to a
 * card that is off started it directly. What is held here, on a board whose limit is one:
 *
 * - With one card running, mail to a card that is off is filed, the card is NOT started, and the
 *   sender is told the board is at its running limit.
 * - When the running card stops, the waiting card starts on its own.
 *
 * Shell cards only, so nothing real is started. Its own Garden on its own port and workspace.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({
  projectName: 'running-limit',
  cards: [
    { title: 'Sender', roleClass: 'manager' },
    { title: 'Reader', roleClass: 'worker', reportsTo: 0 },
    { title: 'Busy', roleClass: 'worker', reportsTo: 0 },
  ],
})
const [sender, reader, busy] = board.cards
const sessions = new Map(board.state.sessions.map((s) => [s.id, s]))
const tokens = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated' || m.t === 'session.added') sessions.set(m.session.id, m.session)
  if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
})
const on = (id) => {
  const s = sessions.get(id)
  return !!s && s.pid != null && !['stopped', 'failed', 'done'].includes(s.status)
}

board.ws.send(JSON.stringify({ t: 'limits.set', projectId: board.project.id, limits: { running: 1, cardsPerProject: 40, childrenPerCard: 10 } }))
await sleep(400)
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: busy.id }))
for (let i = 0; i < 40 && !on(busy.id); i++) await sleep(250)
check('one card is running, so the board is at its limit of one', on(busy.id))

board.ws.send(JSON.stringify({ t: 'session.token', sessionId: sender.id }))
for (let i = 0; i < 20 && !tokens.has(sender.id); i++) await sleep(100)
const shim = readFileSync(join(board.home, 'mail', sender.id, 'PEERS.md'), 'utf8').match(/node "([^"]+garden-send\.mjs)"/)?.[1]
const sent = await new Promise((done) => {
  const child = spawn(process.execPath, [shim, '--to', 'Reader', '--kind', 'question', '--text', 'LIMITCHECK are you there'], {
    env: { ...process.env, GARDEN_SESSION_ID: sender.id, GARDEN_SESSION_TOKEN: tokens.get(sender.id) ?? '', GARDEN_PORT: String(board.port) },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (out += b))
  child.on('close', (code) => done({ ok: code === 0, out: out.trim() }))
})
check('the send is accepted', sent.ok, sent.out)
check('and the sender is told the board is at its running limit', /running at once/.test(sent.out), sent.out)
const inbox = join(board.home, 'mail', reader.id, 'INBOX.md')
check('the message is in the inbox', existsSync(inbox) && readFileSync(inbox, 'utf8').includes('LIMITCHECK'))

await sleep(3000)
check('the card mail was sent to is not started while the board is full', !on(reader.id), sessions.get(reader.id)?.status)

board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: busy.id }))
let started = false
for (let i = 0; i < 60 && !started; i++) {
  await sleep(250)
  started = on(reader.id)
}
check('when the running card stops, the waiting card starts on its own', started, sessions.get(reader.id)?.status)

board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: reader.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
