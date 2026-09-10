/**
 * Archives Claude Code's own transcripts into Garden's database before the CLI's 30-day
 * retention deletes them off disk.
 *
 * Claude Code writes two shapes under ~/.claude/projects/<slug>/:
 *   <sessionId>.jsonl                              a top-level session transcript
 *   <sessionId>/subagents/agent-<agentId>.jsonl     one subagent's full conversation,
 *   <sessionId>/subagents/agent-<agentId>.meta.json   with a sibling holding agentType,
 *                                                      description, model, spawnDepth, toolUseId
 *
 * This module only reads that tree and writes rows into Store; it never touches the source
 * files, so a bug here can lose nothing the owner still has on disk.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { Store } from './store.js'

export interface TranscriptFile {
  absPath: string
  slug: string
  claudeSessionId: string | null
  agentId: string | null
  mtimeMs: number
  bytes: number
}

export interface ArchiveOptions {
  root?: string
  /** Files larger than this are reported as skipped rather than read into memory. */
  maxBytes?: number
  /**
   * The only project slugs that may be archived. Omit it and the set is derived from the board,
   * which is what the running server wants. Pass `null` to archive everything found, which only a
   * test over its own temporary tree has any business doing.
   */
  slugs?: Set<string> | null
}

export interface ArchiveResult {
  added: number
  skipped: number
  bytes: number
  /** Paths that were skipped for being over maxBytes, so a caller can see what was left out. */
  oversized: string[]
}

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects')
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/**
 * Claude Code names a project folder after its path with every non-alphanumeric character replaced
 * by a dash, so `C:\Work\App\1.0` is stored under `C--Work-App-1-0`. That mapping loses information
 * (a dash in the slug may have been a separator or a character in the name), which is why the check
 * below is equality against a known slug and never a prefix: `C--Work-App-1-0` and
 * `C--Work-App-1-0-stable` are different directories that a prefix test cannot tell apart.
 */
function slugFor(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The project folders this board is allowed to archive: the projects on it, plus the working
 * directory of every session it has ever launched.
 *
 * An allow list rather than a deny list, so the default for an unrecognised folder is to leave it
 * alone. Garden had no filter at all before this, and the result was that it copied 3.7 GB of the
 * owner's unrelated work into its own database, including gigabytes from a project he had told it
 * to stay out of entirely. A deny list would have required knowing the name of every folder to
 * avoid, in advance, before anything went wrong. This does not.
 *
 * ~/.claude/projects holds every Claude Code session on the machine, not only the ones this board
 * launched, which is the whole reason the default has to be "leave it alone".
 *
 * The consequence worth stating: adding a project to the board is what puts it in scope. Nothing
 * else does.
 */
export function allowedSlugs(store: Store): Set<string> {
  const out = new Set<string>()
  // listProjects already leaves out tabs the owner has closed, and a closed tab's sessions are
  // still picked up by their cwd below, so nothing he has actually worked in falls out of scope.
  for (const p of store.listProjects()) out.add(slugFor(p.path))
  for (const s of store.listSessions()) if (s.cwd) out.add(slugFor(s.cwd))
  return out
}

/**
 * Walks ~/.claude/projects and lists every transcript file found, session-level and per-agent
 * alike. Read-only: this never opens the files themselves, only stats them, so it stays cheap
 * to call on every archiver tick even with thousands of files on disk.
 */
export function scanTranscripts(root: string = DEFAULT_ROOT): TranscriptFile[] {
  const out: TranscriptFile[] = []

  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return out
  }

  for (const slug of slugs) {
    const slugDir = join(root, slug)
    let slugStat
    try {
      slugStat = statSync(slugDir)
    } catch {
      continue
    }
    if (!slugStat.isDirectory()) continue

    let entries: string[]
    try {
      entries = readdirSync(slugDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(slugDir, entry)
      let st
      try {
        st = statSync(entryPath)
      } catch {
        continue
      }

      if (st.isFile() && entry.endsWith('.jsonl')) {
        // A session transcript sitting directly in the project folder, named for its own session id.
        out.push({
          absPath: entryPath,
          slug,
          claudeSessionId: basename(entry, '.jsonl'),
          agentId: null,
          mtimeMs: st.mtimeMs,
          bytes: st.size,
        })
        continue
      }

      if (!st.isDirectory()) continue

      // entry is a session id directory. Its subagent transcripts, if any, live under subagents/.
      const subDir = join(entryPath, 'subagents')
      if (!existsSync(subDir)) continue

      let subEntries: string[]
      try {
        subEntries = readdirSync(subDir)
      } catch {
        continue
      }

      for (const f of subEntries) {
        const m = f.match(/^agent-(.+)\.jsonl$/)
        if (!m) continue // skips the .meta.json siblings too
        const abs = join(subDir, f)
        let fStat
        try {
          fStat = statSync(abs)
        } catch {
          continue
        }
        out.push({
          absPath: abs,
          slug,
          claudeSessionId: entry,
          agentId: m[1],
          mtimeMs: fStat.mtimeMs,
          bytes: fStat.size,
        })
      }
    }
  }

  return out
}

/**
 * Copies whatever scanTranscripts finds that the store does not already have, or has a smaller
 * byte count for, since a transcript still being written grows between ticks. Comparing against
 * the stored byte count (no re-read needed to check) is what keeps a repeat run cheap: 1300
 * unchanged files cost 1300 stats and zero file reads.
 */
export function archiveOnce(store: Store, opts: ArchiveOptions = {}): ArchiveResult {
  const files = scanTranscripts(opts.root)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const allowed = opts.slugs === undefined ? allowedSlugs(store) : opts.slugs

  let added = 0
  let skipped = 0
  let bytes = 0
  const oversized: string[] = []

  for (const f of files) {
    if (allowed && !allowed.has(f.slug)) {
      skipped++
      continue
    }

    if (f.bytes > maxBytes) {
      oversized.push(f.absPath)
      skipped++
      continue
    }

    // Only the stored byte count decides whether this file needs re-reading, so only the byte count
    // is fetched. See `transcriptBytesBySource` for what asking for the whole row used to cost.
    const existingBytes = store.transcriptBytesBySource(f.absPath)
    if (existingBytes !== undefined && existingBytes >= f.bytes) {
      skipped++
      continue
    }

    let content: string
    try {
      content = readFileSync(f.absPath, 'utf8')
    } catch {
      skipped++
      continue
    }
    const lineCount = content.split('\n').filter((l) => l.trim().length > 0).length

    let meta: string | null = null
    if (f.agentId) {
      const metaPath = f.absPath.replace(/\.jsonl$/, '.meta.json')
      try {
        meta = readFileSync(metaPath, 'utf8')
      } catch {
        meta = null
      }
    }

    store.upsertTranscript({
      sessionId: null,
      agentId: f.agentId,
      sourcePath: f.absPath,
      slug: f.slug,
      claudeSessionId: f.claudeSessionId,
      bytes: f.bytes,
      lineCount,
      capturedAt: Date.now(),
      content,
      meta,
    })
    added++
    bytes += f.bytes
  }

  return { added, skipped, bytes, oversized }
}

/** Runs archiveOnce on a timer. unref'd so it never keeps the process alive on its own. */
export function startArchiver(store: Store, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      const res = archiveOnce(store)
      if (res.added > 0 || res.oversized.length > 0) {
        console.log(`[garden] transcript archive: +${res.added} (${res.bytes} bytes), ${res.skipped} skipped`)
      }
    } catch (err) {
      console.error('[garden] transcript archive failed:', err)
    }
  }, intervalMs)
  timer.unref()
  return timer
}
