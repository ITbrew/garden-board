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
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const head = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain']).length > 0
    return dirty ? `${head}+` : head
  } catch {
    return 'nocommit'
  }
}

export const BUILD = {
  version: readVersion(),
  commit: readCommit(),
  /** When this process started, so "the server is older" can be said with a time rather than implied. */
  startedAt: Date.now(),
}
