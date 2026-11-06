import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which Codex conversation a card was last in, found on disk rather than recorded. Canon 21.
 *
 * Codex writes every conversation to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl`, and
 * the first line of each is a `session_meta` record listing the session's writable roots. Garden
 * passes every Codex card its own mailbox directory as one of those roots (`codexWritable`), and a
 * mailbox belongs to one card, so a conversation naming `mail/<card id>` is that card's and no
 * other's. The working directory could not do this: two cards on one folder is the normal case.
 *
 * Before this existed a Codex card came back empty after every backend restart. On 2026-11-01 that
 * was five cards at once, each with its history still on disk and nothing pointing at it.
 */

/** How far back the search goes. A card off for longer than this starts a new conversation. */
const MAX_DAYS = 45

/**
 * The first line is about 23 KB, nearly all of it the model's base instructions. Read enough for
 * that with room to spare, and never the rest of a file that can run to several megabytes.
 */
const HEAD_BYTES = 256 * 1024

interface SessionMeta {
  id?: unknown
  source?: unknown
  thread_source?: unknown
  runtime_workspace_roots?: unknown
}

function firstLine(path: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    return nl < 0 ? null : text.slice(0, nl)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** True when `root` is `.../mail/<cardId>`, whichever drive or data directory it was written under. */
function isCardMailbox(root: unknown, cardId: string): boolean {
  if (typeof root !== 'string') return false
  const parts = root.split(/[\\/]+/).filter(Boolean)
  return parts.length >= 2 && parts[parts.length - 2]!.toLowerCase() === 'mail' && parts[parts.length - 1]!.toLowerCase() === cardId.toLowerCase()
}

/** The conversation id in `file` if it is this card's own top-level conversation, else null. */
export function conversationFor(file: string, cardId: string): string | null {
  const line = firstLine(file)
  if (!line) return null
  let record: { type?: unknown; payload?: SessionMeta }
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  const meta = record.payload
  if (record.type !== 'session_meta' || !meta) return null
  /*
   * A subagent Codex spawned inside the card inherits the card's roots, so it names the same mailbox.
   * Its `source` is an object naming the parent thread and its `thread_source` is "subagent";
   * resuming one would put the card into a helper's side conversation.
   */
  if (meta.thread_source !== 'user' || typeof meta.source !== 'string') return null
  if (!Array.isArray(meta.runtime_workspace_roots) || !meta.runtime_workspace_roots.some((r) => isCardMailbox(r, cardId))) return null
  return typeof meta.id === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(meta.id) ? meta.id : null
}

function numericDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a))
  } catch {
    return []
  }
}

/**
 * The newest conversation of this card in `codexHome`, or null.
 *
 * Newest day folder first, and within a day the newest file first: Codex names files by their start
 * time, so the name sorts them. Stops at the first match.
 */
export function findCodexConversation(codexHome: string, cardId: string, maxDays = MAX_DAYS): string | null {
  const root = join(codexHome, 'sessions')
  let days = 0
  for (const y of numericDirs(root)) {
    for (const m of numericDirs(join(root, y))) {
      for (const d of numericDirs(join(root, y, m))) {
        if (days++ >= maxDays) return null
        const dir = join(root, y, m, d)
        let files: string[]
        try {
          files = readdirSync(dir).filter((f) => /^rollout-.*\.jsonl$/i.test(f)).sort().reverse()
        } catch {
          continue
        }
        for (const f of files) {
          const id = conversationFor(join(dir, f), cardId)
          if (id) return id
        }
      }
    }
  }
  return null
}
