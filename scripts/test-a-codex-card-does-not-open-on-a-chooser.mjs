/**
 * Proves a Codex card is launched with both of its startup choosers already answered.
 *
 * Canon 12 holds the rule and canon 03 holds the incident: anything that would stop a card to ask a
 * human must be settled before the card starts. A Codex card that opens on a chooser is not slow,
 * it is stuck, it reads as idle on the board, and what gets sent to it goes into the chooser instead
 * of into a prompt. A card sent "reply with the single word: ok" answered with a PowerShell
 * CommandNotFoundException for the tail of that line.
 *
 * Checked at the command line and at the file it writes, rather than by starting a real CLI, the
 * same choice `test-codex-is-told-it-is-on-a-board.mjs` makes and for the same reason: a Codex
 * session costs a turn. That the result works against the real CLI was measured separately by
 * `scripts/_codex-trust-probe.mjs`, which reproduces the chooser in about twenty seconds, takes the
 * folder to launch in, and reports whether the prompt was reached beside whether the question
 * appeared.
 *
 * **Every assertion about a PATH SHAPE is here because a shape was missed.** The trust answer
 * shipped twice on the command line and worked both times only in `C:\Garden`, which has no space
 * and no dot in its name. `-c` takes a bare dotted key and nothing else, so a dot splits the key and
 * a space splits the argument, and on a space the CLI exits and the shell behind it drops to a
 * prompt, which is the original failure this all exists to prevent. Canon 03 revision 10. So the
 * cases below are a folder with a space AND a dot, a forward-slash path, and a file this did not
 * write.
 */
import { pathToFileURL } from 'node:url'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { codexAdapter } = await import(pathToFileURL(join(ROOT, 'server', 'dist', 'adapters.js')).href)

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

if (process.platform !== 'win32') {
  console.log('SKIP  both overrides are Windows-only, and this machine is not Windows')
  process.exit(0)
}

/**
 * The one string the adapter hands PowerShell, plus the file it writes on the way.
 *
 * `home` is a scratch directory passed as `CODEX_HOME`, so nothing here ever reaches the owner's own
 * `~/.codex`. The adapter writes its trust file into whichever config home the card will use, and
 * this is that home.
 */
const commandFor = (cwd, quiet, home) => {
  const beforeQuiet = process.env.GARDEN_CODEX_QUIET
  const beforeBrief = process.env.GARDEN_CODEX_BRIEF
  process.env.GARDEN_CODEX_BRIEF = '0'
  if (quiet === undefined) delete process.env.GARDEN_CODEX_QUIET
  else process.env.GARDEN_CODEX_QUIET = quiet
  try {
    return codexAdapter.launch(cwd, null, { GARDEN_CARD: 'Probe', CODEX_HOME: home }).args.join(' ')
  } finally {
    if (beforeQuiet === undefined) delete process.env.GARDEN_CODEX_QUIET
    else process.env.GARDEN_CODEX_QUIET = beforeQuiet
    if (beforeBrief === undefined) delete process.env.GARDEN_CODEX_BRIEF
    else process.env.GARDEN_CODEX_BRIEF = beforeBrief
  }
}

const scratch = () => mkdtempSync(join(tmpdir(), 'garden-trust-'))
const written = (home) => {
  const f = join(home, 'garden.config.toml')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

const HOME = scratch()
const cmd = commandFor('C:\\Garden', undefined, HOME)
console.log('   ' + cmd)
console.log('   ' + written(HOME).replace(/\n/g, ' | ') + '\n')

check('the update chooser is answered', cmd.includes('check_for_update_on_startup=false'))

/*
 * A layered profile, not a `-c` override, and the second check is the one that would catch a
 * regression back to the old shape. `-p <name>` loads `$CODEX_HOME/<name>.config.toml` on top of
 * the base config, so no shell ever parses the path.
 */
check('the trust chooser is answered by a layered profile', / -p garden\b/.test(cmd))
check('no trust key is on the command line at all', !cmd.includes('trust_level'), cmd)

check('it wrote the profile file', written(HOME) !== '')
check(
  'the path is lowercased, the way the CLI writes its own',
  written(HOME).includes("[projects.'c:\\garden']"),
  written(HOME).replace(/\n/g, ' | '),
)
check('it says trusted', written(HOME).includes('trust_level = "trusted"'))

/*
 * The shape that broke both command-line versions, and the reason this mechanism is a file. A dot
 * splits a bare `-c` key; a space splits the argument and makes the CLI exit. In a TOML literal
 * string in a file, both are ordinary characters.
 */
const SPACED = scratch()
const spaced = commandFor('C:\\gtest 0.5 stable', undefined, SPACED)
check('a path with a space and a dot still gets the flag', / -p garden\b/.test(spaced))
check(
  'and it lands in the file intact',
  written(SPACED).includes("[projects.'c:\\gtest 0.5 stable']"),
  written(SPACED).replace(/\n/g, ' | '),
)

/*
 * A forward-slash cwd is what a project added from the board carries, and the CLI compares against a
 * Windows path. `codexWritable` normalises one function above for the same reason.
 */
const FWD = scratch()
commandFor('C:/Garden/docs', undefined, FWD)
check(
  'a forward-slash path is normalised to backslashes',
  written(FWD).includes("[projects.'c:\\garden\\docs']"),
  written(FWD).replace(/\n/g, ' | '),
)

/*
 * Added to, never replaced. Two Codex cards on two boards share a config home whenever neither has
 * an account bound, so writing only the current folder erased the other board's answer, silently
 * and only visibly on the launch after next. Found with a probe's scratch folder sitting alone in
 * the owner's own file.
 */
const BOTH = scratch()
commandFor('C:\\Alpha', undefined, BOTH)
commandFor('C:\\Beta project', undefined, BOTH)
const both = () => written(BOTH).replace(/\n/g, ' | ')
check('a second folder is added', written(BOTH).includes("[projects.'c:\\beta project']"), both())
check('and the first one is still there', written(BOTH).includes("[projects.'c:\\alpha']"), both())
check('the marker is written once, not once per entry', written(BOTH).split('written by Garden').length === 2)
const twice = written(BOTH)
commandFor('C:\\Alpha', undefined, BOTH)
check('launching the same folder again changes nothing', written(BOTH) === twice)

/*
 * The rule that matters most, because an unbound card's config home is the owner's own `~/.codex`.
 * A `garden.config.toml` Garden did not write is left exactly as it is, and the card launches
 * without the flag, which puts it on the chooser rather than over somebody else's file.
 */
const THEIRS = scratch()
const mine = "[projects.'c:\\somewhere']\ntrust_level = \"trusted\"\n"
writeFileSync(join(THEIRS, 'garden.config.toml'), mine, 'utf8')
const overTheirs = commandFor('C:\\Garden', undefined, THEIRS)
check('a profile file Garden did not write is not overwritten', written(THEIRS) === mine)
check('and the card launches without the flag rather than over it', !/ -p garden\b/.test(overTheirs))

/*
 * A path holding a single quote cannot go in a TOML literal string and is skipped rather than
 * escaped, the same rule `codexWritable` uses: the card asks the trust question rather than Garden
 * guessing at an escaping nothing has tested.
 */
const QUOTED = scratch()
const quoted = commandFor("C:\\Bob's Folder", undefined, QUOTED)
check('a path holding a single quote is skipped, not escaped', !/ -p garden\b/.test(quoted))
check('and no file is written for it', written(QUOTED) === '')

/*
 * One switch for both choosers, because they exist for the same reason and a card being debugged
 * wants the CLI's own unmodified startup.
 */
const OFF = scratch()
const off = commandFor('C:\\Garden', '0', OFF)
check('GARDEN_CODEX_QUIET=0 removes the trust profile', !off.includes('-p garden'))
check('GARDEN_CODEX_QUIET=0 writes no file either', written(OFF) === '')
check('GARDEN_CODEX_QUIET=0 removes the update override', !off.includes('check_for_update_on_startup'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
