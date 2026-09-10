/**
 * History stays bounded no matter how long a card runs.
 *
 * Before this, `writeHistory` (server/src/history.ts) wrote one file per turn and rewrote every
 * file on every `history.open`, forever: `scripts/_prune-history.mjs` records one card producing
 * 59 flat files in a single day, most of them turns that wrote nothing (harness wake-ups, task
 * notifications, one-line replies, pasted error text). This drives a session through more turns
 * than the recent-page window keeps, a mix of turns that did real work and turns that did nothing,
 * and checks `history.open` against the files it actually wrote on disk rather than against what
 * the server merely claims. Runs against its own server, own port, own workspace (see
 * scripts/lib/instance.mjs), so it cannot touch the owner's live board.
 *
 * RECENT_PAGES in history.ts is 20; the exact figures below (20 pages, 30 real turns, etc.) are
 * chosen to sit either side of that bound on purpose, so this test would need updating alongside
 * a deliberate change to that constant, and would fail loudly against an accidental one.
 */
import WebSocket from 'ws'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const PORT = garden.port

/** Posts one hook payload exactly like a real hook shim would, with an explicit timestamp so the
 * turns this test generates land in a known, monotonic order regardless of how fast they post. */
async function postHook(gardenSessionId, event, ts) {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId, receivedAt: ts, event }),
  })
  if (!res.ok) throw new Error(`hook post failed: ${res.status}`)
}

let clock = Date.now() - 60 * 60 * 1000
const tick = () => (clock += 1000)

/** A turn with no substance: a harness wake-up, a notification, a one-line reply. No tool call. */
async function noiseTurn(sessionId, marker) {
  const promptId = `noise-${marker}`
  await postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt: `NOISE ${marker}: read your inbox` }, tick())
  await postHook(sessionId, { hook_event_name: 'Stop', prompt_id: promptId }, tick())
}

/** A turn that actually wrote a file. */
async function realTurn(sessionId, marker) {
  const promptId = `real-${marker}`
  await postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt: `REAL ${marker}: change something` }, tick())
  await postHook(
    sessionId,
    { hook_event_name: 'PostToolUse', prompt_id: promptId, tool_name: 'Write', tool_input: { file_path: `C:/scratch/${marker}.txt` } },
    tick(),
  )
  await postHook(sessionId, { hook_event_name: 'Stop', prompt_id: promptId }, tick())
}

const dir = mkdtempSync(join(tmpdir(), 'garden-history-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], docs: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'history.groups') st.groups = m.groups
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'error') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await garden.stop()
  process.exit(1)
}

ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Busy Card', start: false }))
await sleep(700)
const session = st.sessions.find((s) => s.title === 'Busy Card')
check('the card exists', !!session)
if (!session) {
  await garden.stop()
  process.exit(1)
}

/*
 * Opening history is two steps now, and this helper is both of them.
 *
 * A bare `history.open` answers with the days a card has and draws nothing; a day is unfolded by
 * asking for it by name (the `history.open` case in server/src/index.ts). That changed because the
 * old behaviour put every turn a card had ever taken on the board at once, which on a busy card is
 * dozens of cards arriving together. This file asked once with no day and then looked for files on
 * disk, so it found none and died on a missing directory, which reads exactly like history being
 * broken rather than like an arrow that now asks first.
 */
const openHistory = async (sessionId) => {
  st.groups = []
  ws.send(JSON.stringify({ t: 'history.open', sessionId }))
  await sleep(800)
  for (const g of st.groups ?? []) {
    if (!g.group || g.group === 'conversation' || g.group === 'reports') continue
    ws.send(JSON.stringify({ t: 'history.open', sessionId, group: g.group }))
    await sleep(700)
  }
}

const historyDir = join(garden.home, 'history', session.id)
const list = () => readdirSync(historyDir)
const pagesOf = (files) => files.filter((f) => /^\d{3}-/.test(f))

// --- drive the card through more turns than the recent-page window keeps ---
//
// 15 turns with no substance, then 30 that wrote a file, oldest to newest. Pre-fix this alone
// leaves 45 files on disk, one per turn, rewritten in full on every open.
for (let i = 1; i <= 15; i++) await noiseTurn(session.id, `n${String(i).padStart(2, '0')}`)
for (let i = 1; i <= 30; i++) await realTurn(session.id, `r${String(i).padStart(2, '0')}`)

await openHistory(session.id)

const files1 = list()
const pages1 = pagesOf(files1)

// Pre-fix: 45 turns produced 45 files, so this failed outright. Post-fix it should top out at the
// 20-page window plus one archive file.
check('many turns did not produce many files', files1.length < 25, `45 turns produced ${files1.length} files: ${files1.join(', ')}`)
// Pre-fix: there was no cap at all, so the page count tracked the turn count one-for-one (45, not
// 20) and kept growing with every additional turn.
check('individual pages are capped rather than growing with turn count', pages1.length === 20, `${pages1.length} page files`)
// Pre-fix: no archive concept existed, so this file was never written.
check('an archive exists for everything older than the window', files1.includes('_archive.md'))

const archive1 = readFileSync(join(historyDir, '_archive.md'), 'utf8')
// Catches an archive that only accounts for turns it rolled up and silently drops the ones that
// never got a page at all, which would make the noise turns vanish with no record anywhere.
check('the archive counts the no-substance turns rather than dropping them', archive1.includes('15 more'), archive1.slice(0, 200))
// Catches an archive that exists but does not actually say what it rolled up.
check('and says how many real turns it rolled up', /10 more did real work/.test(archive1), archive1.slice(0, 200))

// The 10 oldest real turns (r01..r10) aged out of the 20-turn window; r01 is one of them.
const r01AsPage = pages1.some((f) => readFileSync(join(historyDir, f), 'utf8').includes('REAL r01'))
// Catches an archive being added without ever removing the individual file it replaced, which
// would defeat the whole bound: the file count keeps growing, just with an extra archive on top.
check('a turn beyond the window is not still kept as its own page', !r01AsPage)
// Catches a turn being dropped outright instead of rolled up: SQLite still has the record, but the
// projection would be claiming it never happened.
check('and it is not lost, only rolled up', archive1.includes('REAL r01'))
const r30AsPage = pages1.some((f) => readFileSync(join(historyDir, f), 'utf8').includes('REAL r30'))
// Catches the window running backwards (archiving the newest turns instead of the oldest ones),
// which would leave the owner unable to see what a card just did.
check('the newest turn still gets its own page', r30AsPage)

// --- reopening an idle card must not rewrite pages that have not changed ---

const mtimesBefore = Object.fromEntries(pages1.map((f) => [f, statSync(join(historyDir, f)).mtimeMs]))
const archiveMtimeBefore = statSync(join(historyDir, '_archive.md')).mtimeMs

await sleep(1100)
await openHistory(session.id)

// Pre-fix: writeFileSync ran unconditionally for every record on every open, so every page's
// mtime would move even though nothing about the turn it describes had changed.
const noneRewritten = pages1.every((f) => statSync(join(historyDir, f)).mtimeMs === mtimesBefore[f])
check('reopening with nothing new does not rewrite any page', noneRewritten)
check('or the archive', statSync(join(historyDir, '_archive.md')).mtimeMs === archiveMtimeBefore)

// --- one more real turn: exactly the turn at the edge of the window should move ---

await realTurn(session.id, 'r31')
await openHistory(session.id)

const pages2 = pagesOf(list())
// Pre-fix: the page count simply grew with the turn count (46 instead of staying at 20).
check('the page count stays capped after another turn arrives', pages2.length === 20, `${pages2.length} page files`)
// r11 was the oldest page in the 20-turn window before r31 arrived, so it is the one that should
// age out now. Catches the window not being maintained incrementally: a stale page left behind
// once the archive boundary moves is exactly the unbounded growth this was built to stop.
const r11StillPage = pages2.some((f) => readFileSync(join(historyDir, f), 'utf8').includes('REAL r11'))
check('the turn that just aged out of the window loses its individual file', !r11StillPage)
const archive2 = readFileSync(join(historyDir, '_archive.md'), 'utf8')
check('and is folded into the archive instead of disappearing', archive2.includes('REAL r11'))

// --- the projection is genuinely rebuildable from the database, not merely claimed to be ---

rmSync(historyDir, { recursive: true, force: true })
check('the whole history directory can be deleted', !existsSync(historyDir))
await openHistory(session.id)

// Catches two different pre-fix-shaped bugs at once: a write-if-changed implementation that
// assumes the old file is always there and throws on a missing one (readFileSync with no catch),
// and a rebuild that only reconstructs from whatever files happened to survive rather than from
// records and events, which would come back with a different, smaller set of turns than before.
const rebuiltPages = pagesOf(list())
check('deleting it and reopening history rebuilds the same bound', rebuiltPages.length === 20, `${rebuiltPages.length} pages`)
check('and the archive comes back too', list().includes('_archive.md'))
const rebuiltArchive = readFileSync(join(historyDir, '_archive.md'), 'utf8')
check(
  'naming the same rolled-up turns as before deletion',
  rebuiltArchive.includes('REAL r01') && rebuiltArchive.includes('REAL r11'),
)

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
