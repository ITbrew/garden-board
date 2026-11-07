/**
 * A loop that follows the ring runs while goals are left and closes when they are done, and no
 * automatic line lands on the owner's half-typed text. Canon 25 and 28. The stuck rule is tested in
 * `server/src/ring-loop.test.ts`, because it takes three loop periods. A shell card costs nothing.
 * Its own Garden and workspace. Takes about four minutes, because the loop tick is twenty seconds.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const LIST = (one, two) => `# TO DO\n\n## Now: Test\n\n- [${one}] First\n  - End: one.\n- [${two}] Second\n  - End: two.\n
## Later

- [ ] Not on the ring
`
const board = await openBoard({ cards: [{ title: 'Boss', roleClass: 'orchestrator' }, { title: 'Other' }, { title: 'Typist' }], files: { 'TODO.md': LIST(' ', ' ') } })
const card = board.cards[0]
const other = board.cards[1]
const typist = board.cards[2]
const projectId = board.project.id

let loops = []
const status = new Map()
const liveNow = () => status.get(card.id)
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'loops' && m.projectId === projectId) loops = m.loops
  if (m.t === 'session.updated') status.set(m.session.id, m.session.status)
})
const send = (m) => board.ws.send(JSON.stringify(m))
const until = async (what, seconds) => {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    const v = what()
    if (v) return v
    await sleep(500)
  }
  return null
}
const loop = () => loops[0]
const set = (patch) => send({ t: 'loop.set', projectId, loop: { id: loop()?.id, sessionId: card.id, prompt: 'rem tick', minutes: 1, followsRing: true, enabled: true, ...patch } })
const list = (one, two) => writeFileSync(join(board.dir, 'TODO.md'), LIST(one, two))

send({ t: 'session.start', sessionId: card.id })
send({ t: 'session.start', sessionId: other.id })
send({ t: 'session.start', sessionId: typist.id })
await until(() => status.get(card.id) === 'idle', 20)
await sleep(2000)

// The owner has half a line in a composer: nothing automatic may join it. Its own card, because a card
// recently typed to is deliberately left on when the ring closes.
send({ t: 'session.input', sessionId: typist.id, data: 'half typed' })
await sleep(300)
send({ t: 'loop.set', projectId, loop: { sessionId: typist.id, prompt: 'rem tick', minutes: 1, enabled: true } })
await until(() => loops[0]?.lastOutcome, 30)
check('a due loop waits for the owner to finish typing', loops[0]?.lastOutcome === 'held: owner typing' && loops[0]?.runs === 0, JSON.stringify(loops[0]))
send({ t: 'session.input', sessionId: typist.id, data: '\r' })
await until(() => loops[0]?.runs >= 1, 45)
check('and types once they have sent it', loops[0]?.runs >= 1, JSON.stringify(loops[0]))
send({ t: 'loop.delete', projectId, id: loops[0].id })
send({ t: 'session.stop', sessionId: typist.id })
await until(() => loops.length === 0, 5)

set({})
await until(() => loop()?.runs >= 1, 45)
check('the panel can show how many goals are left', /2 of 2 left/.test(loop()?.lastOutcome ?? ''), loop()?.lastOutcome)
check('it follows the ring', loop()?.followsRing === true && loop()?.enabled === true)

list('x', ' ')
await sleep(25000)
check('one goal done keeps it running', loop()?.enabled === true, JSON.stringify(loop()))

list('x', 'x')
await until(() => loop()?.enabled === false, 45)
check('a full ring closes the loop', loop()?.enabled === false && loop()?.stoppedBy === 'ring', JSON.stringify(loop()))
check('and says so', /finished/.test(loop()?.lastOutcome ?? ''), loop()?.lastOutcome)
await until(() => !['idle', 'working', 'starting'].includes(status.get(card.id)) && !['idle', 'working', 'starting'].includes(status.get(other.id)), 110)
check('the worker turns off', !['idle', 'working', 'starting'].includes(status.get(other.id)), status.get(other.id))
check('and so does the orchestrator', !['idle', 'working', 'starting'].includes(liveNow()), liveNow())

list('x', ' ')
await until(() => loop()?.enabled === true, 45)
check('a new open goal starts the loop again', loop()?.enabled === true && loop()?.stoppedBy === null, JSON.stringify(loop()))
await until(() => ['idle', 'starting', 'working'].includes(liveNow()), 45)
check('and wakes the orchestrator that was off', ['idle', 'starting', 'working'].includes(liveNow()), liveNow())
check('but not the worker', !['idle', 'starting', 'working'].includes(status.get(other.id)), status.get(other.id))

set({ enabled: false })
await sleep(800)
check('stopped by hand', loop()?.enabled === false && loop()?.stoppedBy === 'owner', JSON.stringify(loop()))
await sleep(25000)
check('it stays stopped with goals still left', loop()?.enabled === false, JSON.stringify(loop()))

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
