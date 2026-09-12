/**
 * Reading a subagent's transcript back into something worth looking at.
 *
 * This is the file the owner has never been able to open. Claude Code already writes every
 * subagent's full conversation to disk and then rotates it out after thirty days, so the history
 * was never lost, only unreachable. Rendering it as a document card is the difference between an
 * agent that vanished and an agent you can go back and read.
 *
 * The format is undocumented and can change on any release, so every field is optional and every
 * unknown shape is skipped rather than guessed at. If this breaks, one card renders thinly and
 * nothing else in the app moves.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

export interface TranscriptRender {
  markdown: string
  /** Absolute paths of images the agent actually opened, in the order it opened them. */
  images: string[]
  turns: number
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * The one field worth showing per tool, rather than a wall of JSON nobody reads.
 *
 * Returns what to draw and, when that is not the whole thing, the whole thing, so the card can offer
 * the rest rather than only admitting it exists. A blind reviewer reading a card full of real turns
 * put it exactly right: "I can see content is missing with no way to get at it."
 *
 * The cut falls on the last space before the limit rather than at the limit, because a command
 * sliced mid-token reads as a rendering fault. The same reviewer quoted `console.log(J...` and
 * `2>&1 ...` back and called the first one broken and the second one merely truncated, which is the
 * whole difference between the two.
 */
function summariseToolInput(name: string, input: any): { text: string; full?: string } {
  if (!input || typeof input !== 'object') return { text: '' }
  const first =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.description
  if (typeof first !== 'string') return { text: '' }
  const flat = first.replace(/\s+/g, ' ').trim()
  if (flat.length <= SUMMARY_CHARS) return { text: flat }
  const cut = flat.slice(0, SUMMARY_CHARS)
  /*
   * A space if there is one, punctuation if there is not, and a hard cut only as a last resort.
   *
   * A space alone is not enough here. A one-liner like `node -e "…"` is a single unbroken token after
   * its first few characters, so the last space sits at position eight and falling back to the hard
   * cut left `...'garden.db'),{r`, which is what a reviewer called broken rather than shortened.
   * Punctuation is where such a line has its real seams.
   */
  const seam = lastSeam(cut)
  const head = seam > SUMMARY_CHARS / 2 ? cut.slice(0, seam).trimEnd() : cut
  return { text: `${head}…`, full: first }
}

/** How much of a tool call a card shows before it offers the rest on hover. */
const SUMMARY_CHARS = 160

/**
 * The characters a command or a path can be cut after without looking severed.
 *
 * A space when there is one, and otherwise the joints a one-liner actually has: path separators,
 * argument separators, pipes, quotes, brackets. Chased one character at a time through a real
 * transcript, each one found by a cut that a reader would have called broken.
 */
const SEAMS = new Set([' ', ',', ';', ':', '=', ')', '/', '\\', '|', '&', '.', "'", '"', '}', ']'])

/** Where the last usable cut point in this window is, or -1 if the window has none. */
export function lastSeam(window: string): number {
  for (let i = window.length - 1; i >= 0; i--) if (SEAMS.has(window[i]!)) return i + 1
  return -1
}

/**
 * How much of the end of a transcript is enough to find the last sixty turns.
 *
 * Generous by a wide margin. A turn is rarely more than a few kilobytes once tool results are
 * dropped, so four megabytes is dozens of turns even for a session that pastes whole files around.
 */
export const TAIL_BYTES = 4 * 1024 * 1024

/**
 * The last stretch of a JSONL file, as whole lines.
 *
 * This used to be `readFileSync` over the entire file, which is fine for a subagent that ran for ten
 * minutes and not fine for the sessions this owner actually runs. Measured against a real 120 MB
 * transcript on this machine: 785 ms and 344 MB of resident memory, to return sixty turns. That runs
 * on the same thread that reads every PTY and serves every socket, and `Ingest.pushChat` calls it
 * twice at the end of every turn, so a long-running card would have stalled the whole board for the
 * best part of two seconds each time it finished thinking. Reading only the end costs the same
 * whether the file is one megabyte or a hundred.
 *
 * The first line of the window is dropped when the window does not start at the beginning of the
 * file, because a byte offset lands mid-record and half a JSON object is not a record.
 *
 * Exported because `Ingest.readUsage` needs exactly this and did not have it. It kept the original
 * `readFileSync` over the whole file, which Node refuses past 512MB: on a 681MB transcript every
 * refresh threw into a catch written for a missing file, so that card's model never moved off the
 * one it announced at startup. Two readers of the same file cannot each decide how much of it to
 * read.
 */
export function tailLines(path: string, bytes: number): string[] {
  const size = statSync(path).size
  if (size <= bytes) return readFileSync(path, 'utf8').split('\n').filter(Boolean)

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    readSync(fd, buf, 0, bytes, size - bytes)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    // The first one began before the window did.
    return lines.slice(1)
  } finally {
    closeSync(fd)
  }
}

/**
 * As far back as this will reach for a card's worth of conversation.
 *
 * The window grows when the first one did not hold enough turns, because how many turns fit in four
 * megabytes depends entirely on the session: one transcript here averages four hundred kilobytes a
 * record and gave ten turns where a chattier one gave sixty. It stops growing at this, and the card
 * shows what was found rather than reading a hundred megabytes to fill a quota.
 */
export const MAX_TAIL_BYTES = 32 * 1024 * 1024

/** One side of a conversation, as a card shows it. */
export interface ChatTurn {
  role: 'asked' | 'said' | 'did'
  text: string
  at: number | null
  /** The whole thing, present only when `text` is a shortened version of it. */
  full?: string
}

/**
 * A spawned agent's conversation, in the order it happened.
 *
 * A subagent card had nothing to show. It is not a process Garden started, so it has no terminal
 * and never will, and the card was reduced to three lines of facts about it: its type, its status
 * and when it finished. The owner's objection was exactly right, that a card which cannot show what
 * was said is not showing the work. Its transcript is on disk the whole time, recorded by the CLI
 * and pointed at by the card's own row, so the conversation was never missing, only unread.
 *
 * The tail rather than the whole file, because an agent that ran for an hour writes megabytes and a
 * card is a card. Tool results are dropped: they arrive as user messages and would drown out the
 * conversation, which is the same rule the markdown renderer above already follows. What a tool DID
 * is kept, as one line, because "it edited this file" is often the whole point of the run.
 */
export function readChat(path: string, limit = 60): ChatTurn[] {
  if (!path || !existsSync(path)) return []
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return []
  }
  for (let window = TAIL_BYTES; ; window *= 4) {
    let turns: ChatTurn[]
    try {
      turns = turnsFrom(tailLines(path, window))
    } catch {
      return []
    }
    if (turns.length >= limit || window >= size || window >= MAX_TAIL_BYTES) {
      return turns.length > limit ? turns.slice(-limit) : turns
    }
  }
}

function turnsFrom(lines: string[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const line of lines) {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = rec?.message
    if (!msg) continue
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || null : null

    if (rec.type === 'user' || msg.role === 'user') {
      const isToolResult = Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === 'tool_result')
      const text = textOf(msg.content).trim()
      if (isToolResult || !text) continue
      turns.push({ role: 'asked', text: text.slice(0, 4000), at })
      continue
    }

    if (rec.type === 'assistant' || msg.role === 'assistant') {
      const text = textOf(msg.content).trim()
      if (text) turns.push({ role: 'said', text: text.slice(0, 4000), at })
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
          const what = summariseToolInput(b.name, b.input)
          turns.push({
            role: 'did',
            text: what.text ? `${b.name}: ${what.text}` : b.name,
            at,
            // Carried only when the text really was shortened, so a card can tell "there is more"
            // from "that is all" instead of offering to expand something already whole.
            ...(what.full ? { full: `${b.name}: ${what.full}` } : {}),
          })
        }
      }
    }
  }

  return turns
}

export function renderTranscript(path: string, limit = 400): TranscriptRender {
  if (!existsSync(path)) {
    return { markdown: `# Transcript\n\nNot on disk: \`${path}\`\n`, images: [], turns: 0 }
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const out: string[] = []
  const images: string[] = []
  let turns = 0

  // The tail, because a long agent run matters most at the end and a whole transcript can be
  // tens of megabytes. The head is where the brief is, so that is kept too.
  const kept = lines.length <= limit ? lines : [...lines.slice(0, 40), '', ...lines.slice(-(limit - 40))]
  if (lines.length > limit) {
    out.push(`> This transcript has ${lines.length} records. Showing the first 40 and the last ${limit - 40}.`, '')
  }

  for (const line of kept) {
    if (!line) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = rec?.message
    if (!msg) continue

    if (rec.type === 'user' || msg.role === 'user') {
      const text = textOf(msg.content).trim()
      // Tool results arrive as user messages and would otherwise drown out the conversation.
      const isToolResult = Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === 'tool_result')
      if (isToolResult || !text) continue
      turns++
      out.push('## Asked', '', text.slice(0, 4000), '')
      continue
    }

    if (rec.type === 'assistant' || msg.role === 'assistant') {
      const text = textOf(msg.content).trim()
      if (text) out.push('## Said', '', text.slice(0, 6000), '')
      if (Array.isArray(msg.content)) {
        const calls: string[] = []
        for (const block of msg.content) {
          if (block?.type !== 'tool_use') continue
          const name = String(block.name ?? 'tool')
          const detail = summariseToolInput(name, block.input)
          // The markdown card has room, so it gets the whole command rather than the card's summary.
          const shown = detail.full ?? detail.text
          calls.push(shown ? `- \`${name}\` ${shown}` : `- \`${name}\``)
          /*
           * The path an agent opened is right here in the tool call, so a screenshot it reviewed
           * can be linked without parsing prose or guessing. This is the owner's question about
           * blind reviews answered directly: the picture the reviewer looked at, by full path.
           */
          const file = block?.input?.file_path
          if (typeof file === 'string' && IMAGE_EXT.test(file) && !images.includes(file)) images.push(file)
        }
        if (calls.length) out.push('### Did', '', ...calls, '')
      }
    }
  }

  const header = ['# Transcript', '', `Source: \`${path}\``, '']
  if (images.length) {
    header.push('## Images this agent opened', '')
    for (const img of images) header.push(`- ${img}`)
    header.push('')
  }
  return { markdown: [...header, ...out].join('\n'), images, turns }
}
