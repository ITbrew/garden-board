/**
 * What a review actually looked at.
 *
 * A history card can say a review command ran. That is a fact about a command, and on its own it
 * settles nothing: a blind review is worth exactly as much as the image it was handed. So a turn
 * that opened pictures carries them on a dot of its own, and this checks the whole path, from the
 * CLI reporting a Read through to a card on the board holding that file.
 *
 * The one thing it must never do is offer a dot with nothing behind it, so the case of a turn
 * that reviewed nothing is checked as carefully as the case that did.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { target } from './lib/target.mjs'

const garden = await target()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(sessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(200)
}

const dir = mkdtempSync(join(tmpdir(), 'garden-review-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
// A real file on disk, so the card has something to point at.
const shot = join(dir, 'screen-01.png').replace(/\\/g, '/')
writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))

const st = { projects: [], sessions: [], docs: [], wires: [], groups: [] }
let lastError = ''
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
  else if (m.t === 'wire.removed') st.wires = st.wires.filter((w) => w.id !== m.wireId)
  else if (m.t === 'history.groups') st.groups = m.groups
  else if (m.t === 'error') lastError = m.message
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1300)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) { console.log('FAIL  scratch project'); process.exit(1) }

const title = `Review ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2000)
const card = st.sessions.find((s) => s.title === title)
if (!card) { console.log('FAIL  scratch card'); process.exit(1) }

const SID = `rev-${Date.now()}`
await hook(card.id, { hook_event_name: 'SessionStart', session_id: SID })

// Turn one: a blind review that opened a screenshot and wrote up what it saw.
//
// The findings file is not decoration. A blind reviewer writes its findings to disk so the artifact
// outlives the agent, which is the rule in canon 14 and the reason a reviewer's verdict can be
// quoted rather than paraphrased. It is also what earns this turn a history page at all: since
// 2026-09-08 a page is a change rather than an activity, so a turn that only opened a picture and
// said nothing to disk is counted in the archive and given no page. This fixture used to post the
// read alone, which modelled a reviewer that never reported.
await hook(card.id, {
  hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: 'p1',
  prompt: 'have the blind reviewer look at the new screen',
})
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: SID, prompt_id: 'p1',
  tool_name: 'Read', tool_input: { file_path: shot },
})
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: SID, prompt_id: 'p1',
  tool_name: 'Write', tool_input: { file_path: 'C:/scratch/blind-findings.md' },
})
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: 'p1' })

// Turn two: ordinary work, no pictures anywhere near it.
await hook(card.id, {
  hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id: 'p2', prompt: 'rename the loader',
})
await hook(card.id, {
  hook_event_name: 'PostToolUse', session_id: SID, prompt_id: 'p2',
  tool_name: 'Edit', tool_input: { file_path: 'C:/scratch/loader.ts' },
})
await hook(card.id, { hook_event_name: 'Stop', session_id: SID, prompt_id: 'p2' })

/*
 * The days first, then the day, which is what the arrow on the card has done since commit 060fe7b.
 *
 * A bare `history.open` used to draw every turn a card had ever taken; it now answers with the days
 * available and draws nothing, and a day arrives when it is asked for by name. This file was written
 * before that change and kept asking the old way, so it read "0 turns" and looked like a broken
 * history rather than a stale test.
 */
ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id }))
await sleep(900)
check('the arrow answers with the days available', st.groups.length >= 1, `${st.groups.length} groups`)
for (const g of st.groups) {
  ws.send(JSON.stringify({ t: 'history.open', sessionId: card.id, group: g.group }))
  await sleep(800)
}
await sleep(800)
const turns = st.docs.filter((d) => d.ownerId === card.id && d.web === 'history')
check('both turns are on the board', turns.length === 2, `${turns.length} turns`)

const reviewTurn = turns.find((t) => t.title.includes('blind reviewer'))
const plainTurn = turns.find((t) => t.title.includes('rename'))
check('the review turn recorded what it opened', reviewTurn?.images.length === 1,
  JSON.stringify(reviewTurn?.images ?? []))
check('and named the actual file', reviewTurn?.images[0]?.toLowerCase().endsWith('screen-01.png'),
  String(reviewTurn?.images[0]))
check('the turn that reviewed nothing records nothing', plainTurn?.images.length === 0,
  JSON.stringify(plainTurn?.images ?? []))
check('a code file is not mistaken for a picture',
  !JSON.stringify(plainTurn?.images ?? []).includes('loader.ts'))

ws.send(JSON.stringify({ t: 'evidence.open', cardId: reviewTurn.id }))
await sleep(1200)
const shots = st.docs.filter((d) => d.ownerId === reviewTurn.id)
check('opening the dot puts the picture on the board', shots.length === 1, `${shots.length} images`)
check('as an image rather than text', shots[0]?.kind === 'image', String(shots[0]?.kind))
check('to the right of the turn that reviewed it', shots[0]?.x > reviewTurn.x + reviewTurn.width,
  `${Math.round(shots[0]?.x)} vs turn ending at ${Math.round(reviewTurn.x + reviewTurn.width)}`)

const wire = st.wires.find((w) => w.sourceId === reviewTurn.id && w.targetId === shots[0]?.id)
check('wired to that turn, on its own kind', wire?.kind === 'evidence', String(wire?.kind))

lastError = ''
ws.send(JSON.stringify({ t: 'evidence.open', cardId: plainTurn.id }))
await sleep(700)
check('a turn with no pictures offers none and says so',
  st.docs.filter((d) => d.ownerId === plainTurn.id).length === 0 && lastError.includes('no images'),
  lastError || 'no message')

ws.send(JSON.stringify({ t: 'evidence.close', cardId: reviewTurn.id }))
await sleep(700)
check('closing it takes the picture and its wire away',
  st.docs.filter((d) => d.ownerId === reviewTurn.id).length === 0 &&
  !st.wires.some((w) => w.sourceId === reviewTurn.id))

// Folding the history away must not leave pictures wired to a card that no longer exists.
ws.send(JSON.stringify({ t: 'evidence.open', cardId: reviewTurn.id }))
await sleep(900)
ws.send(JSON.stringify({ t: 'history.close', sessionId: card.id }))
await sleep(1200)
check('folding the history away takes any open pictures with it',
  st.docs.filter((d) => d.projectId === project.id).length === 0,
  `${st.docs.filter((d) => d.projectId === project.id).length} cards left`)

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(600)
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
