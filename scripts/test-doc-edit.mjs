/**
 * Proves a document card can be edited and written back to disk, for a file inside the project
 * and for one outside it (a profile's own settings), and that the path guard still refuses
 * anything the renderer makes up.
 *
 * On a board of its own, with a project of its own. It used to drive the board on 5178, write its
 * two scratch documents into `C:\Garden\docs` where they are tracked by git, and put a third into
 * the owner's real `~/.garden/memory`. All three now land in temporary directories that go away
 * with the instance.
 */
import WebSocket from 'ws'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A project of this run's own, and a scratch file inside it.
const projectDir = mkdtempSync(join(tmpdir(), 'garden-doc-edit-'))
writeFileSync(join(projectDir, 'CLAUDE.md'), '# scratch project for the document edit test\n')
const scratchRel = 'docs/_edit-test.md'
const scratchAbs = join(projectDir, 'docs', '_edit-test.md')
mkdirSync(join(projectDir, 'docs'), { recursive: true })
writeFileSync(scratchAbs, '# before\n', 'utf8')

/*
 * Wait for the backend rather than racing it.
 *
 * This script's whole job is to say whether the server behaves correctly, so it must never report
 * a verdict it cannot back. Connecting before the server is listening would print a screenful of
 * FAILs about saves that were never attempted, which reads exactly like the change under test
 * being broken. Refusing to start until the server answers keeps the only two outcomes "the server
 * did this" and "no server", which are different things.
 *
 * `startInstance` already waits on `/health`, so in practice the first attempt connects. This stays
 * because the two are different questions: health says the process is up, this says the socket is.
 */
async function connect(url, waitMs = 20000) {
  const deadline = Date.now() + waitMs
  for (let attempt = 1; ; attempt++) {
    const socket = new WebSocket(url)
    const opened = await new Promise((resolve) => {
      socket.once('open', () => resolve(true))
      socket.once('error', () => resolve(false))
    })
    if (opened) {
      if (attempt > 1) console.log(`(connected on attempt ${attempt})`)
      return socket
    }
    socket.terminate()
    if (Date.now() > deadline) {
      console.log(`FAIL  this run's own server is not listening on ${url} after ${waitMs / 1000}s`)
      console.log('\nNothing was tested.')
      process.exit(1)
    }
    await sleep(500)
  }
}

const garden = await startInstance()
const ws = await connect(`ws://127.0.0.1:${garden.port}/ws`)
const st = { projects: [], docs: [], errors: [], content: {}, saved: [] }
ws.on('message', (r) => {
  const m = JSON.parse(String(r))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.content') st.content[m.cardId] = m
  else if (m.t === 'error') st.errors.push(m.message)
  // A save has to answer for itself. Collected in order so each save can be judged on the
  // answers that arrived after it rather than on whatever the last one left behind.
  else if (m.t === 'doc.saved') st.saved.push(m)
})
/** The answers to the save that is about to be sent, and nothing from an earlier one. */
const answersAfter = (mark) => st.saved.slice(mark)

ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: projectDir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects[0]
if (!project) { console.log('FAIL  could not add a project'); await garden.stop(); process.exit(1) }

// Edit a file inside the project.
ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: scratchRel }))
await sleep(900)
const card = st.docs.find((d) => d.relPath === scratchRel)
check('document card opened', !!card)

ws.send(JSON.stringify({ t: 'doc.read', cardId: card.id }))
await sleep(700)
check('card read the file', st.content[card.id]?.content?.includes('# before'))

const mtimeTheCardRead = st.content[card.id]?.mtime
let mark = st.saved.length
ws.send(JSON.stringify({ t: 'doc.save', cardId: card.id, content: '# after\n\nEdited from the card.\n' }))
await sleep(900)
check('save reached the file on disk', readFileSync(scratchAbs, 'utf8').includes('# after'))

// The server must say so itself. Before this existed the write landed and nothing came back, so
// the only confirmation the owner ever saw was the interface agreeing with itself.
const ok = answersAfter(mark).find((m) => m.cardId === card.id)
check('a successful save is answered with doc.saved for that card', !!ok,
  ok ? '' : `no doc.saved arrived; ${answersAfter(mark).length} other answers did`)
check('the successful answer carries no error', !!ok && !ok.error, ok?.error ?? '')
// Not stale, and not invented: the number must be the mtime the file actually has now. A value
// read before the write, or copied from the earlier doc.read, fails here.
const onDisk = statSync(scratchAbs).mtimeMs
check('the answer carries the real post-write mtime', !!ok && Math.abs(ok.mtime - onDisk) < 2,
  `answered ${ok?.mtime}, on disk ${onDisk}`)
check('the answered mtime moved on from the one the card read',
  !!ok && ok.mtime !== mtimeTheCardRead, `card had read ${mtimeTheCardRead}`)

// Reading it back must show the new text, not a stale copy.
ws.send(JSON.stringify({ t: 'doc.read', cardId: card.id }))
await sleep(700)
check('re-reading shows the saved text', st.content[card.id]?.content?.includes('Edited from the card'))

/*
 * A save that cannot be written must say which card failed.
 *
 * Read-only on this scratch file makes the write throw EPERM. The old handler reported that as a
 * generic `error` naming no card, so a board with two editors open could not tell which one had
 * lost its text. The permission is put back below whatever happens.
 */
const textBeforeTheFailure = readFileSync(scratchAbs, 'utf8')
chmodSync(scratchAbs, 0o444)
mark = st.saved.length
const errorsBefore = st.errors.length
ws.send(JSON.stringify({ t: 'doc.save', cardId: card.id, content: '# this must not land\n' }))
await sleep(900)
chmodSync(scratchAbs, 0o666)

const refused = answersAfter(mark).find((m) => m.cardId === card.id)
check('a failed save is answered with doc.saved for that card', !!refused,
  refused ? '' : `no doc.saved arrived; ${st.errors.length - errorsBefore} generic errors did`)
check('the failed answer carries the error', !!refused?.error, refused?.error ?? 'no error field')
check('a refused write left the file alone', readFileSync(scratchAbs, 'utf8') === textBeforeTheFailure)

/*
 * Two cards open, one of them failing. The point of answering on `doc.saved` rather than with a
 * generic error is that the right card hears about it, and with a single card open that claim
 * cannot be tested at all: an answer addressed to the wrong card, an answer sent twice, and an
 * answer sent to everybody all look identical when there is only one card and one socket.
 *
 * So: a healthy card and a read-only one, saved one after the other, plus a second connection
 * watching. What each assertion below is actually defending is written against it.
 */
const scratchRelB = 'docs/_edit-test-b.md'
const scratchAbsB = join(projectDir, 'docs', '_edit-test-b.md')
writeFileSync(scratchAbsB, '# b before\n', 'utf8')

ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: scratchRelB }))
await sleep(900)
const cardB = st.docs.find((d) => d.relPath === scratchRelB)
check('a second document card opened', !!cardB)

// A connection that opens no cards and saves nothing. It must stay silent.
const observer = await connect(`ws://127.0.0.1:${garden.port}/ws`)
const observed = []
observer.on('message', (r) => {
  const m = JSON.parse(String(r))
  if (m.t === 'doc.saved') observed.push(m)
})
observer.send(JSON.stringify({ t: 'hello' }))
await sleep(600)

const bTextBefore = readFileSync(scratchAbsB, 'utf8')
chmodSync(scratchAbsB, 0o444)
mark = st.saved.length
observed.length = 0
ws.send(JSON.stringify({ t: 'doc.save', cardId: card.id, content: '# a saved cleanly\n' }))
ws.send(JSON.stringify({ t: 'doc.save', cardId: cardB.id, content: '# b must not land\n' }))
await sleep(1200)
chmodSync(scratchAbsB, 0o666)

const answers = answersAfter(mark)
const forA = answers.filter((m) => m.cardId === card.id)
const forB = answers.filter((m) => m.cardId === cardB.id)

// Catches an answer addressed to whichever card saved most recently, or to a fixed card.
check('each card got its own answer', forA.length === 1 && forB.length === 1,
  `${forA.length} for the card that saved, ${forB.length} for the card that failed`)
// Catches the failure leaking onto the card that saved perfectly well, which would light a
// "not saved" badge over a file that is on disk.
check('the failure did not bleed onto the healthy card', forA[0] && !forA[0].error,
  forA[0]?.error ?? '')
check('the failure was attached to the card that actually failed', !!forB[0]?.error,
  forB[0]?.error ?? 'no error field')
// Catches an answer sent for a card nobody saved.
check('no card was answered that did not save', answers.length === 2,
  `${answers.length} answers for 2 saves: ${answers.map((m) => m.cardId).join(', ')}`)
check('the healthy save reached disk and the failed one did not',
  readFileSync(scratchAbs, 'utf8').includes('# a saved cleanly') &&
    readFileSync(scratchAbsB, 'utf8') === bTextBefore)
/*
 * The answer goes to the connection that asked, not to every connection. This one pins a design
 * decision rather than a defect: the patched handler uses `send(ws, ...)` like `doc.read` does,
 * so a second window holding the same card open learns nothing. If Garden ever decides both
 * windows should update, this is the assertion to delete, deliberately and with that reason.
 */
check('a connection that saved nothing was told nothing', observed.length === 0,
  `${observed.length} answers reached a connection that never saved`)

observer.close()
ws.send(JSON.stringify({ t: 'doc.close', cardId: cardB.id }))
await sleep(400)

// A file outside the project, reached only through a card the server itself created.
const outside = join(garden.home, 'memory', '_edit-test.md')
mkdirSync(join(garden.home, 'memory'), { recursive: true })
writeFileSync(outside, 'outside before\n', 'utf8')

// The renderer must not be able to name an absolute path itself.
const before = st.errors.length
ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: outside }))
await sleep(800)
const smuggled = st.docs.find((d) => d.relPath === outside)
check('an absolute path from the renderer is refused', !smuggled && st.errors.length > before,
  st.errors[st.errors.length - 1] ?? 'no error raised')
check('the outside file was not touched', readFileSync(outside, 'utf8') === 'outside before\n')

ws.send(JSON.stringify({ t: 'doc.close', cardId: card.id }))
await sleep(400)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
