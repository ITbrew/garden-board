import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the Claude CLI thinks is running, read from its own registry.
 *
 * One file, in one place, because everything in here is knowledge of somebody else's private
 * layout. It is worth having anyway: without it Garden cannot tell a conversation it may reopen
 * from one it may not, and being wrong about that is the difference between a card coming back with
 * its work in front of it and a card sitting at a bare shell prompt.
 */

/** The CLI writes one JSON file per running session here, named for the pid. */
function registryDir(configDir: string): string {
  return join(configDir, 'sessions')
}

/**
 * What one entry says. Only the fields Garden reads, because the rest is not its business.
 *
 * Beside each `<pid>.json` the CLI also writes a `<pid>.<hash>.key` holding a peer token. That is a
 * secret, nothing here opens it, and nothing Garden shows or writes may ever carry it.
 */
export interface RegistryEntry {
  pid: number
  sessionId: string | null
  /** The version of the process that wrote this, which is the card's RUNNING version. */
  version: string | null
  cwd: string | null
  status: string | null
  updatedAt: number | null
}

function readEntry(configDir: string, file: string): RegistryEntry | null {
  try {
    const raw = JSON.parse(readFileSync(join(registryDir(configDir), file), 'utf8')) as Record<string, unknown>
    const pid = Number(raw.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    return {
      pid,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      version: typeof raw.version === 'string' ? raw.version : null,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      status: typeof raw.status === 'string' ? raw.status : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    }
  } catch {
    // A half-written file is one the CLI is in the middle of writing, and both callers here run
    // often enough to see one. Nothing is a safer answer than a guess at what it was going to say.
    return null
  }
}

/**
 * The CLI's own entry for one live pid, or null when there is not one.
 *
 * This is where a card's running version comes from. It is written by the process itself and it
 * never moves while that process lives: on this machine, a card started before the 2.1.263 install
 * rewrote its entry nine hours afterwards and still recorded 2.1.261, which is exactly the fact the
 * update notice is trying to tell the owner in a form nothing can read. The measurement is in
 * `.claude/work-orders/cli-update-evidence.md`, section 1.
 *
 * Named for the pid, so a card that Garden knows the pid of costs one file read rather than a
 * directory scan. A card whose pid Garden does not know has no running version by definition.
 */
export function registryEntryFor(pid: number | null | undefined, configDir: string): RegistryEntry | null {
  if (!Number.isInteger(pid as number) || (pid as number) <= 0) return null
  return readEntry(configDir, `${pid}.json`)
}

/**
 * The version the process holding one conversation is running, or null.
 *
 * By conversation rather than by pid, and that is the whole reason this is not a one-line read of
 * `<pid>.json`. The pid Garden holds is the shell it spawned; the CLI is that shell's child, and
 * finding a child means walking the process table, which costs a process spawn per card per ask.
 * The conversation id is already on the card, the registry names it, and matching on it costs one
 * directory of small files.
 *
 * Null rather than a guess, everywhere: no conversation known yet, no entry, a dead pid, an entry
 * with no version, or no registry directory at all. Canon 21's rule is that unknown is never
 * pending, and it is these nulls that carry it.
 *
 * Cached for a moment because a busy board broadcasts a card many times a second and the answer
 * cannot change faster than a process can start. Three seconds is short enough that a card is
 * telling the truth about itself well before anyone could act on it, and long enough that a
 * hundred-card board is not opening the same sixteen files a hundred times.
 */
const REGISTRY_TTL_MS = 3000
let registryCache: { at: number; dir: string; byConversation: Map<string, RegistryEntry> } | null = null

function liveEntries(configDir: string): Map<string, RegistryEntry> {
  const now = Date.now()
  if (registryCache && registryCache.dir === configDir && now - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.byConversation
  }
  const byConversation = new Map<string, RegistryEntry>()
  let names: string[]
  try {
    names = readdirSync(registryDir(configDir))
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const entry = readEntry(configDir, name)
    if (!entry?.sessionId) continue
    if (!alive(entry.pid)) continue
    byConversation.set(entry.sessionId, entry)
  }
  registryCache = { at: now, dir: configDir, byConversation }
  return byConversation
}

export function runningVersionForConversation(
  claudeSessionId: string | null | undefined,
  configDir: string,
): string | null {
  if (!claudeSessionId) return null
  return liveEntries(configDir).get(claudeSessionId)?.version ?? null
}

/** Only for tests, which move faster than the cache above is designed for. */
export function forgetRegistryCache(): void {
  registryCache = null
}

/**
 * Whether some other live process is already sitting in this conversation.
 *
 * This check was written in August against a CLI that refused a held `--resume` and exited, leaving
 * the card at a bare PowerShell prompt: card b177ad92 at 03:25 on 2026-08-14 shows the refusal,
 * then the owner typing `test`, then `claude`. His words at the time: "i have to resume each
 * terminal to their session manually".
 *
 * That is no longer why this exists. Measured on 2026-09-06 against 2.1.263: the refusal sentence is
 * not in the installed build at all, and a second process resuming a conversation another live
 * process is holding is allowed. It starts, it reads the same transcript, and it appends to it. So
 * the failure this now prevents is not an exit, it is two writers in one transcript, which is worse
 * for being silent: nothing refuses, nothing warns, and the history the owner reads back afterwards
 * has two conversations interleaved in it with no marker saying where one stops.
 *
 * The behaviour here is unchanged, and deliberately so. Held still means the card branches a copy of
 * its history rather than continuing the original, which is worse than resuming and far better than
 * either starting empty or corrupting the record.
 *
 * A restart is exactly when this happens. Garden kills the shell it spawned; a session the CLI has
 * moved into its own daemon is not in that tree and keeps running, holding the conversation, so the
 * first thing the owner does after a restart is the thing guaranteed to hit it.
 *
 * The layout here is the CLI's own and undocumented, so being wrong about it is cheap in one
 * direction only: a stale or recycled pid reads as held, and held only costs a branch.
 * `scripts/test-card-resumes-after-restart.mjs` checks the layout against `claude agents --json`,
 * which IS a documented interface, so a change to it fails a test rather than silently turning this
 * check off.
 */
export function conversationHeldElsewhere(claudeSessionId: string, configDir: string): boolean {
  let names: string[]
  try {
    names = readdirSync(registryDir(configDir))
  } catch {
    // No registry at all is the normal state on a machine where nothing is running.
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    // A half-written file reads as null and is skipped rather than treated as held: this runs on
    // every start of every card.
    const entry = readEntry(configDir, name)
    if (!entry || entry.sessionId !== claudeSessionId) continue
    if (alive(entry.pid)) return true
  }
  return false
}

/** Signal 0 asks whether a process exists without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // It exists and belongs to somebody else, which for this question is still a yes.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
