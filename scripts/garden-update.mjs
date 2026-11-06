/**
 * Bring this checkout up to date with the other machine's work, and say what that changed.
 *
 * Two PCs run this project and both of them edit it. The routine agreed between the boards is that
 * whoever changes Garden commits and pushes the same day, and the other pulls before touching
 * source. This is the pulling half, written down as a command so it is the same every time and so
 * "did you pull" has an answer that is not somebody's memory.
 *
 *   npm run update
 *
 * It is deliberately boring, and every refusal below is a case that has actually cost time here.
 *
 * ## What it will not do
 *
 * **It will not touch a dirty tree.** Not stash, not "just this once". Uncommitted work is somebody's
 * unfinished thought and a script that moves it has to be trusted to put it back. It names the files
 * and stops.
 *
 * **It will not merge.** `--ff-only`, always. A merge commit on master between two machines produces
 * a history nobody can read back and a bisect nobody can run. If it will not fast-forward, the two
 * sides have genuinely diverged, and that is a conversation rather than a command.
 *
 * **It will not restart the board.** It says whether a restart is needed and stops there. The owner
 * presses that button. A script that restarts his board while he is reading a card is the same class
 * of mistake as a test that takes his port, which is a mistake this project has already made twice.
 *
 * ## What it does
 *
 * Fetches, shows what is incoming before taking it, fast-forwards, then installs only if the
 * lockfile actually moved and builds only if something that ends up in a build actually moved. Both
 * of those are minutes when they are unnecessary, and skipping them is most of why this is worth
 * running instead of typing four commands.
 *
 * ## This file is always one pull behind itself
 *
 * Node reads this script into memory before the fast-forward replaces it on disk, so a pull that
 * changes this file is carried out by the PREVIOUS version of it. A behaviour added here does not
 * appear on the run that pulls it, only on the one after. Do not predict a run's output by reading
 * this file: read the copy that was on disk when it started, which is `git show <old sha>:<path>`.
 *
 * That cost a false bug report between the two machines once, so the script now says so out loud
 * when it notices it has updated itself. It is the same property that makes the bootstrap case in
 * the README necessary, and it is true of anything that upgrades itself in place.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repo this file lives in, never a path written down. The other machine is on a different drive. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const git = (...args) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/*
 * npm through cmd.exe on Windows, never as `npm.cmd` directly.
 *
 * Node has refused to spawn a `.cmd` or `.bat` without a shell since the fix for CVE-2024-27980
 * (18.20, 20.12, 22 and up), so `execFileSync('npm.cmd', ...)` throws EINVAL before anything is
 * spawned at all. This file shipped with exactly that and both the install and the build branches
 * were dead on every current Windows Node. Measured here on v24.19.0: `npm.cmd --version` gives
 * "spawnSync npm.cmd EINVAL", and the same call through cmd.exe prints the version.
 *
 * `shell: true` also works and is deliberately not used: Node 24 warns DEP0190 about unescaped
 * arguments, and a command line assembled by a shell is a command line someone can put a quote in.
 */
const npm = (...args) =>
  process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: ROOT, stdio: 'inherit' })
    : execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' })

/*
 * Say what actually went wrong before saying what to do about it.
 *
 * The first version of this file caught these and printed only advice, so when the spawn itself
 * failed it reported a build failure for a build that had never run. That is the invisible failure
 * this project has spent a day removing from the launcher and the restart helper, and it does not
 * get to live here either.
 */
const why = (e) => {
  const first = String(e?.message ?? e).split('\n')[0]
  // `code` is set when the spawn itself failed (EINVAL, ENOENT) and `status` when the command ran
  // and exited non-zero. They are different failures and the reader wants to know which one this is.
  const bits = [e?.code, e?.status != null ? `exit ${e.status}` : null, first].filter(Boolean)
  say(`    ${bits.join('  ')}`)
}

const say = (line = '') => console.log(line)
const stop = (code) => process.exit(code)

say('')
say(`Garden update  ${ROOT}`)
say('')

/* --- 1. a dirty tree is somebody's unfinished work --- */

let dirty
try {
  dirty = git('status', '--porcelain')
} catch (e) {
  say('Not a git checkout, or git is not on PATH, so there is nothing to update.')
  say(String(e.message).trim())
  stop(1)
}

if (dirty) {
  say('REFUSED. There are uncommitted changes here:')
  say('')
  for (const line of dirty.split('\n')) say(`    ${line}`)
  say('')
  say('Commit them or put them aside first. This will not stash on your behalf: work it moved')
  say('is work it would have to be trusted to put back, and nothing has been changed.')
  stop(1)
}

/* --- 2. what is upstream, and which way is it --- */

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
let upstream
try {
  upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
} catch {
  say(`REFUSED. The branch "${branch}" is not tracking anything, so there is nothing to pull from.`)
  say('')
  say(`    git branch --set-upstream-to origin/${branch} ${branch}`)
  stop(1)
}

say(`Fetching ${upstream} ...`)
try {
  git('fetch', '--tags', upstream.split('/')[0])
} catch (e) {
  say('')
  say('Could not reach the remote, so nothing has been changed.')
  say(String(e.message).trim())
  stop(1)
}

const [behind, ahead] = git('rev-list', '--left-right', '--count', `${upstream}...HEAD`)
  .split(/\s+/)
  .map(Number)

if (behind === 0 && ahead === 0) {
  say('')
  say(`Already up to date with ${upstream}. Nothing to do.`)
  stop(0)
}

if (behind === 0) {
  say('')
  say(`Nothing incoming. You have ${ahead} commit${ahead === 1 ? '' : 's'} that ${upstream} does not:`)
  say('')
  for (const line of git('log', '--oneline', `${upstream}..HEAD`).split('\n')) say(`    ${line}`)
  say('')
  say('Push when you are ready, so the other machine can pull it:')
  say('')
  say('    git push')
  stop(0)
}

if (ahead > 0) {
  /*
   * Both sides moved. This is the case the whole routine exists to avoid, and it is the one case
   * where a script guessing is worse than a person deciding: a rebase rewrites the local commits and
   * a merge puts a merge commit on master, and which is right depends on what those commits are.
   */
  say('')
  say(`REFUSED. The branches have diverged: ${ahead} local, ${behind} incoming.`)
  say('')
  say('Yours:')
  for (const line of git('log', '--oneline', `${upstream}..HEAD`).split('\n')) say(`    ${line}`)
  say('')
  say('Theirs:')
  for (const line of git('log', '--oneline', `HEAD..${upstream}`).split('\n')) say(`    ${line}`)
  say('')
  say('Nothing has been changed. Rebase yours on top of theirs, which keeps master a straight line:')
  say('')
  say(`    git rebase ${upstream}`)
  say('')
  say('Then run this again, or just push. If a rebase is not obviously right here, say so on the')
  say('board before doing either: two machines resolving the same divergence separately is worse')
  say('than one of them waiting.')
  stop(1)
}

/* --- 3. show it before taking it --- */

const incoming = git('log', '--oneline', `HEAD..${upstream}`)
say('')
say(`Incoming, ${behind} commit${behind === 1 ? '' : 's'}:`)
say('')
for (const line of incoming.split('\n')) say(`    ${line}`)

const changed = git('diff', '--name-only', `HEAD..${upstream}`).split('\n').filter(Boolean)

const versionOf = () => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}
const versionBefore = versionOf()

/* --- 4. fast-forward, or stop --- */

say('')
try {
  git('merge', '--ff-only', upstream)
} catch (e) {
  say('REFUSED. That would not fast-forward, and nothing has been changed.')
  say(String(e.message).trim())
  stop(1)
}
const versionAfter = versionOf()
say(`Fast-forwarded to ${git('rev-parse', '--short', 'HEAD')}.`)

/* --- 5. install and build only when they are actually needed --- */

const touched = (prefix) => changed.some((f) => f.startsWith(prefix))
const lockMoved = changed.includes('package-lock.json')

/*
 * "Source" means what `npm run build` actually compiles and what the running process actually
 * loads, and nothing else. Two directories are deliberately outside it, and both surprised a reader
 * who had written the line: a commit touching only these prints "No source changes, so nothing to
 * build", and that is correct rather than a miss.
 *
 * `scripts/` is not compiled and not imported. The two files in there that matter, the launcher and
 * the supervisor, are read from disk the next time they are run.
 *
 * `server/bin` is the same, and the reasoning is below where it is worked out.
 *
 * So a change under either needs no build and no restart. It is still worth a line on screen,
 * because the next run of those tools behaves differently and nothing else would say so.
 */
/*
 * `server/bin` is the exception inside `server/`, and it is a real one rather than a guess.
 *
 * `npm run build -w @garden/server` is `tsc -p tsconfig.json` with `rootDir: src`, so `server/bin`
 * is never compiled. Nothing in `server/src` imports from it either: those scripts are spawned by
 * path, read from disk at the moment they run. That is the same property that let today's restart
 * helper fix apply on the first restart rather than the second.
 *
 * So a commit touching only `server/bin` needs no build and no restart, and saying RESTART NEEDED
 * for one would put "builds differ" on a board with nothing actually stale behind it. A chip that
 * cries wolf is worse than no chip, because the next real one gets ignored.
 *
 * Everything else under `server/` counts, including its package.json and tsconfig.json, which are
 * read at build or at startup and not afterwards.
 */
const serverRuntimeMoved = changed.some((f) => f.startsWith('server/') && !f.startsWith('server/bin/'))
const sourceMoved = touched('apps/') || touched('packages/') || serverRuntimeMoved
const toolsMoved = touched('scripts/') || touched('server/bin/')

if (lockMoved) {
  say('')
  say('package-lock.json changed, so installing.')
  try {
    npm('install')
  } catch (e) {
    say('')
    say('npm install failed:')
    why(e)
    say('')
    say('The code is updated but the dependencies are not, so run it yourself before starting the')
    say('board.')
    stop(1)
  }
} else {
  say('No dependency changes, so nothing to install.')
}

if (sourceMoved) {
  say('')
  say('Source changed, so building.')
  try {
    npm('run', 'build')
  } catch (e) {
    say('')
    say('The build failed:')
    why(e)
    say('')
    say('The checkout is updated and the board will serve whatever it built last, which is the')
    say('"builds differ" case. Fix the build before relying on what is on screen.')
    stop(1)
  }
} else {
  say('No source changes, so nothing to build.')
}

/* --- 6. say what it means, and do not act on it --- */

say('')
if (versionBefore && versionAfter && versionBefore !== versionAfter) {
  say(`Version ${versionBefore} -> ${versionAfter}.`)
}

/*
 * A dependency change counts as much as a source change here, even though it needs no build. The
 * running server loaded the old packages when it started and goes on using them until it is
 * restarted, so "installed, no restart needed" would be a comfortable thing to print and untrue.
 */
if (sourceMoved || lockMoved) {
  say('RESTART NEEDED. The running board is still the old code.')
  say('')
  say('Press Restart server on the board, or close it and open it from the shortcut. This script')
  say('does not do it for you on purpose: restarting ends nothing on the board, but it is still')
  say('your board and your timing.')
} else {
  say('No restart needed. Nothing that is running has changed.')
}

if (toolsMoved && !sourceMoved) {
  say('')
  say('Tools changed, under scripts/ or server/bin/. Nothing running loads those, so there is')
  say('nothing to build and nothing to restart. They are read from disk the next time each runs.')
}

/*
 * The one thing this run cannot do correctly, said plainly rather than left to be discovered.
 *
 * Node had this file in memory before the merge replaced it, so everything above was carried out by
 * the version that existed BEFORE the pull. Anything added to this script arrives one run late. The
 * other PC lost time to exactly this, reporting a missing line as a bug when the line was on disk
 * and simply had not been the code that ran.
 */
const selfMoved = changed.includes('scripts/garden-update.mjs')
if (selfMoved) {
  say('')
  say('This script updated itself. What just ran was the version from before the pull, so anything')
  say('new in it takes effect on the next run rather than this one. Nothing is wrong and there is')
  say('nothing to redo.')
}

const tag = (() => {
  try {
    return git('describe', '--tags', '--exact-match', 'HEAD')
  } catch {
    return null
  }
})()
if (tag) say(`\nThis commit is tagged ${tag}.`)

say('')
stop(0)
