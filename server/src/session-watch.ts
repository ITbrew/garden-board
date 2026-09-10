/**
 * The CLI's own view of what each session is doing.
 *
 * `<config dir>/sessions/<pid>.json` is written by the CLI itself and carries `status` as one of
 * busy, idle or waiting, plus `waitingFor` naming what it is blocked on. That is a fact published
 * by the process in question, which beats every alternative Garden could reach for: no regex over
 * terminal output, no inference from how long the screen has been still, and no lag beyond the
 * poll interval.
 *
 * Hooks and this file are deliberately both wired. A hook gives the transition the instant it
 * happens; this file is the authority on the current state, and it is also what catches a session
 * whose hooks never fired at all. When they disagree, the file wins, because a missed hook leaves
 * a card stuck and a re-read cannot.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionStatus, TerminalSession } from '@garden/shared'
import type { Store } from './store.js'

export interface SessionFile {
  pid: number
  sessionId: string
  cwd: string
  status?: string
  waitingFor?: string
  statusUpdatedAt?: number
}

/** The CLI's three words, mapped to the card's states. Anything else is left alone, not guessed. */
function statusFor(raw: string | undefined): { status: SessionStatus; needsReason: boolean } | null {
  switch (raw) {
    case 'busy':
      return { status: 'working', needsReason: false }
    case 'idle':
      return { status: 'idle', needsReason: false }
    case 'waiting':
      return { status: 'needs-input', needsReason: true }
    default:
      return null
  }
}

export function readSessionFiles(configDirs: string[]): SessionFile[] {
  const out: SessionFile[] = []
  for (const dir of configDirs) {
    const sessionsDir = join(dir, 'sessions')
    if (!existsSync(sessionsDir)) continue
    let names: string[]
    try {
      names = readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
        if (parsed && typeof parsed.sessionId === 'string') out.push(parsed as SessionFile)
      } catch {
        // A file being rewritten as it is read is normal and means nothing is known this tick.
      }
    }
  }
  return out
}

export interface WatchDeps {
  store: Store
  configDirs: () => string[]
  onChange: (session: TerminalSession) => void
  intervalMs?: number
}

/**
 * Poll rather than watch the directory.
 *
 * The file is rewritten in place several times a second by a busy session, and directory watch
 * events on Windows arrive in bursts that would have Garden re-reading the same file dozens of
 * times to learn nothing. A poll costs a handful of small reads and gives a predictable ceiling
 * on how stale a card can be.
 */
export function watchSessionFiles(deps: WatchDeps): NodeJS.Timeout {
  const interval = deps.intervalMs ?? 1500

  const tick = () => {
    let files: SessionFile[]
    try {
      files = readSessionFiles(deps.configDirs())
    } catch {
      return
    }
    for (const file of files) {
      const card = deps.store.findSessionByClaudeId(file.sessionId)
      // A session Garden did not launch has no card yet, and inventing one from a file is a
      // different feature with different rules. Nothing here creates cards.
      if (!card || card.kind !== 'session') continue

      const mapped = statusFor(file.status)
      if (!mapped) continue
      const waitingFor = mapped.needsReason ? file.waitingFor ?? 'input needed' : null
      if (card.status === mapped.status && card.waitingFor === waitingFor) continue
      // A card whose process Garden already knows has exited is not revived by a stale file.
      if (card.pid === null) continue

      const next: TerminalSession = {
        ...card,
        status: mapped.status,
        waitingFor,
        statusSince: file.statusUpdatedAt ?? Date.now(),
      }
      deps.store.upsertSession(next)
      deps.onChange(next)
    }
  }

  const timer = setInterval(tick, interval)
  timer.unref?.()
  return timer
}
