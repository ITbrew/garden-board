/**
 * Refuses any test that reaches for the board the owner is using.
 *
 * `14-how-tests-are-run.md` has said since 2026-08-12 that no test touches the live board, and
 * revision 2 of it noted on 2026-08-13 that some already did. Three weeks later six still did, and
 * `scripts/run-suite.mjs` ran all six: creating projects and profiles on his board, opening his
 * documents, spawning shell sessions and tidying up afterwards by captured id, which that document
 * calls a defect in its own section. Nothing had changed because nothing could fail.
 *
 * This is the thing that fails. It is deliberately dumb: it reads the text of every test and looks
 * for the live port, because the only way to reach that board is to name it, and a check that can
 * be reasoned around is a check that will be.
 *
 *   node scripts/check-no-live-board.mjs
 *
 * Exits non-zero and names every offending file and line.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const ROOT = resolve(HERE, '..')

/*
 * Read out of the shared source rather than written here, so changing the board's port cannot leave
 * this guard watching a port nobody uses. Read with a regex rather than imported because this file
 * is plain node and that one is TypeScript, and pulling a loader in for one integer is not worth it.
 */
const shared = readFileSync(join(ROOT, 'packages', 'shared', 'src', 'index.ts'), 'utf8')
const found = shared.match(/export const DEFAULT_PORT\s*=\s*(\d+)/)
if (!found) {
  console.log('FAIL  could not find DEFAULT_PORT in packages/shared/src/index.ts, so nothing was checked.')
  process.exit(1)
}
const DEFAULT_PORT = Number(found[1])

/*
 * Comments are allowed to name the port, and several should.
 *
 * The best-isolated script in the directory, `test-created-card-can-report.mjs`, explains in its
 * header exactly which port it is avoiding and why. A check that failed on that would teach people
 * to delete the explanation rather than to fix the code, so what counts is a line of actual source.
 * Block comments in this codebase are written with a leading asterisk on every line, which is what
 * makes this cheap.
 */
function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/*
 * What counts as reaching for it: the port written next to a host, which is the only shape that
 * opens a connection, plus any use of the shared constant, which no test has a reason to import.
 *
 * Deliberately not a bare search for the number. `test-created-card-can-report.mjs` refuses to run
 * if its own port turns out to be the live one, and that refusal is a line of real code containing
 * the number. Failing the best-isolated script in the directory for saying which port it avoids
 * would teach the next person to delete the guard rather than to write one.
 */
const LIVE = new RegExp(
  `(?:127\\.0\\.0\\.1|localhost)\\s*:\\s*${DEFAULT_PORT}\\b` +
    '|\\bDEFAULT_PORT\\b' +
    '|process\\.env\\.GARDEN_PORT',
)

const offenders = []
for (const name of readdirSync(HERE).sort()) {
  if (!name.startsWith('test-') || !name.endsWith('.mjs')) continue
  const lines = readFileSync(join(HERE, name), 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (isComment(line) || !LIVE.test(line)) return
    offenders.push({ name, line: i + 1, text: line.trim() })
  })
}

if (offenders.length === 0) {
  console.log(`no test names port ${DEFAULT_PORT} in live code. ${readdirSync(HERE).filter((f) => f.startsWith('test-') && f.endsWith('.mjs')).length} files checked.`)
  process.exit(0)
}

console.log(`${offenders.length} line(s) reach for the owner's board on port ${DEFAULT_PORT}:\n`)
for (const o of offenders) console.log(`  scripts/${o.name}:${o.line}  ${o.text.slice(0, 100)}`)
console.log(`
Every test starts its own Garden instead, on a port of its own with a workspace of its own:

    import { startInstance } from './lib/instance.mjs'
    const garden = await startInstance()
    const ws = new WebSocket(\`ws://127.0.0.1:\${garden.port}/ws\`)
    ...
    await garden.stop()

For a browser test that needs cards already on the board, \`./lib/board.mjs\` does the seeding too.
See docs/canonical/14-how-tests-are-run.md.`)
process.exit(1)
