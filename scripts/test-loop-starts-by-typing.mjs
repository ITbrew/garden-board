/**
 * Start on a loop types the prompt into the card now, and the run count counts what was typed.
 *
 * Two things the owner asked for in the same stretch. "add statistic that shows how many times loop
 * has ran", and then, after watching a loop sit silent for its first period: "make the start button
 * send the message to the card for designated loop so it understands loop sequence and starts the
 * loop." Canon 25 records the reversal; this is the proof it holds.
 *
 * The prompt is an `echo` with a marker in it and the card is a plain shell, so "it was typed" is
 * read back out of the card's own scrollback rather than from anything this script decided. The
 * count is read from the server's loop row.
 *
 * Its own instance, its own workspace. Nothing here touches the live board.
 */
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const marker = `GARDEN_LOOP_${Date.now().toString().slice(-6)}`
const board = await openBoard({ cards: ['Looped'] })
const card = board.cards[0]

const loops = new Map()
const scroll = {}
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'loops') for (const l of m.loops) loops.set(l.id, l)
  if (m.t === 'session.scrollback') scroll[m.sessionId] = m.data
})

const readScrollback = async () => {
  scroll[card.id] = undefined
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  await sleep(900)
  return (scroll[card.id] ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}
const theLoop = () => [...loops.values()][0]

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(3000)

// An hour apart, so nothing that happens below can be the interval coming round.
const set = (patch) =>
  board.ws.send(
    JSON.stringify({
      t: 'loop.set',
      projectId: board.project.id,
      loop: { id: theLoop()?.id, sessionId: card.id, prompt: `echo ${marker}`, minutes: 60, ...patch },
    }),
  )

set({ enabled: false })
await sleep(1200)
check('the loop exists and has never run', theLoop()?.runs === 0, JSON.stringify(theLoop()?.runs))
const quiet = await readScrollback()
check('a stopped loop types nothing', !quiet.includes(marker))

set({ enabled: true })
await sleep(3000)
const typed = await readScrollback()
check('Start typed the prompt straight away', typed.includes(marker), `${typed.split(marker).length - 1} occurrences`)
check('and the run was counted', theLoop()?.runs === 1, JSON.stringify(theLoop()?.runs))
check('the outcome says it typed', theLoop()?.lastOutcome === 'typed', String(theLoop()?.lastOutcome))

// Editing a running loop is not a start. The clock is left alone, so correcting a typo in a prompt
// does not type into the card.
set({ enabled: true, minutes: 45 })
await sleep(2500)
check('editing a running loop does not type again', theLoop()?.runs === 1, JSON.stringify(theLoop()?.runs))
check('and the edit took', theLoop()?.minutes === 45, String(theLoop()?.minutes))

set({ enabled: false })
await sleep(1000)
set({ enabled: true })
await sleep(3000)
check('starting it again types again', theLoop()?.runs === 2, JSON.stringify(theLoop()?.runs))
const twice = await readScrollback()
check('and the card saw it twice', twice.split(marker).length - 1 >= 3, `${twice.split(marker).length - 1} occurrences`)

// The count survives the loop being edited, because it is the history of the card being typed into
// rather than of one particular wording.
set({ enabled: true, minutes: 60 })
await sleep(1500)
check('the count is not reset by an edit', theLoop()?.runs === 2, JSON.stringify(theLoop()?.runs))

/*
 * The interval, not just the button.
 *
 * Everything above is a loop starting, and the owner's question was about every send: "make sure
 * runs get +1 each tiem the loop card is sent". The tick and the Start share one line in the store,
 * but sharing a line is an argument rather than evidence, so this waits out a real minute and counts
 * what the tick did. It is the slowest assertion in the file and it is the one he asked for.
 */
const beforeTick = theLoop()?.runs
set({ enabled: true, minutes: 1 })
await sleep(3000)
check('shortening a running loop is an edit, not a start', theLoop()?.runs === beforeTick, JSON.stringify(theLoop()?.runs))
// A minute for the interval, plus a tick's twenty seconds, plus room for a slow machine.
for (let waited = 0; waited < 100_000 && theLoop()?.runs === beforeTick; waited += 5000) await sleep(5000)
check('the tick counted its own send', theLoop()?.runs === beforeTick + 1, JSON.stringify(theLoop()?.runs))
const thrice = await readScrollback()
check('and the card saw the prompt again', thrice.split(marker).length - 1 >= 5, `${thrice.split(marker).length - 1} occurrences`)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
