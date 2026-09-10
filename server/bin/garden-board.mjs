/**
 * Board edits from the command line: list, delete and rename cards.
 *
 * The gap this closes. Garden's whole control surface is one WebSocket message away, but only
 * `send`, `status`, `asks`, `hire` and `wire` ever got CLI wrappers. Everything else -- delete,
 * rename, move, wire removal -- existed only inside the app, so an agent asked to tidy the board
 * either wrote a bespoke script or concluded it could not act at all. The Orchestrator did BOTH on
 * 2026-08-26, in that order, and the owner's response was the reason this file exists: "can u use
 * those tools instead of constantly making scripts for board edits".
 *
 * Why this goes through session.delete and never through SQL. Deleting a row leaves the board
 * rendering a card that no longer exists. `session.delete` kills the pty, removes wires with a
 * missing end, deletes the card's work rows, broadcasts `session.removed` so every open board
 * updates live, and re-announces the card ceiling so a refusal the owner just saw stops being true.
 *
 *   node garden-board.mjs --list [--project <id>] [--kind subagent|session]
 *   node garden-board.mjs --reap [--project <id>]            what WOULD go, and nothing else
 *   node garden-board.mjs --reap [--project <id>] --yes      actually delete them
 *   node garden-board.mjs --delete <id> --yes
 *   node garden-board.mjs --rename <id> --title "New name"
 *   node garden-board.mjs --stuck [--project <id>] [--mins N]
 *   node garden-board.mjs --input <id> --data "2\r"
 *   node garden-board.mjs --tail <id> [--lines N] [--grep <re>]
 *
 * `--reap` deletes SPENT SUBAGENTS ONLY: kind='subagent', status='done', not a parent of anything.
 * It will not touch a real card, a running one, or one with children, and it says so rather than
 * skipping quietly.
 *
 * WHY `--stuck` SHOWS THE PROMPT INSTEAD OF ANSWERING IT. On 2026-08-25 a card sat on a permission
 * prompt for two and a half hours holding six ledger rows, and two others sat idle for hours after
 * DELIVERING because nobody replied. The owner's instruction was to automate unblocking. What is
 * automated here is FINDING them and showing the actual question, read from the card's own
 * scrollback. What is NOT automated is answering, because a permission prompt can be asking to
 * delete, overwrite or push, and a loop that always presses yes is the fastest way to lose the
 * owner's work. `--stuck` surfaces; a human or the Orchestrator decides; `--input` delivers.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const Database = require('better-sqlite3')

const PORT = Number(process.env.GARDEN_PORT) || 5178
const DATA_DIR = process.env.GARDEN_HOME || join(homedir(), '.garden')
const DB_PATH = process.env.GARDEN_DB || join(DATA_DIR, 'garden.db')

const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const arg = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (!argv.length || has('help')) {
  console.log(`
  node garden-board.mjs --list [--project <id>] [--kind subagent|session]
  node garden-board.mjs --reap [--project <id>]         dry run: names what would go
  node garden-board.mjs --reap [--project <id>] --yes   delete them
  node garden-board.mjs --delete <id> --yes
  node garden-board.mjs --rename <id> --title "New name"

  --reap takes SPENT SUBAGENTS ONLY: kind='subagent', status='done', childless.
  It never touches a real card, a running one, or a parent.
`)
  process.exit(0)
}

/** Read-only throughout. Nothing here writes to the database; the server owns that. */
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const project = arg('project')
const projectClause = project ? 'AND projectId = ?' : ''
const projectArgs = project ? [project] : []

/** Cards that are parents. A delete cascades to children, so a parent is never reaped. */
const parentIds = new Set(
  db
    .prepare('SELECT DISTINCT parentId FROM sessions WHERE parentId IS NOT NULL AND closedAt IS NULL')
    .all()
    .map((r) => r.parentId),
)

function rows(kind) {
  const kindClause = kind ? 'AND kind = ?' : ''
  return db
    .prepare(
      `SELECT id, title, kind, status, projectId, tokensUsed
         FROM sessions
        WHERE closedAt IS NULL ${kindClause} ${projectClause}
        ORDER BY kind, title`,
    )
    .all(...(kind ? [kind] : []), ...projectArgs)
}

/*
 * The one column the owner actually asked for, 2026-08-26: "i cant tell if they are stuck or off
 * or idle intentionally."
 *
 * `status` alone cannot answer that, because Garden's statuses describe the CONVERSATION and the
 * question is about the PROCESS. The two come apart constantly: a card reading `done` or `failed`
 * usually has no process at all and is sitting on the CLI's `claude --resume <id>` screen, which
 * looks exactly like a prompt waiting to be answered and is nothing of the kind. It is the last
 * thing the process painted on its way out.
 *
 * So the rule is: a card with no pid is OFF, whatever its status says, and it cannot be stuck
 * because there is nothing running to be stuck. Only a live card can be stuck, and only one in
 * `needs-input` actually is.
 */
function verdict(status, pid) {
  if (!pid) {
    if (status === 'stopped') return 'off, shut down'
    // `failed` is kept separate from `done` because it is the only off-state that means
    // something went WRONG, and it is the one worth looking at before waking the card.
    if (status === 'failed') return 'off, CRASHED'
    return 'off, finished'
  }
  if (status === 'needs-input') return 'STUCK, answer it'
  if (status === 'working') return 'working'
  if (status === 'idle') return 'idle, free for work'
  return `live (${status})`
}

if (has('list')) {
  const all = rows(arg('kind'))
  /*
   * Context and tokens are shown because the owner could not tell, from any screen, which cards
   * were close to compacting. A card at 63 percent with 630k tokens behaves nothing like one at 5
   * percent, and both read simply as "idle".
   */
  const withCtx = db
    .prepare(`SELECT id, contextUsed, tokensUsed, pid FROM sessions WHERE closedAt IS NULL`)
    .all()
  const meta = new Map(withCtx.map((r) => [r.id, r]))
  for (const r of all) {
    const m = meta.get(r.id) || {}
    const ctx = m.contextUsed ? `${Math.round(m.contextUsed * 100)}%`.padStart(4) : '   -'
    const tok = m.tokensUsed ? `${Math.round(m.tokensUsed / 1000)}k`.padStart(6) : '     -'
    const kids = parentIds.has(r.id) ? '  (is a parent)' : ''
    const say = verdict(r.status, m.pid).padEnd(19)
    console.log(
      `${r.kind.padEnd(9)} ${say} ${ctx} ${tok}  ${String(r.title).padEnd(26)} ${r.id}${kids}`,
    )
  }
  console.log(`\n${all.length} card${all.length === 1 ? '' : 's'}${project ? ` on project ${project}` : ''}.`)
  process.exit(0)
}

/** One send, one confirmation, then exit. Shared by --delete, --rename and --reap. */
async function sendAll(messages, expectRemoved) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const seen = new Set()
  await new Promise((resolve, reject) => {
    ws.on('error', (e) => reject(new Error(`cannot reach Garden on ${PORT}: ${e.message}`)))
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.t === 'session.removed' && m.sessionId) seen.add(m.sessionId)
    })
    ws.on('open', async () => {
      for (const msg of messages) {
        ws.send(JSON.stringify(msg))
        // Spaced on purpose: each delete kills a pty, tears down wires and broadcasts to every open
        // board. Firing a batch at once is the contention that has already cost this board a revive.
        await new Promise((r) => setTimeout(r, 250))
      }
      setTimeout(() => { ws.close(); resolve() }, 3000)
    })
  })
  if (expectRemoved) console.log(`server confirmed ${seen.size} of ${expectRemoved} removed`)
  return seen.size
}

if (has('reap')) {
  const spent = rows('subagent').filter((r) => r.status === 'done' && !parentIds.has(r.id))
  const held = rows('subagent').filter((r) => r.status !== 'done' || parentIds.has(r.id))

  for (const r of held) {
    const why = r.status !== 'done' ? `status ${r.status}` : 'is a parent'
    console.log(`keeping  ${String(r.title).padEnd(26)} ${why}`)
  }
  for (const r of spent) console.log(`reap     ${String(r.title).padEnd(26)} ${r.id}`)

  if (!spent.length) { console.log('\nNothing spent to reap.'); process.exit(0) }
  if (!has('yes')) {
    console.log(`\n${spent.length} spent subagent${spent.length === 1 ? '' : 's'} would go. Re-run with --yes.`)
    console.log('Nothing was deleted.')
    process.exit(0)
  }
  const n = await sendAll(spent.map((r) => ({ t: 'session.delete', sessionId: r.id })), spent.length)
  process.exit(n === spent.length ? 0 : 2)
}

if (has('tail')) {
  /*
   * Any card's terminal, whatever its status.
   *
   * `--stuck` reads a terminal too, but it only ever considers idle / needs-input / failed cards,
   * because those are the ones that might be waiting on somebody. That filter is right for its job
   * and wrong for VERIFICATION: on 2026-08-26 a `/autocompact` was delivered to a WORKING card and
   * there was no way to see whether the card had accepted it, rejected it, or never received it.
   * A card that is working is exactly the card whose output you most want to check, and reading
   * scrollback interrupts nothing.
   *
   * `--grep` exists because a Claude terminal's scrollback is mostly spinner frames. Searching the
   * WHOLE buffer for the one line that matters beats printing a tail of animation.
   */
  const id = arg('tail')
  const row = db.prepare('SELECT id, title, status, pid FROM sessions WHERE id = ?').get(id)
  if (!row) { console.error(`no session ${id}`); process.exit(1) }
  let text = ''
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((resolve, reject) => {
    ws.on('error', (e) => reject(new Error(`cannot reach Garden on ${PORT}: ${e.message}`)))
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.t === 'session.scrollback' && m.sessionId === id) text = String(m.data ?? '')
    })
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: id }))
      setTimeout(() => { ws.close(); resolve() }, 2500)
    })
  })
  const clean = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
  const lines = clean.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  console.log(`${row.status.toUpperCase()}  ${row.title}  ${row.pid ? 'live' : 'no process'}  ${id}`)
  if (!lines.length) { console.log('  | (no live terminal; the card is not running)'); process.exit(0) }
  const grep = arg('grep')
  const shown = grep
    ? lines.filter((l) => new RegExp(grep, 'i').test(l))
    : lines.slice(-Number(arg('lines') ?? 20))
  if (!shown.length) { console.log(`  | (nothing in the buffer matching /${grep}/)`); process.exit(0) }
  for (const l of shown) console.log(`  | ${l.slice(0, 200)}`)
  process.exit(0)
}

if (has('stuck')) {
  const mins = Number(arg('mins') ?? 10)
  const now = Date.now()
  const cards = db
    .prepare(
      `SELECT id, title, status, waitingFor, statusSince, tokensUsed
         FROM sessions
        WHERE closedAt IS NULL AND kind = 'session'
          AND status IN ('needs-input','idle','failed') ${projectClause}
        ORDER BY statusSince ASC`,
    )
    .all(...projectArgs)
    .filter((r) => !r.statusSince || now - r.statusSince >= mins * 60_000)

  if (!cards.length) { console.log(`Nothing stuck longer than ${mins} min.`); process.exit(0) }

  /** The card's own terminal, so the ACTUAL question is read rather than guessed at. */
  const tails = new Map()
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((resolve, reject) => {
    ws.on('error', (e) => reject(new Error(`cannot reach Garden on ${PORT}: ${e.message}`)))
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.t === 'session.scrollback' && m.sessionId) {
        const clean = String(m.data ?? '')
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .replace(/\r/g, '')
        const lines = clean.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
        // Default 14, not 6. A permission prompt is a question plus its options plus the thing it
        // is asking about, and six lines routinely cuts off the FILE PATH, which is the one detail
        // that decides whether answering is safe.
        tails.set(m.sessionId, lines.slice(-Number(arg('lines') ?? 14)))
      }
    })
    ws.on('open', async () => {
      for (const c of cards) {
        ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: c.id }))
        await new Promise((r) => setTimeout(r, 120))
      }
      setTimeout(() => { ws.close(); resolve() }, 2500)
    })
  })

  for (const c of cards) {
    const held = c.statusSince ? Math.round((now - c.statusSince) / 60_000) : '?'
    console.log(`\n${c.status.toUpperCase()}  ${c.title}  (${held} min)  ${c.id}`)
    if (c.waitingFor) console.log(`  waiting on: ${c.waitingFor}`)
    const tail = tails.get(c.id)
    if (tail && tail.length) for (const l of tail) console.log(`  | ${l.slice(0, 150)}`)
    else console.log('  | (no live terminal; the card is not running)')
  }
  console.log(`\n${cards.length} card${cards.length === 1 ? '' : 's'} stuck. Answer one with:`)
  console.log('  node garden-board.mjs --input <id> --data "2\\r"')
  console.log('Read the prompt above before answering. Never answer one you cannot see.')
  process.exit(0)
}

if (has('input')) {
  const id = arg('input')
  const data = arg('data')
  if (typeof data !== 'string') { console.error('--input needs --data'); process.exit(1) }
  const s = db.prepare('SELECT title, status FROM sessions WHERE id = ?').get(id)
  if (!s) { console.error(`no card with id ${id}`); process.exit(1) }
  const payload = data.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  const live = db.prepare('SELECT pid FROM sessions WHERE id = ?').get(id)?.pid
  if (!live) {
    // session.input is a silent no-op on a dead pty (`if (!ptys.isLive(...)) return`), so without
    // this the tool would report "sent" for a keystroke that went nowhere.
    console.error(`"${s.title}" has no live process (pid is null). session.input would be dropped silently.`)
    console.error('Start it from the board, or send it mail, which wakes a card as it comes up.')
    process.exit(1)
  }
  console.log(`sending ${JSON.stringify(payload)} to "${s.title}" (${s.status})`)
  await sendAll([{ t: 'session.input', sessionId: id, data: payload }], 0)
  /*
   * Text and its submit are TWO writes, learned 2026-08-26 the slow way.
   * A long instruction ending in \r landed in Balance Manager's input box and sat there
   * unsubmitted for 37 minutes; the card read `idle` the whole time. A separate bare \r sent
   * afterwards submitted it and the card went to `working` immediately.
   * So: --input "<text>" to type, then --input "\r" to send.
   */
  if (!/\r$/.test(payload) || payload.length > 1) {
    console.log('If the card stays idle, send the submit separately:  --input <id> --data "\\r"')
  }
  console.log('sent. Re-run --stuck to see what it did.')
  process.exit(0)
}

if (has('start')) {
  const id = arg('start')
  const s = db.prepare('SELECT title, status, pid, claudeSessionId FROM sessions WHERE id = ?').get(id)
  if (!s) { console.error(`no card with id ${id}`); process.exit(1) }
  if (s.pid) { console.error(`"${s.title}" is already running (pid ${s.pid}).`); process.exit(1) }
  /*
   * A card that EXITED is not a card that is stuck. `done` and `stopped` both mean the process
   * ended and the terminal is showing Claude's parting "resume this session with" hint; neither is
   * a card waiting on anything. Restarting resumes rather than restarts: adapters.ts:125 builds
   * `--resume <claudeSessionId>`, and Garden has been recording that id all along, so the card
   * comes back with its conversation instead of as a stranger wearing its name.
   */
  console.log(`"${s.title}" is ${s.status} with no process.`)
  console.log(
    s.claudeSessionId
      ? `Restarting RESUMES its conversation (--resume ${String(s.claudeSessionId).slice(0, 8)}...).`
      : 'WARNING: no claudeSessionId recorded, so this starts a FRESH conversation with no memory of its work.',
  )
  if (!has('yes')) { console.log('Re-run with --yes.'); process.exit(0) }
  await sendAll([{ t: 'session.start', sessionId: id }], 0)
  console.log('start sent. It reads its inbox as it comes up, so mail it BEFORE or right after.')
  process.exit(0)
}

if (has('delete')) {
  const id = arg('delete')
  const s = db.prepare('SELECT id, title, kind, status FROM sessions WHERE id = ?').get(id)
  if (!s) { console.error(`no card with id ${id}`); process.exit(1) }
  const kids = db.prepare('SELECT COUNT(*) n FROM sessions WHERE parentId = ? AND closedAt IS NULL').get(id).n
  console.log(`${s.kind} ${s.status} "${s.title}"${kids ? `  AND ${kids} child card${kids === 1 ? '' : 's'}` : ''}`)
  if (!has('yes')) { console.log('Re-run with --yes. Nothing was deleted.'); process.exit(0) }
  await sendAll([{ t: 'session.delete', sessionId: id }], 1)
  process.exit(0)
}

if (has('rename')) {
  const id = arg('rename')
  const title = arg('title')
  if (!title) { console.error('--rename needs --title'); process.exit(1) }
  const s = db.prepare('SELECT title FROM sessions WHERE id = ?').get(id)
  if (!s) { console.error(`no card with id ${id}`); process.exit(1) }
  console.log(`"${s.title}" -> "${title}"`)
  await sendAll([{ t: 'session.rename', sessionId: id, title }], 0)
  process.exit(0)
}

console.error('nothing to do; try --help')
process.exit(1)
