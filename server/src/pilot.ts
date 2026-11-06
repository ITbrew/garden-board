/**
 * The orchestrator runs the board: the parts that are plain functions. Canon 28.
 *
 * Kept out of index.ts so each can be tested on its own: reading a permission prompt off a screen,
 * counting what is left in a to-do list, and writing the board as the orchestrator reads it. The
 * sweep that calls these, the wakes and the `/pilot` route live in index.ts beside the Keeper's.
 */

/** One option a prompt offers, by the number the CLI shows beside it. */
export interface PromptOption {
  n: number
  label: string
}

/** What a card's screen shows when it is stopped at a question or a permission prompt. */
export interface ScreenPrompt {
  /** The question line, e.g. "Do you want to proceed?". */
  question: string
  /** The lines above the question inside the prompt: the command or tool it wants, and why. */
  asks: string[]
  options: PromptOption[]
}

const OPTION = /^\s*(?:[│┃|]\s*)?(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*(?:[│┃|])?\s*$/
const FRAME = /^\s*[│┃|]\s?|\s?[│┃|]\s*$/g
const RULE = /^[\s│┃|]*[─━═╭╰╮╯┌└┐┘]{3,}/

/**
 * The prompt on screen, or null when there is none.
 *
 * Read from the bottom up: the last run of numbered options, the question just above them, and the
 * block above that back to the prompt's top rule or a blank gap. Claude and Codex both draw their
 * options as "1. Yes" with a pointer on the chosen one; a screen with no such run is not a prompt,
 * whatever its status says, and nothing is answered on it.
 */
export function readPrompt(lines: string[]): ScreenPrompt | null {
  const rows = lines.map((l) => l.replace(/\s+$/, ''))
  let last = -1
  for (let i = rows.length - 1; i >= 0; i--) if (OPTION.test(rows[i]!)) { last = i; break }
  if (last < 0) return null
  let first = last
  while (first > 0 && OPTION.test(rows[first - 1]!)) first--
  const options = rows.slice(first, last + 1).map((r) => {
    const m = OPTION.exec(r)!
    return { n: Number(m[1]), label: m[2]!.trim() }
  })
  // Numbered from 1 without gaps, or it is a numbered list in some output rather than a prompt.
  if (options.length < 2 || options.some((o, i) => o.n !== i + 1)) return null

  let q = first - 1
  while (q >= 0 && !rows[q]!.replace(FRAME, '').trim()) q--
  const question = q >= 0 ? rows[q]!.replace(FRAME, '').trim() : ''
  const asks: string[] = []
  for (let i = q - 1, blanks = 0; i >= 0 && asks.length < 6; i--) {
    if (RULE.test(rows[i]!)) break
    const t = rows[i]!.replace(FRAME, '').trim()
    if (!t) {
      if (++blanks > 1 && asks.length) break
      continue
    }
    blanks = 0
    asks.unshift(t)
  }
  return { question, asks, options }
}

/** Unticked items in a TODO.md: `- [ ] ...` lines, the project's list of what is left (canon 26). */
export function openTodos(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s+\[ \]\s+\S/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+\[ \]\s+/, '').trim())
}

export interface BoardCard {
  title: string
  adapter: string
  role: string | null
  state: string
  /** Milliseconds in that state. */
  forMs: number
  running: boolean
  blockedOn: string | null
  task: string | null
  lastAsk: string | null
  lastLine: string | null
  isYou: boolean
}

export interface BoardInput {
  project: string
  now: number
  held: boolean
  running: number
  runningLimit: number | null
  openTasks: Array<{ id: string; state: string; owner: string | null }>
  todos: string[]
  cards: BoardCard[]
}

export function since(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const one = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** BOARD.md: the board as its orchestrator reads it at every wake. */
export function boardMarkdown(b: BoardInput): string {
  const stamp = new Date(b.now).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  const out: string[] = [
    `# The board: ${b.project}`,
    '',
    `Garden keeps this file; it was last written ${stamp}. Canon 28. Read it at every wake, act on it,`,
    'and write one line of what you did to BOARD-LOG.md beside it.',
    '',
    b.held
      ? '**The board is on hold.** The owner stopped it. Start nothing and hand out nothing until he says to carry on (`garden-pilot.mjs --go` once he has).'
      : '**The board is flowing.** While work is open and the board is under its ceiling, keep it moving.',
    '',
    `Running: ${b.running}${b.runningLimit != null ? ` of ${b.runningLimit} allowed at once` : ''}.`,
    '',
    '## Cards',
    '',
  ]
  for (const c of b.cards) {
    const head = `- **${c.title}**${c.isYou ? ' (you)' : ''} · ${c.adapter}${c.role ? ` · ${c.role}` : ''} · ${c.state} ${since(c.forMs)}${c.running ? '' : ' · no process'}`
    out.push(head)
    if (c.blockedOn) out.push(`  - blocked on: ${one(c.blockedOn, 400)}`)
    if (c.task) out.push(`  - task: ${one(c.task)}`)
    if (c.lastAsk) out.push(`  - last asked: ${one(c.lastAsk)}`)
    if (c.lastLine) out.push(`  - last printed: ${one(c.lastLine)}`)
  }
  out.push('', `## Open tasks (${b.openTasks.length})`, '')
  if (!b.openTasks.length) out.push('None.')
  for (const t of b.openTasks) out.push(`- ${t.id} · ${t.state}${t.owner ? ` · ${t.owner}` : ' · nobody holds it'}`)
  out.push('', `## Left in TODO.md (${b.todos.length})`, '')
  if (!b.todos.length) out.push('Nothing unticked.')
  for (const t of b.todos.slice(0, 40)) out.push(`- ${one(t)}`)
  if (b.todos.length > 40) out.push(`- …and ${b.todos.length - 40} more`)
  out.push('')
  return out.join('\n')
}
