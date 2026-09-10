/**
 * A session's history, written out as one readable file per turn.
 *
 * The owner asked for this specifically: each piece of work documented as its own file, easy to
 * reference and review later, saying what was asked, whether he asked it or another agent
 * dispatched it, and what came of it. That last distinction is the one he could never get before,
 * because a card that had done work never said whose idea the work was.
 *
 * Every line in these files comes from a hook payload. There is no summary, no interpretation of
 * what the agent was trying to do, and no judgement about whether it succeeded. A file says what
 * was asked and which files were written, and stops there.
 *
 * The `work` table in SQLite is the source of truth; everything below is a bounded, regenerable
 * projection of it, not a second copy of the record. That distinction started mattering once one
 * card produced 59 flat files in a single day, most of them turns that wrote nothing: harness
 * wake-ups telling it to read its inbox, task notifications, one-line replies, error text pasted
 * back into a terminal (see `scripts/_prune-history.mjs`, written to clean this up by hand before
 * the projection itself was bounded). Two rules keep the file count from tracking the turn count:
 * a turn that touched no files and made no tool calls never gets its own page (unless it is a
 * dispatch to another card, whose attribution is recorded nowhere else, see `hasSubstance`), and
 * of the turns that did something, only the most recent ones do; everything older rolls into one
 * archive file per card. Nothing is ever deleted from the `work` table to make this true. Collapsing a page
 * only ever changes what is projected onto disk, and `writeHistory` recomputes that projection
 * from `records` and `events` on every call, so deleting a card's whole history directory and
 * reopening its history web reconstructs it exactly. That is the rebuild path: not a separate
 * tool, just the fact that nothing here is read back from disk except to skip an unchanged write.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, TerminalSession, WorkRecord } from '@garden/shared'
import { DATA_DIR } from './store.js'
import type { ChatTurn } from './transcript.js'

export function historyDirFor(sessionId: string): string {
  const dir = join(DATA_DIR, 'history', sessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function duration(rec: WorkRecord): string {
  if (!rec.endedAt) return 'still running'
  const secs = Math.round((rec.endedAt - rec.startedAt) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** A short, sortable, filesystem-safe name, so the newest turn reads as the newest file. */
export function fileNameFor(rec: WorkRecord, index: number): string {
  const first = rec.ask.split('\n')[0] ?? ''
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `${String(index).padStart(3, '0')}-${slug || 'turn'}.md`
}

/**
 * How many of a card's most recent turns-that-did-something keep their own file.
 *
 * The owner reads history to answer "what has this card actually been doing", which in practice
 * means the last handful of turns, not its whole life. Twenty is comfortably more than the
 * six-per-row grid `history.open` lays out shows in two rows without scrolling, and it is a
 * constant rather than something that needs tuning per card, because the point of a bound is that
 * it does not need attention.
 */
const RECENT_PAGES = 20

/** Everything older than the recent window, plus a count of the turns that never got a page. */
const ARCHIVE_NAME = '_archive.md'

/**
 * Whether a turn earns its own page.
 *
 * A turn that wrote no file is a harness wake-up, a task notification, a one-line reply, pasted
 * error text, or a turn that only read and searched. Read straight off the record here rather than
 * off rendered text, since the record is what is available at write time. Deliberately not a
 * judgement call about whether a turn was interesting.
 *
 * Making a tool call used to count as well, and that is the clause that broke the bound. A wake-up
 * telling a card to read its inbox makes exactly one tool call, so it passed, and on 2026-09-08 the
 * owner's own card carried twenty consecutive pages titled "A message just arrived on one of your
 * wires", each of them ending "No writes were observed during this turn." He said what history is
 * for in the same breath: historical changes to the canon and the codebase. Reading is activity, and
 * a page is a change.
 *
 * A dispatched turn is the one exception, kept regardless of what it touched. `origin === 'agent'`
 * means a separate card exists for it, a subagent or a teammate, and that card typically carries
 * exactly one such record for its whole run. Who dispatched it is information nothing else
 * records, and it is the specific thing the owner asked for: "whether he asked it or another
 * agent dispatched it". Folding that into the anonymous no-substance count would erase the
 * attribution the record exists to hold, even though the dispatch itself plainly happened. This
 * does not reopen the growth problem the bound exists for: a dispatch record is created once per
 * spawn, not once per idle wake-up, and it still ages into the archive past RECENT_PAGES like any
 * other turn, with its attribution preserved there rather than dropped.
 */
/**
 * Whether a turn is worth a page of its own, and therefore worth counting.
 *
 * Exported because the history pills count what they will open. Counting every record instead put
 * "Today 3" on a pill that opened one card, since a turn that called no tool and touched no file is
 * dropped here as noise. Two definitions of what a turn is is how that happens; there is one.
 */
export function hasSubstance(rec: WorkRecord): boolean {
  return rec.origin === 'agent' || rec.filesTouched.length > 0
}

/**
 * Writes only when the content actually differs from what is already on disk.
 *
 * `history.open` recomputes every page from the database on every call, which used to mean every
 * file was rewritten every time regardless of whether anything in it had changed. A card opened
 * and closed a dozen times a day was a dozen needless writes per turn, on top of the turn count
 * itself. Comparing first is cheap next to a filesystem write and makes reopening an idle card's
 * history free.
 */
function writeIfChanged(abs: string, content: string) {
  try {
    if (readFileSync(abs, 'utf8') === content) return
  } catch {
    // Not on disk yet, or unreadable: fall through and write it.
  }
  writeFileSync(abs, content, 'utf8')
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** One entry per archived turn: what it was and what it touched, not the full rendered record. */
function renderArchiveEntry(rec: WorkRecord, ordinal: number, parent?: TerminalSession): string {
  const who = rec.origin === 'owner' ? 'you' : parent ? `"${parent.title}"` : 'another agent'
  const files = rec.filesTouched.length
    ? rec.filesTouched.map((f) => `    - ${f}`).join('\n')
    : '    (no files written)'
  return [
    `### ${String(ordinal).padStart(3, '0')}. ${rec.ask.split('\n')[0]?.slice(0, 80) || 'turn'}`,
    `${stamp(rec.startedAt)}, asked by ${who}`,
    files,
  ].join('\n')
}

/** How much of the ask a page quotes. Enough to recognise the turn in a list, and no more. */
const ASK_QUOTE = 400

/**
 * One page, kept short.
 *
 * The earlier shape carried the session title, the start, the duration, the tool call count, a
 * sentence about who asked, up to eight thousand characters of the ask in a fenced block, the files,
 * and a footer saying Garden wrote it. Almost all of that is either already on the card, repeated
 * identically on every page in the directory, or the point restated: whoever opened this knows which
 * card's history it is and knows Garden wrote it.
 *
 * The tool call count is deliberately gone. It measured effort rather than change, so a turn that
 * searched forty times and wrote nothing outscored a turn that read once and fixed the bug, and the
 * owner's judgement was that tool usage is not what history is for. `WorkRecord.toolCalls` is still
 * recorded; nothing renders it.
 */
export function renderRecord(rec: WorkRecord, session: TerminalSession, parent?: TerminalSession): string {
  const who =
    rec.origin === 'owner' ? 'asked by you' : `dispatched by ${parent ? `"${parent.title}"` : 'another agent'}`

  const lines = [
    `# ${rec.ask.split('\n')[0]?.slice(0, 80) || 'turn'}`,
    '',
    `${stamp(rec.startedAt)}, ${duration(rec)}, ${who}`,
    '',
    '## Changed',
    '',
  ]

  if (rec.filesTouched.length === 0) {
    // Not "none". A turn whose writes were never seen is a different fact from a turn that wrote
    // nothing, and the CLI only reports a write while Garden is watching. A page with this line on
    // it is a dispatch: `hasSubstance` gives no other kind of turn a page.
    lines.push('No writes were observed during this turn.')
  } else {
    for (const f of rec.filesTouched) lines.push(`- ${f}`)
  }

  const ask = (rec.ask.split('\n\n')[0] ?? rec.ask).trim().slice(0, ASK_QUOTE)
  if (ask) {
    lines.push('', '## Asked', '', ...ask.split('\n').map((l) => `> ${l}`))
  }
  lines.push('')
  return lines.join('\n')
}

export interface WrittenTurn {
  abs: string
  title: string
  record: WorkRecord
  /** Images this turn actually opened, absolute paths, in the order it opened them. */
  images: string[]
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/**
 * Which pictures a turn looked at.
 *
 * Taken from the file path on the CLI's own Read calls, so a turn that reviewed three screenshots
 * names those three and one that reviewed none names nothing. This is the difference between
 * knowing a review command ran and knowing what it was looking at, which for a blind review is
 * the only part that settles anything: the reviewer's verdict is worth exactly as much as the
 * image it was given.
 *
 * A subagent's reads arrive on its parent session's event stream, so a blind reviewer dispatched
 * mid-turn has its screenshots counted here rather than lost with the agent.
 */
export function imagesInTurn(events: AgentEvent[], rec: WorkRecord): string[] {
  const out: string[] = []
  for (const e of events) {
    const p = e.payload as any
    if (!p) continue
    // Bound to the turn either by the CLI's own prompt id, or by the window the turn ran in for
    // the events that carry no prompt id at all.
    const sameTurn = rec.promptId
      ? p.prompt_id === rec.promptId
      : e.ts >= rec.startedAt && (rec.endedAt === null || e.ts <= rec.endedAt)
    if (!sameTurn) continue
    const file = p.tool_input?.file_path ?? p.tool_input?.path
    if (typeof file !== 'string' || !IMAGE_EXT.test(file)) continue
    if (!out.includes(file)) out.push(file)
  }
  return out
}

/**
 * The same history block, for a card that has a transcript instead of work records.
 *
 * A spawned agent produces no work records: those are built from the hook events of a session
 * Garden launched, and Garden never launched this one. So its history arrow opened nothing, and the
 * card that most needed a record of what it did was the one card that could not show one. Its
 * transcript has been on disk the whole time.
 *
 * Split on what it was asked. Everything an agent says and does after a question belongs to that
 * question, which is the same shape a session card's turns already have, so the block above an
 * agent card reads like the block above any other card rather than like a second kind of thing.
 *
 * The WorkRecord attached to each turn is assembled here rather than read from the store, and it is
 * marked as coming from an agent. Nothing in it is invented: the ask and the timing are the
 * transcript's own, and the fields Garden genuinely does not know for a spawned agent stay null
 * rather than being filled with something plausible.
 */
export function writeAgentHistory(session: TerminalSession, turns: ChatTurn[]): WrittenTurn[] {
  const dir = historyDirFor(session.id)
  const out: WrittenTurn[] = []

  // Group into exchanges: an "asked" opens one, and what follows belongs to it. Anything before the
  // first question is its own opening group, since an agent is often given its brief another way.
  const groups: Array<{ ask: string; at: number | null; body: ChatTurn[] }> = []
  for (const t of turns) {
    if (t.role === 'asked' || groups.length === 0) {
      groups.push({ ask: t.role === 'asked' ? t.text : 'What it did', at: t.at, body: t.role === 'asked' ? [] : [t] })
      continue
    }
    groups[groups.length - 1]!.body.push(t)
  }

  groups.forEach((g, i) => {
    const lines = [`# ${g.ask.split('\n')[0]?.slice(0, 80) || 'Turn'}`, '']
    if (g.at) lines.push(`Started ${new Date(g.at).toLocaleString()}`, '')
    if (g.ask) lines.push('## Asked', '', g.ask, '')
    for (const t of g.body) {
      if (t.role === 'said') lines.push('## Said', '', t.text, '')
      if (t.role === 'did') lines.push(`- did: ${t.text}`)
    }
    const name = `${String(i + 1).padStart(3, '0')}-${(g.ask.split('\n')[0] ?? 'turn')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'turn'}.md`
    const abs = join(dir, name)
    writeFileSync(abs, lines.join('\n'), 'utf8')
    out.push({
      abs,
      title: `from agent: ${g.ask.split('\n')[0]?.slice(0, 40) || 'turn'}`,
      record: {
        id: `${session.id}:agent:${i + 1}`,
        sessionId: session.id,
        promptId: null,
        origin: 'agent',
        parentId: session.parentId,
        ask: g.ask,
        startedAt: g.at ?? session.createdAt,
        endedAt: g.body.length ? (g.body[g.body.length - 1]!.at ?? null) : null,
        filesTouched: [],
        toolCalls: g.body.filter((t) => t.role === 'did').length,
      },
      images: [],
    })
  })

  return out
}

/**
 * Write every turn to disk and return where each one landed.
 *
 * Two bounds keep the file count from tracking the turn count. A turn with no substance (see
 * `hasSubstance`) is only counted, in the archive, never given its own file. Of the turns that do
 * have substance, only the most recent `RECENT_PAGES` keep an individual file; everything older
 * rolls into `_archive.md`. A card that has run for a week and produced hundreds of turns still
 * opens as at most `RECENT_PAGES + 1` files, not hundreds.
 *
 * Ordinals are assigned oldest-first over the turns-with-substance only, so a turn's number, once
 * assigned, never changes as later turns arrive or as it ages from a page into the archive. That
 * stability is what lets `writeIfChanged` skip a write instead of everything shifting by one
 * every time a new significant turn appears.
 */
export function writeHistory(
  session: TerminalSession,
  records: WorkRecord[],
  parentOf: (id: string | null) => TerminalSession | undefined,
  events: AgentEvent[] = [],
): WrittenTurn[] {
  const dir = historyDirFor(session.id)
  // Oldest first so the numbering is stable as new turns arrive.
  const ordered = [...records].sort((a, b) => a.startedAt - b.startedAt)
  if (ordered.length === 0) return []

  const withSubstance = ordered.filter(hasSubstance)
  const noiseCount = ordered.length - withSubstance.length

  const archivedCount = Math.max(0, withSubstance.length - RECENT_PAGES)
  const archived = withSubstance.slice(0, archivedCount)
  const paged = withSubstance.slice(archivedCount)
  const pageNames = paged.map((rec, i) => fileNameFor(rec, archivedCount + i + 1))

  /*
   * A turn that has just aged out of the recent window loses its individual file: its content now
   * lives in the archive below, and leaving the old file behind would defeat the bound. Only page
   * files are touched here (the `NNN-` prefix), never task-*.md, transcript.md, the archive itself,
   * or anything the owner opened by hand.
   */
  const keep = new Set(pageNames)
  for (const name of safeReadDir(dir)) {
    if (!/^\d{3}-/.test(name) || keep.has(name)) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      // Already gone, or held open on Windows: the next call tries again.
    }
  }

  // Oldest logical entry first, matching `ordered`: the caller reverses this whole list for
  // display, and the archive standing for everything before the pages must end up last, not first.
  const out: WrittenTurn[] = []

  if (archived.length > 0 || noiseCount > 0) {
    const lines = [
      `# Earlier turns for ${session.title}`,
      '',
      `${ordered.length} turns total. ${paged.length} are shown above as their own cards.`,
    ]
    if (archived.length) {
      lines.push(
        `${archived.length} more did real work and are rolled up here instead of kept as ` +
          `${archived.length} separate files:`,
        '',
      )
      archived.forEach((rec, i) => lines.push(renderArchiveEntry(rec, i + 1, parentOf(rec.parentId)), ''))
    }
    if (noiseCount) {
      lines.push(
        `${noiseCount} more made no tool calls and touched no files: harness wake-ups, task ` +
          'notifications, one-line replies, pasted error text. Counted here, not written out ' +
          'individually.',
        '',
      )
    }
    lines.push(
      '---',
      '',
      "Written by Garden from this session's own hook events. Every turn named above is still a " +
        'row in the work table; nothing here was deleted, only rolled up. Deleting this whole ' +
        'directory and reopening history rebuilds it from that table.',
      '',
    )
    const abs = join(dir, ARCHIVE_NAME)
    writeIfChanged(abs, lines.join('\n'))
    out.push({
      abs,
      title: `${session.title}: earlier turns`,
      record: {
        id: `${session.id}:archive`,
        sessionId: session.id,
        promptId: null,
        origin: 'agent',
        parentId: null,
        ask: 'Everything older than the turns shown as their own cards.',
        startedAt: ordered[0]!.startedAt,
        endedAt: ordered[ordered.length - 1]!.endedAt,
        filesTouched: [],
        toolCalls: 0,
      },
      images: [],
    })
  }

  paged.forEach((rec, i) => {
    const abs = join(dir, pageNames[i]!)
    writeIfChanged(abs, renderRecord(rec, session, parentOf(rec.parentId)))
    const first = rec.ask.split('\n')[0]?.slice(0, 40) || 'turn'
    // The prefix is data, not decoration: it says at a glance which turns the owner asked for
    // and which arrived from another agent, which is the thing he could not see before.
    out.push({
      abs,
      title: rec.origin === 'agent' ? `from agent: ${first}` : first,
      record: rec,
      images: imagesInTurn(events, rec),
    })
  })

  return out
}
