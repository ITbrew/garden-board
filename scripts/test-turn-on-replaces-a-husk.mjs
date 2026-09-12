/**
 * Turn on works on a card whose shell outlived the agent inside it.
 *
 * A card is a shell with a CLI running in it, and those are two lifetimes. When the CLI ends and the
 * shell does not, the card's status says `done` while its process is still there. Everything the
 * owner can see says that card is off, and pressing Turn on did nothing at all: the handler's first
 * line was "if a process is live, return", which could not tell a running card from a husk. He found
 * it the only way it can be found, by pressing the button: "i cant start that card back up after i
 * stopped its session".
 *
 * The husk is built here the way the real one was built, by posting the SessionEnd hook the CLI
 * posts when it exits, which sets the status while leaving the process alone.
 *
 * Its own instance, its own workspace, its own scratch project. Nothing here touches the live board.
 */
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Husk', 'Healthy'] })
const [husk, healthy] = board.cards

// `openBoard`'s own listener tracks cards being added and not cards changing, and every fact this
// test is about arrives as a change. A second listener on the same socket is enough.
const live = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.updated') live.set(m.session.id, m.session)
  if (m.t === 'state') for (const s of m.sessions) live.set(s.id, s)
})
const at = (id) => live.get(id) ?? board.state.sessions.find((s) => s.id === id)

const hook = async (sessionId, name) => {
  await fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gardenSessionId: sessionId,
      receivedAt: Date.now(),
      event: { hook_event_name: name, session_id: `husk-test-${sessionId}` },
    }),
  })
  await sleep(300)
}

// ---------------------------------------------------------------------------
// A card that really is running is left alone, which is what the old line was for.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: healthy.id }))
await sleep(2500)
const healthyPid = at(healthy.id)?.pid
check('the control card came up', typeof healthyPid === 'number', String(healthyPid))
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: healthy.id }))
await sleep(1800)
check(
  'starting a card that is running does not replace its process',
  at(healthy.id)?.pid === healthyPid,
  `${healthyPid} -> ${at(healthy.id)?.pid}`,
)

// ---------------------------------------------------------------------------
// The husk: a live process under a card whose status reads as off.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: husk.id }))
await sleep(2500)
const firstPid = at(husk.id)?.pid
check('the card came up', typeof firstPid === 'number', String(firstPid))

await hook(husk.id, 'SessionEnd')
const ended = at(husk.id)
check('the agent ending puts the card in the state the board draws as off', ended?.status === 'done', ended?.status)
check('and its process is still there, which is what made it a husk', ended?.pid === firstPid, String(ended?.pid))
// Read from the operating system rather than from the row, since the row is the thing under test.
const alive = (() => {
  try {
    process.kill(firstPid, 0)
    return true
  } catch {
    return false
  }
})()
check('the shell really is still running', alive, `pid ${firstPid}`)

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: husk.id }))
await sleep(6000)
const after = at(husk.id)
check('Turn on gave it a new process', typeof after?.pid === 'number' && after.pid !== firstPid, `${firstPid} -> ${after?.pid}`)
check('and the card no longer reads as off', after?.status !== 'done' && after?.status !== 'stopped', after?.status)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
