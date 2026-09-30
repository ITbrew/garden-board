/**
 * Which build this process is, so two halves of Garden can be told apart.
 *
 * Garden runs as two processes: this server, and the page. They are started together and can end up
 * on different code, because the backend is restartable on its own and the page reloads on its own.
 * When that happens the app looks fine and behaves like neither version, and the only way the owner
 * found out was by noticing a fix he had watched land was not there.
 *
 * So each half carries its identity: the version out of its own package.json, and the commit the
 * checkout was on when the process started. The page shows its own and says so plainly when the
 * server answers with a different one.
 *
 * Read once at import. The commit a running process was started from does not change while it runs,
 * and re-reading it would report the checkout rather than the process, which is the opposite of what
 * this is for.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** server/, whether this file is running from src/ under tsx or from dist/ after a build. */
const pkgPath = resolve(here, '..', 'package.json')
const repo = resolve(here, '..', '..')

function readVersion(): string {
  try {
    return String(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * The short commit, plus a mark when the checkout had uncommitted changes at start.
 *
 * Every failure here is answered with 'nocommit' rather than thrown: this is a label on a header,
 * and a server that refuses to start because git is missing would be a worse bug than the one this
 * file exists to catch.
 */
function readCommit(): string {
  const head = headFromFiles(repo)
  if (!head) return 'nocommit'
  try {
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        .length > 0
    return dirty ? `${head}+` : head
  } catch {
    // The mark is a hint the header ignores when comparing; losing it is not worth losing the commit.
    return head
  }
}

/**
 * The commit HEAD names, read from the repository's own files rather than by running git.
 *
 * Running git here failed on the owner's board after a restart, which starts this server, the page
 * and every card that was running all at once: the server labelled itself "nocommit" while the page
 * had the real commit, and the header said "builds differ" over two halves on the same code. Reading
 * two small files cannot time out.
 */
function headFromFiles(repo: string): string | null {
  try {
    const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null
    const ref = head.slice(5)
    const loose = join(repo, '.git', ...ref.split('/'))
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim().slice(0, 7)
    const packed = readFileSync(join(repo, '.git', 'packed-refs'), 'utf8')
    const line = packed.split(/\r?\n/).find((l) => l.endsWith(' ' + ref))
    return line ? line.slice(0, 7) : null
  } catch {
    return null
  }
}

export const BUILD = {
  version: readVersion(),
  commit: readCommit(),
  /** When this process started, so "the server is older" can be said with a time rather than implied. */
  startedAt: Date.now(),
}
