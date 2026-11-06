/**
 * Proves the history arrow offers days rather than dropping every turn on the board.
 *
 * The owner asked for history to be "collapsed by default as well", meaning as well as the roots,
 * which stopped opening a hundred file cards at once and became columns you open one at a time. His
 * orchestrator has days of turns behind it, and the arrow put all of them on the board together.
 *
 * By day rather than by task, and that is a substitution worth stating in the test that locks it in.
 * A work record carries who asked, what was asked, when it started and which files it touched. There
 * is no identifier tying several turns into one piece of work, so "one pill per task" is not a
 * grouping this data can honestly make. A day is real, countable, and for a long-running card it is
 * the division he would draw himself.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const garden = await startInstance()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(gardenSessionId, event) {
  await (
    await fetch(`http://127.0.0.1:${PORT}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gardenSessionId, receivedAt: Date.now(), event }),
    })
  ).text()
  await sleep(120)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-histday-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], docs: [], groups: null }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'history.groups') st.groups = m
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())

const title = `Day ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(1500)
const card = st.sessions.find((s) => s.title === title)

const SID = `day-${Date.now()}`
await hook(card.id, { hook_event_name: 'SessionStart', session_id: SID })
for (const [id, ask] of [
  ['p1', 'rename the loader module'],
  ['p2', 'fix the route stroke width'],
  ['p3', 'check the label row'],
]) {
  await hook(card.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: id, prompt: ask })
  /*
   * Each turn touches a file, because a turn that did nothing is not written as a page at all.
   * `hasSubstance` in history.ts is the rule, and a test whose turns fail it would be asserting
   * against a count that deliberately excludes them.
   */
  await hook(card.id, {
    hook_event_name: 'PostToolUse', session_id: SID, prompt_id: id,
    tool_name: 'Write', tool_input: { file_path: `C:/scratch/${id}.ts` },
  })
  await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: id })
}

const historyCards = () => st.docs.filter((d) => d.ownerId === card.id && d.web === 'history')

// --- the arrow offers days and puts nothing on the board ------------------------------------------

st.groups = null
ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id }))
await sleep(1500)

check('pressing the arrow answers with the days', !!st.groups, st.groups ? `${st.groups.groups.length} day(s)` : '(nothing)')
check(
  'and puts no turns on the board yet',
  historyCards().length === 0,
  `${historyCards().length} history cards drawn`,
)
const today = st.groups?.groups?.[0]
check(
  'the day it offers holds every turn taken',
  today?.count === 3,
  today ? `"${today.label}" with ${today.count}` : '(no day)',
)
check('and it is labelled as today', today?.label === 'Today', today?.label)

// --- opening one day draws that day -------------------------------------------------------------

ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id, group: today.group }))
await sleep(2000)

check(
  'opening a day draws exactly as many turns as its pill promised',
  historyCards().length === today.count,
  `pill said ${today.count}, drew ${historyCards().length}`,
)
check(
  'and every one is filed under that day, so it can be folded on its own',
  historyCards().every((d) => d.group === today.group),
  [...new Set(historyCards().map((d) => d.group))].join(', '),
)
check(
  'the board is told which day is open',
  st.groups?.open?.includes(today.group),
  (st.groups?.open ?? []).join(', ') || '(none)',
)

// --- and folding it leaves the day on offer -------------------------------------------------------

ws.send(JSON.stringify({ t: 'history.closeGroup', sessionId: card.id, group: today.group }))
await sleep(1500)

check('folding a day takes its turns off the board', historyCards().length === 0, `${historyCards().length} cards`)
check(
  'but the day is still there to open again',
  st.groups?.groups?.some((g) => g.group === today.group) && !st.groups.open.includes(today.group),
  `${st.groups?.groups?.length ?? 0} day(s), ${st.groups?.open?.length ?? 0} open`,
)

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
