/**
 * A turn that finished a task earns a page. A turn that only got mail does not.
 *
 * The owner's rule, stated on 2026-09-09: history "tracks meaningful code changes/tasks completed,
 * not mail messages, not notifications. its meant to show meaningful work the card did". The first
 * half of that had a hole in it. A page was earned by writing a file, so a card that spent a turn
 * checking somebody's work, answered, and moved a task to done left no trace at all: the one thing
 * it did was the one thing history could not see.
 *
 * Both halves are asserted here and the second is the one that matters, because a rule that lets
 * more through is only worth having if it still keeps mail out. The mail-only turn in this file is
 * a real wake-up: it is woken by a delivered message, it reads a file, and it writes nothing. That
 * is the exact shape of the twenty consecutive pages the owner objected to.
 *
 * Nothing here claims a completion on an agent's word. The task is moved by posting to `/mail`, the
 * same door `garden-send.mjs` posts to, and every assertion is made against the page Garden wrote
 * and the row SQLite holds afterwards.
 *
 * Its own instance, its own port, its own home. Never the owner's board. The home directory is made
 * here rather than by `startInstance` because the last section restarts onto the same workspace, to
 * check what a row written before this column existed does to a history write; the script that
 * passes the directory owns cleaning it up.
 *
 * Needs `npm run build` first: the instance launches the built server, not the TypeScript.
 */
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + String(d).replace(/\s+/g, ' ').slice(0, 160) : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'garden-finished-home-'))
const dir = mkdtempSync(join(tmpdir(), 'garden-finished-proj-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

let garden = await startInstance({ home })
let PORT = garden.port

/** The owner key, read off disk, so this connection is still the owner once enforcement is on. */
const keyFile = join(home, 'owner.key')
let ownerKey = ''
for (let i = 0; i < 40 && !ownerKey; i++) {
  try {
    ownerKey = readFileSync(keyFile, 'utf8').trim()
  } catch {
    await sleep(100)
  }
}

const st = { projects: [], sessions: [], tasks: [], groups: [], answers: [] }
let ws

async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, tasks: m.tasks ?? [] })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'history.groups') st.groups = m.groups
    else if (m.t === 'task.state') st.tasks = m.tasks
    else if (m.t === 'task.updated') st.tasks = [...st.tasks.filter((t) => t.id !== m.task.id), m.task]
    else st.answers.push(m)
  })
  await new Promise((r) => socket.on('open', r))
  socket.send(JSON.stringify({ t: 'hello', key: ownerKey }))
  await sleep(700)
  return socket
}

const post = (path, body, token) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: (await r.text()).trim() }))

let clock = Date.now() - 60 * 60 * 1000
const tick = () => (clock += 1000)

/** A hook event, through the same door the card's own hook posts to. */
const hook = (sessionId, event) => post('/hook', { gardenSessionId: sessionId, receivedAt: tick(), event })

async function finish(code) {
  try {
    await garden.stop()
  } catch {
    // Already down: the exit code below is still the answer.
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  process.exit(code)
}

ws = await connect()
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  the scratch project was not added')
  await finish(1)
}

const suffix = Date.now().toString().slice(-5)
const NAMES = [
  { title: `Boss ${suffix}`, roleClass: 'manager' },
  { title: `Worker ${suffix}`, roleClass: 'worker' },
]
for (const spec of NAMES) {
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: spec.title,
    roleClass: spec.roleClass,
    start: false,
  }))
  await sleep(1400)
}
const boss = st.sessions.find((s) => s.title === NAMES[0].title)
const worker = st.sessions.find((s) => s.title === NAMES[1].title)
check('the two cards exist', !!boss && !!worker)
if (!boss || !worker) await finish(1)

/*
 * Both directions. The work goes down one wire and the done comes back up, and mail that no wire
 * permits is refused before ownership is ever consulted, so without these the interesting
 * assertions below would pass for the wrong reason.
 */
for (const [a, b] of [[boss, worker], [worker, boss]]) {
  ws.send(JSON.stringify({ t: 'wire.create', projectId: project.id, sourceId: a.id, targetId: b.id }))
  await sleep(400)
}

/** A card's own token, which is what proves it is that card rather than claiming to be. */
const tokens = new Map()
for (const c of [boss, worker]) {
  st.answers.length = 0
  ws.send(JSON.stringify({ t: 'session.token', sessionId: c.id }))
  await sleep(400)
  const answer = st.answers.find((m) => m.t === 'session.token' && m.sessionId === c.id)
  if (answer) tokens.set(c.id, answer.token)
}
check('both cards have a token', tokens.size === 2 && new Set(tokens.values()).size === 2)

/*
 * Enforcement on, because shadow allows a message whether or not the guard agreed with it. The
 * transition this whole file is about must be one the ownership rules actually permitted, not one
 * that went through because nothing was stopping anything.
 */
st.answers.length = 0
ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
await sleep(400)
const limits = st.answers.find((m) => m.t === 'limits')?.limits
ws.send(JSON.stringify({ t: 'limits.set', projectId: project.id, limits: { ...limits, taskAuthority: 'enforce' } }))
await sleep(600)

const TASK = `T-page-${suffix}`
const opened = await post('/task', {
  op: 'create',
  task: { id: TASK, ownerId: worker.title, acceptance: 'the loader reads a second column' },
}, tokens.get(boss.id))
check('a dispatcher opens a task the worker owns', opened.status === 200, `${opened.status} ${opened.text.slice(0, 120)}`)

const given = await post('/mail', {
  from: boss.id,
  to: worker.title,
  kind: 'work',
  taskId: TASK,
  text: 'take the loader change',
}, tokens.get(boss.id))
check('the work reaches the card that owns it', given.status === 200, `${given.status} ${given.text.slice(0, 120)}`)

// ---------------------------------------------------------------------------
// The turn that finished the task and wrote nothing
// ---------------------------------------------------------------------------

/*
 * A wake-up, word for word the shape the owner complained about, and then real work inside it. The
 * ask is deliberately the postman's sentence rather than a description of anything done, because
 * that is what a card is actually handed when mail arrives.
 */
const WAKE = 'A message arrived on one of your wires. Read your INBOX.md now.'
await hook(worker.id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'finish', prompt: `${WAKE} FINISHER` })
await hook(worker.id, {
  hook_event_name: 'PostToolUse',
  prompt_id: 'finish',
  tool_name: 'Read',
  tool_input: { file_path: 'C:/scratch/INBOX.md' },
})

const reported = await post('/mail', {
  from: worker.id,
  to: boss.title,
  kind: 'done',
  taskId: TASK,
  text: 'checked it against the acceptance and it holds',
}, tokens.get(worker.id))
check('the owner reports done', reported.status === 200, `${reported.status} ${reported.text.slice(0, 120)}`)

await hook(worker.id, { hook_event_name: 'Stop', prompt_id: 'finish' })
await sleep(400)

ws.send(JSON.stringify({ t: 'task.list', projectId: project.id }))
await sleep(500)
check('and the task really is done', st.tasks.find((t) => t.id === TASK)?.state === 'done',
  st.tasks.find((t) => t.id === TASK)?.state)

// ---------------------------------------------------------------------------
// The turn that only got mail
// ---------------------------------------------------------------------------

/*
 * Delivered mail, a wake-up, a read, and nothing else. No file written, no task moved. This is the
 * turn that must stay out of the history directory however generous the rule for the one above
 * gets, and it is the one the owner opened twenty of.
 */
const chat = await post('/mail', {
  from: boss.id,
  to: worker.title,
  kind: 'question',
  text: 'while you are there, how did the acceptance read to you',
}, tokens.get(boss.id))
check('a message with no task id is delivered', chat.status === 200, `${chat.status} ${chat.text.slice(0, 120)}`)

await hook(worker.id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'mailonly', prompt: `${WAKE} MAILONLY` })
await hook(worker.id, {
  hook_event_name: 'PostToolUse',
  prompt_id: 'mailonly',
  tool_name: 'Read',
  tool_input: { file_path: 'C:/scratch/INBOX.md' },
})
await hook(worker.id, { hook_event_name: 'Stop', prompt_id: 'mailonly' })
await sleep(400)

// ---------------------------------------------------------------------------
// The turn that was woken by mail and then wrote something
// ---------------------------------------------------------------------------

/*
 * The third shape a wake-up can take, and the one that shows the title rule falling through. No
 * task finished, one file written, and the ask is still the postman's sentence. Before this the
 * page was headed with that sentence and the file was only visible inside it.
 */
await hook(worker.id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'writer', prompt: `${WAKE} WRITER` })
await hook(worker.id, {
  hook_event_name: 'PostToolUse',
  prompt_id: 'writer',
  tool_name: 'Write',
  tool_input: { file_path: 'C:/scratch/loader.ts' },
})
await hook(worker.id, { hook_event_name: 'Stop', prompt_id: 'writer' })
await sleep(400)

// ---------------------------------------------------------------------------
// What Garden wrote
// ---------------------------------------------------------------------------

/** Ask for the history web, then open every group, which is what puts the pages on disk. */
async function writePages() {
  st.groups = []
  ws.send(JSON.stringify({ t: 'history.open', sessionId: worker.id }))
  await sleep(900)
  for (const g of st.groups ?? []) {
    if (!g.group || g.group === 'conversation' || g.group === 'reports') continue
    ws.send(JSON.stringify({ t: 'history.open', sessionId: worker.id, group: g.group }))
    await sleep(700)
  }
}
await writePages()

const historyDir = join(home, 'history', worker.id)
const pageNames = readdirSync(historyDir).filter((f) => /^\d{3}-/.test(f))
const pages = pageNames.map((f) => ({ name: f, text: readFileSync(join(historyDir, f), 'utf8') }))

const finisher = pages.find((p) => p.text.includes('FINISHER'))
check('a turn that finished a task and wrote no file gets a page', !!finisher, pageNames.join(', '))
if (finisher) {
  check('and the page names the task', finisher.text.includes(TASK), finisher.text.slice(0, 200))
  // It really did write nothing: if a file had crept into this turn the page above would have been
  // earned the old way and this test would be proving nothing new.
  check('the page it got is the no-writes kind', finisher.text.includes('No writes were observed'),
    finisher.text.slice(0, 300))
  check('and it is still short', finisher.text.length < 1200, `${finisher.text.length} bytes`)

  /*
   * The title, which is the half of this that the owner actually reads. The heading has to be the
   * work; the ask stays quoted further down, so nothing is lost by taking it off the top.
   */
  const heading = finisher.text.split('\n')[0]
  check('the page is titled by the task it finished', heading === `# Finished ${TASK}`, heading)
  check('and not by the sentence that woke it', !heading.includes('message arrived'), heading)
  check('and its file name says the same thing',
    finisher.name.includes(TASK.toLowerCase()), finisher.name)
}

const writer = pages.find((p) => p.text.includes('WRITER'))
check('a mail-woken turn that wrote a file gets a page', !!writer, pageNames.join(', '))
if (writer) {
  const heading = writer.text.split('\n')[0]
  check('titled by the file it changed', heading === '# Changed loader.ts', heading)
  check('and not by the sentence that woke it either', !heading.includes('message arrived'), heading)
  check('with a file name to match', writer.name.includes('changed-loader-ts'), writer.name)
  // The full path is still on the page: the title is the short form, not a replacement for it.
  check('and the path itself is still in the page', writer.text.includes('- C:/scratch/loader.ts'),
    writer.text.slice(0, 300))
}

check(
  'a turn that only received mail gets none',
  !pages.some((p) => p.text.includes('MAILONLY')),
  pageNames.join(', '),
)

// ---------------------------------------------------------------------------
// The archive, once those turns have aged out of the window
// ---------------------------------------------------------------------------

/*
 * Twenty more turns that each wrote a file, which pushes the two oldest substantive turns out of the
 * recent window and into `_archive.md`. That is the only way to see an archive entry at all, and the
 * entry for the turn that finished a task is what this section is about: it used to read
 * "(no files written)" and say nothing whatever about the task, which was true and was also the
 * wrong half of the story.
 */
for (let i = 1; i <= 20; i++) {
  const id = `fill${String(i).padStart(2, '0')}`
  await hook(worker.id, { hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: `FILLER ${id}` })
  await hook(worker.id, {
    hook_event_name: 'PostToolUse',
    prompt_id: id,
    tool_name: 'Write',
    tool_input: { file_path: `C:/scratch/${id}.ts` },
  })
  await hook(worker.id, { hook_event_name: 'Stop', prompt_id: id })
}
await sleep(400)
await writePages()

const archive = readFileSync(join(historyDir, '_archive.md'), 'utf8')
const entry = archive.split('### ').find((e) => e.includes(TASK)) ?? ''
check('the finished task is now in the archive rather than on a page', !!entry, archive.slice(0, 300))
check('and its entry says the task finished', entry.includes(`- finished ${TASK}`), entry.slice(0, 300))
// The sentence this order was written to remove: true on its own and misleading as the whole story.
check('and no longer claims no files as though that were all there was to say',
  !entry.includes('(no files written)'), entry.slice(0, 300))
check('the entry is headed by the work, not by the wake-up',
  entry.startsWith(`001. Finished ${TASK}`), entry.split('\n')[0])
// The ask is not thrown away by that: an archived turn is often the last place it survives.
check('and the ask it was given is still on the entry', entry.includes('A message arrived'),
  entry.split('\n')[1])

/*
 * The noise sentence. It counted turns that "made no tool calls and touched no files", and a tool
 * call stopped being part of the rule at revision 3: the MAILONLY turn counted here made one.
 */
const noise = archive.split('\n').find((l) => /more (wrote|made)/.test(l)) ?? ''
check('the noise sentence describes what is actually counted',
  noise.includes('wrote no file and finished no task'), noise)
check('and no longer talks about tool calls', !/tool call/i.test(archive), noise)
check('and it is counting the mail-only turn', /^1 more /.test(noise), noise)

// ---------------------------------------------------------------------------
// The row underneath, and a database from before the column existed
// ---------------------------------------------------------------------------

await garden.stop()
await sleep(500)

const dbPath = join(home, 'garden.db')
let db = new Database(dbPath)
const rows = db.prepare('SELECT promptId, filesTouched, tasksCompleted FROM work WHERE sessionId = ?')
  .all(worker.id)
const finishRow = rows.find((r) => r.promptId === 'finish')
const mailRow = rows.find((r) => r.promptId === 'mailonly')
check('the finishing turn stored the task id', JSON.parse(finishRow?.tasksCompleted ?? '[]').includes(TASK),
  JSON.stringify(finishRow))
check('and it stored no files, so the page came from the task alone',
  JSON.parse(finishRow?.filesTouched ?? '[]').length === 0, JSON.stringify(finishRow?.filesTouched))
check('the mail-only turn stored no task', JSON.parse(mailRow?.tasksCompleted ?? '[]').length === 0,
  JSON.stringify(mailRow))

/*
 * The owner's own database, as this build will first find it: the `work` table without the column.
 *
 * Taking it away and starting again is the real migration path rather than a stand-in for it, and
 * it is the only way to see what a row written by the previous build does to a history write. A row
 * inserted here the way that build inserted one carries no value at all, and it has to come back as
 * an empty list on the other side, never as a crash and never as a null something later counts.
 */
db.exec('ALTER TABLE work DROP COLUMN tasksCompleted')
db.prepare(`
  INSERT INTO work (id,sessionId,promptId,origin,parentId,ask,startedAt,endedAt,filesTouched,toolCalls)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`).run('legacy-row', worker.id, 'legacy', 'owner', null, 'LEGACY: written by the build before this one',
  clock - 5000, clock - 4000, JSON.stringify(['C:/scratch/old.ts']), 3)
db.close()

garden = await startInstance({ home })
PORT = garden.port
ws = await connect()
await sleep(600)
await writePages()

const after = readdirSync(historyDir).filter((f) => /^\d{3}-/.test(f))
  .map((f) => readFileSync(join(historyDir, f), 'utf8'))
check('a turn from before the column still gets its page, and writing it does not throw',
  after.some((t) => t.includes('LEGACY')), `${after.length} pages`)
check('and that page is titled from what it wrote', after.some((t) => t.startsWith('# Changed old.ts')),
  after.map((t) => t.split('\n')[0]).join(' | ').slice(0, 200))
check('the mail-only turn still earns none', !after.some((t) => t.includes('MAILONLY')), `${after.length} pages`)

/*
 * And the negative that proves the positive was not luck. Dropping the column destroyed the only
 * fact the finishing turn had, so everything that fact earned it goes with it: its archive entry
 * names no task, and the turn itself drops out of the rolled-up work and into the count of turns
 * that did nothing. If it kept either, something other than the completed task was holding it up
 * and the first half of this file would be proving nothing.
 */
const archiveAfter = readFileSync(join(historyDir, '_archive.md'), 'utf8')
check('the turn whose only fact was in that column stops being real work',
  !archiveAfter.includes(TASK), archiveAfter.slice(0, 400))
const noiseAfter = archiveAfter.split('\n').find((l) => /more wrote no file/.test(l)) ?? ''
check('and is counted with the turns that did nothing instead', /^2 more /.test(noiseAfter), noiseAfter)

db = new Database(dbPath, { readonly: true })
const migrated = db.prepare('SELECT tasksCompleted FROM work WHERE id = ?').get('legacy-row')
db.close()
check('and the migration gave that row an empty list, not a null',
  migrated?.tasksCompleted === '[]', JSON.stringify(migrated))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
await finish(failures === 0 ? 0 : 1)
