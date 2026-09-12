/**
 * A card can switch its own loop off, from its own terminal, and cannot switch another card's off.
 *
 * The owner asked for the first half while the loops feature was being built: "i want orhcestrator
 * to be able to turn loops off if ledger is completed", and then again as the condition it exists
 * for, a card stopping its own check-in "upon completion condition". A loop whose prompt ends by
 * telling the card to stop when the work is finished is useless if the card cannot stop it.
 *
 * The second half is the guard that makes the first half safe. A loop types into a card every few
 * minutes, which canon 18 puts with creation rather than with the reads, so a card reaching for
 * another card's loop is refused and told to send mail instead.
 *
 * Both are driven the way a real card would drive them: the command is typed into the card's own
 * shell, so it runs with that card's own GARDEN_SESSION_TOKEN rather than with the owner's socket.
 * That is the whole point of the test. Nothing here touches the live board.
 */
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Self', 'Other'] })
const [self, other] = board.cards

const loops = new Map()
const scroll = {}
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'loops') for (const l of m.loops) loops.set(l.id, l)
  if (m.t === 'session.scrollback') scroll[m.sessionId] = m.data
})
const loopOn = (cardId) => [...loops.values()].find((l) => l.sessionId === cardId)

const type = async (cardId, line) => {
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: cardId, data: line }))
  await sleep(250)
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: cardId, data: '\r' }))
  await sleep(4000)
}
const readBack = async (cardId) => {
  scroll[cardId] = undefined
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: cardId }))
  await sleep(900)
  return (scroll[cardId] ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

for (const c of [self, other]) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(4000)

const CLI = 'node C:/Garden/server/bin/garden-loop.mjs'
// An hour apart and a harmless prompt: this test is about the switch, not about the tick.
for (const c of [self, other]) {
  board.ws.send(
    JSON.stringify({
      t: 'loop.set',
      projectId: board.project.id,
      loop: { sessionId: c.id, prompt: `echo tick_${c.title}`, minutes: 60, enabled: true },
    }),
  )
  await sleep(1500)
}
check('both cards have a loop running', !!loopOn(self.id)?.enabled && !!loopOn(other.id)?.enabled,
  `${loopOn(self.id)?.enabled} / ${loopOn(other.id)?.enabled}`)

// ---------------------------------------------------------------------------
// Its own loop: allowed, which is the completion condition the owner asked for.
// ---------------------------------------------------------------------------
await type(self.id, `${CLI} --off --card "Self"`)
check('a card switched its own loop off', loopOn(self.id)?.enabled === false, String(loopOn(self.id)?.enabled))

// ---------------------------------------------------------------------------
// Another card's loop: refused, and the refusal says what to do instead.
// ---------------------------------------------------------------------------
await type(self.id, `${CLI} --off --card "Other"`)
check('the other card\'s loop is still running', loopOn(other.id)?.enabled === true, String(loopOn(other.id)?.enabled))
const said = await readBack(self.id)
check('and the card was told why', /control plane|mail along a wire/i.test(said),
  said.split('\n').filter((l) => /loop|wire|plane/i.test(l)).slice(-1)[0] ?? 'nothing about it in the scrollback')

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
