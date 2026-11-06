/**
 * A board written down, so it can be picked back up.
 *
 * Closing a tab already keeps everything, because nothing is deleted and the row simply stops
 * showing it. This is the other thing the owner asked for: a deliberate save, into Garden's own
 * directory, that he can open again from inside the app. The difference is that a save is a moment
 * he chose, so he can lay a team out, save it, take it apart, and get that arrangement back.
 *
 * What a saved board holds: the cards, where they were, what each one was for, and every wire
 * between them. What it deliberately does not hold: process ids, whether anything was running, or
 * any claim that opening it brings a session back to life. A Windows process does not survive being
 * closed, so every card in a restored board says stopped, which is what it is.
 *
 * Files, not database rows, because he asked for the garden directory and because a file can be
 * copied, kept, read by eye and moved to another machine. The format is plain JSON with a version
 * on it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocCard, TerminalSession, Wire } from '@garden/shared'
import { DATA_DIR } from './store.js'

export interface SavedBoard {
  version: 1
  /** The file it lives in, so the UI can name one to open without guessing paths. */
  file: string
  name: string
  projectId: string
  projectPath: string
  savedAt: number
  sessions: TerminalSession[]
  docs: DocCard[]
  wires: Wire[]
}

export function boardsDir(): string {
  const dir = join(DATA_DIR, 'boards')
  mkdirSync(dir, { recursive: true })
  return dir
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9-_ ]/g, '-').trim().slice(0, 60) || 'board'

/**
 * Write one, and hand back what was written.
 *
 * A card's live fields are flattened on the way out rather than on the way back in, so what sits in
 * the file is already honest: no pid, nothing running, nothing waiting on input. A file that says a
 * process was alive invites the reader to believe restoring it will bring that process back.
 */
export function saveBoard(args: {
  name: string
  projectId: string
  projectPath: string
  sessions: TerminalSession[]
  docs: DocCard[]
  wires: Wire[]
}): SavedBoard {
  const stamp = Date.now()
  const file = join(boardsDir(), `${safe(args.name)}-${stamp}.json`)
  const board: SavedBoard = {
    version: 1,
    file,
    name: args.name,
    projectId: args.projectId,
    projectPath: args.projectPath,
    savedAt: stamp,
    /*
     * Which conversation a card was in is not a claim that anything is running, so it stays. This
     * used to be nulled alongside the pid, which read as the same kind of honesty but is a different
     * fact: a pid says a process is alive, and a session id says which history this card owns. With
     * it stripped, a restored card could never be resumed and quietly began a new conversation
     * wearing the saved card's name. Everything that does assert liveness is still flattened.
     */
    sessions: args.sessions.map((s) => ({
      ...s,
      pid: null,
      status: 'stopped',
      waitingFor: null,
      statusSince: null,
    })),
    docs: args.docs,
    wires: args.wires,
  }
  writeFileSync(file, JSON.stringify(board, null, 2), 'utf8')
  return board
}

/** Every saved board, newest first, without hauling their contents around. */
export function listBoards(): Array<Omit<SavedBoard, 'sessions' | 'docs' | 'wires'> & { cards: number }> {
  const out: Array<Omit<SavedBoard, 'sessions' | 'docs' | 'wires'> & { cards: number }> = []
  for (const name of readdirSync(boardsDir())) {
    if (!name.endsWith('.json')) continue
    const file = join(boardsDir(), name)
    try {
      const b = JSON.parse(readFileSync(file, 'utf8')) as SavedBoard
      if (b?.version !== 1) continue
      out.push({
        version: 1,
        // The path on disk wins over whatever the file says its path was, so a board that was
        // copied or moved still opens.
        file,
        name: b.name,
        projectId: b.projectId,
        projectPath: b.projectPath,
        savedAt: b.savedAt,
        cards: (b.sessions?.length ?? 0) + (b.docs?.length ?? 0),
      })
    } catch {
      // A half-written or hand-edited file is skipped rather than taking the list down with it.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

export function readBoard(file: string): SavedBoard | null {
  if (!existsSync(file) || !file.startsWith(boardsDir())) return null
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as SavedBoard
    if (b?.version !== 1) return null
    /*
     * Fields a card has gained since this file was written.
     *
     * A board is a file on disk and the card shape moves on without it. The database write binds
     * every column by name, so a session from an older file with no `closedAt` did not restore
     * badly, it threw, and the restore loop died partway with some cards back and the rest silently
     * missing. Filled in here, at the one place old files enter the system, with the same defaults a
     * new card gets: on the board, running nothing, owning everything.
     */
    b.sessions = (b.sessions ?? []).map((s) => ({
      ...s,
      closedAt: s.closedAt ?? null,
      roleClassRunning: s.roleClassRunning ?? null,
      ownedPaths: s.ownedPaths ?? null,
    }))
    return b
  } catch {
    return null
  }
}

export function deleteBoard(file: string): boolean {
  if (!existsSync(file) || !file.startsWith(boardsDir())) return false
  unlinkSync(file)
  return true
}
