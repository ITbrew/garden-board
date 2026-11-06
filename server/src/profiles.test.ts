/**
 * What a config directory is signed in as, and more importantly what it is not.
 *
 * `readAccount` answers one question for the whole board: every unbound card renders
 * `{account ?? 'not signed in'}`, and that string comes from this function by way of
 * `defaultAccount` on the server. So the function has two ways to be wrong and they are not
 * equally bad. Missing an account that is really there shows a wrong chip. Reporting an account
 * that is not there is a silent false all-clear, and on 2026-09-17 it cost most of a session:
 * `~/.claude/.claude.json` had been backed up and left missing, the directory genuinely was
 * signed out, every newly hired card was launching as a first-run install and freezing on the
 * onboarding prompt, and a fallback onto the sibling `~/.claude.json` was added on the theory
 * that the chip was lying. The chip was telling the truth. The fallback was reverted the same
 * day and the comment above `readAccount` records why.
 *
 * That is why the signed-out cases come first here rather than last. The null is the board's only
 * honest signal that a config directory cannot launch a card, and every assertion below that
 * expects `null` is guarding it.
 *
 * Nothing here reads the machine it runs on. Every fixture is written into a temporary directory
 * this file creates and deletes, with an invented `oauthAccount` on an `example.invalid` address,
 * and `guard()` refuses any path that escapes that directory. A test that passed only because it
 * happened to read a real signed-in config would pass on one PC and fail on every other one, which
 * is worse than having no test at all.
 *
 * Run it on its own with `node server/src/profiles.test.ts`, or as part of `npm test`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { AccountIdentity, DiscoveredAccount } from './profiles.js'

/*
 * Imported by URL at runtime rather than by a static `from './profiles.ts'`.
 *
 * Node strips the types and runs this file directly, so the specifier it sees has to be the real
 * one, ending in `.ts`. TypeScript will not accept that spelling unless the project turns on
 * `allowImportingTsExtensions`, which it cannot while the server emits to `dist`. A dynamic
 * import is invisible to the checker, and the `ProfilesModule` annotation puts the types back by
 * hand, so `npm run typecheck` still checks every call below against the real signatures.
 */
interface ProfilesModule {
  readAccount(configDir: string): AccountIdentity | null
  defaultConfigDir(): string
  discoverAccounts(): DiscoveredAccount[]
}
const { readAccount, defaultConfigDir, discoverAccounts } = (await import(
  new URL('./profiles.ts', import.meta.url).href
)) as ProfilesModule

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

/** Two invented accounts. Neither exists, and no real address appears in this file. */
const ACCOUNT_A = {
  emailAddress: 'config-json-fixture@example.invalid',
  displayName: 'Config Json Fixture',
  organizationName: 'Fixture Org A',
}
const ACCOUNT_B = {
  emailAddress: 'claude-json-fixture@example.invalid',
  displayName: 'Claude Json Fixture',
  organizationName: 'Fixture Org B',
}
/** Written next to a signed-out directory, never inside it. Nothing may ever resolve to this. */
const SIBLING_TRAP = {
  emailAddress: 'sibling-trap@example.invalid',
  displayName: 'Sibling Trap',
  organizationName: 'Should Never Be Read',
}

const ROOT = mkdtempSync(join(tmpdir(), 'garden-profiles-'))

/*
 * The one rule this file cannot be allowed to break.
 *
 * The owner's live config is at `~/.claude.json` with the data directory `~/.claude` beside it.
 * Every path this test touches goes through here first, so a typo that points a fixture at the
 * real thing stops the run instead of quietly reading an account off this machine.
 */
function guard(path: string): string {
  const full = resolve(path)
  if (!full.toLowerCase().startsWith(resolve(ROOT).toLowerCase() + sep)) {
    throw new Error(`refusing to touch ${full}: outside the temp root ${ROOT}`)
  }
  const forbidden = resolve(homedir(), '.claude')
  if (full.toLowerCase() === forbidden.toLowerCase() || full.toLowerCase().startsWith(forbidden.toLowerCase() + sep)) {
    throw new Error(`refusing to touch the real config at ${full}`)
  }
  return full
}

/** A config directory inside the temp root, with whichever of the two candidate files are given. */
function makeDir(name: string, files: Record<string, unknown> = {}): string {
  const dir = guard(join(ROOT, name))
  mkdirSync(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(guard(join(dir, file)), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return dir
}

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedAccountMap = process.env.CLAUDE_ACCOUNT_MAP

try {
  // ---------------------------------------------------------------------------------------
  // Signed out. Written first and deliberately so: this is the group that was regressed.
  // ---------------------------------------------------------------------------------------

  const empty = makeDir('empty')
  const fromEmpty = readAccount(empty)
  check('a directory with neither candidate resolves to null', fromEmpty === null,
    `got ${JSON.stringify(fromEmpty)}`)

  /*
   * The revert, pinned.
   *
   * `signed-out.json` sits beside `signed-out/` exactly as `~/.claude.json` sits beside
   * `~/.claude/`, and it holds a perfectly good account. The CLI does not read it for that
   * directory, so neither may Garden. If somebody re-adds the sibling candidate this assertion is
   * the thing that fails, and it should fail loudly, because the last time that candidate existed
   * a signed-out machine reported itself signed in while no card on the board could start.
   */
  const trapDir = makeDir('signed-out')
  writeFileSync(guard(join(ROOT, 'signed-out.json')), JSON.stringify({ oauthAccount: SIBLING_TRAP }, null, 2))
  const trapResult = readAccount(trapDir)
  /*
   * If you are reading this because the two assertions below went red, read this paragraph before
   * you touch either of them. Null is how Garden reports a config directory that cannot launch a
   * card. A directory with no config inside it has to read as null even when a neighbouring file
   * holds a perfectly valid account, because the neighbouring file is not the one the CLI opens
   * for that directory. Something has widened the search back onto the sibling, and the effect is
   * that a machine which cannot start a single card will report itself cheerfully signed in. The
   * fix is in whatever re-added the candidate, not here.
   */
  const WHY = 'null is how Garden reports a directory that cannot launch a card, so a neighbouring file must not fill it in'
  const trapClean =
    trapResult?.email !== SIBLING_TRAP.emailAddress &&
    trapResult?.organizationName !== SIBLING_TRAP.organizationName
  check('a directory with no config inside it reads as null even when a sibling <dir>.json holds a valid account',
    trapResult === null, trapResult === null ? '' : `got ${JSON.stringify(trapResult)}. ${WHY}`)
  check('and no field of the result comes from that sibling', trapClean, trapClean ? '' : WHY)

  const missing = join(ROOT, 'does-not-exist-at-all')
  check('a directory that does not exist resolves to null', readAccount(missing) === null)

  const noAccountKey = makeDir('no-oauth-account', { '.config.json': { someOtherKey: true } })
  check('valid JSON with no oauthAccount resolves to null', readAccount(noAccountKey) === null)

  // ---------------------------------------------------------------------------------------
  // Malformed. Never a throw, never a guess.
  // ---------------------------------------------------------------------------------------

  const brokenConfig = makeDir('broken-config', { '.config.json': '{ this is not json' })
  let threw = false
  let brokenResult: AccountIdentity | null = null
  try {
    brokenResult = readAccount(brokenConfig)
  } catch {
    threw = true
  }
  check('malformed .config.json does not throw', !threw)
  check('malformed .config.json resolves to null', brokenResult === null,
    `got ${JSON.stringify(brokenResult)}`)

  const brokenBoth = makeDir('broken-both', {
    '.config.json': '{ nope',
    '.claude.json': 'also not json',
  })
  check('both candidates malformed resolves to null', readAccount(brokenBoth) === null)

  const emptyFile = makeDir('empty-file', { '.config.json': '' })
  check('an empty .config.json resolves to null', readAccount(emptyFile) === null)

  // ---------------------------------------------------------------------------------------
  // Signed in. What the function is for when everything is in place.
  // ---------------------------------------------------------------------------------------

  const configOnly = makeDir('config-only', { '.config.json': { oauthAccount: ACCOUNT_A } })
  const fromConfig = readAccount(configOnly)
  check('.config.json with an oauthAccount resolves to its email',
    fromConfig?.email === ACCOUNT_A.emailAddress, `got ${fromConfig?.email}`)
  check('.config.json carries the display name through',
    fromConfig?.displayName === ACCOUNT_A.displayName)
  check('.config.json carries the organization through',
    fromConfig?.organizationName === ACCOUNT_A.organizationName)

  const claudeOnly = makeDir('claude-only', { '.claude.json': { oauthAccount: ACCOUNT_B } })
  const fromClaude = readAccount(claudeOnly)
  check('.claude.json alone resolves to its email',
    fromClaude?.email === ACCOUNT_B.emailAddress, `got ${fromClaude?.email}`)

  /*
   * The ordering is load-bearing, which is why it is asserted against two files that disagree
   * rather than against one. Newer builds write `.config.json`, and preferring the stale
   * `.claude.json` beside it is the account guard's documented false all-clear.
   */
  const bothDisagree = makeDir('both-disagree', {
    '.config.json': { oauthAccount: ACCOUNT_A },
    '.claude.json': { oauthAccount: ACCOUNT_B },
  })
  const winner = readAccount(bothDisagree)
  check('.config.json wins when both exist and disagree',
    winner?.email === ACCOUNT_A.emailAddress, `got ${winner?.email}`)
  check('the loser account is not leaked in any field',
    winner?.displayName !== ACCOUNT_B.displayName && winner?.organizationName !== ACCOUNT_B.organizationName)

  /*
   * A partial account. The function returns an identity with a null email rather than null
   * outright, which reaches the card as `account ?? 'not signed in'` and so still renders as
   * signed out. Pinned because the distinction between "no config" and "config with no email"
   * is the sort of thing a refactor flattens without noticing.
   */
  const noEmail = makeDir('no-email', { '.config.json': { oauthAccount: { displayName: 'No Email Fixture' } } })
  const partial = readAccount(noEmail)
  check('an oauthAccount without an email returns an identity, not null', partial !== null)
  check('and its email is null rather than a guess', partial?.email === null, `got ${partial?.email}`)

  // ---------------------------------------------------------------------------------------
  // The fall-through branch: a first candidate that cannot be used, and a second that can.
  // ---------------------------------------------------------------------------------------

  /*
   * These two are pinned as current behaviour. They are not blessed as correct, and the
   * difference matters if you are here to change something.
   *
   * The second one in particular is genuinely unspecified. A malformed `.config.json` beside a
   * valid `.claude.json` resolves to the `.claude.json` account today, and nobody has established
   * that this is right:
   *
   *   - `.config.json` is what newer builds write. If it is unreadable the account may be
   *     unknowable, and answering from `.claude.json` risks a stale one. That argues for null.
   *   - On this machine the CLI reads `~/.claude/.claude.json` rather than `.config.json`. If the
   *     preferred file is garbage and the file the CLI actually uses is valid, falling through
   *     gives the right answer, and null would invent a "not signed in" for a directory that
   *     launches cards perfectly well.
   *
   * Which holds depends on which build wrote which file, and that is not known for this machine
   * let alone in general. So deciding it needs evidence about which file the CLI reads on a given
   * build, not an argument from resemblance: it resembles the sibling fallback that was reverted
   * on 2026-09-17, and resemblance is what produced that mistake in the first place. No case of it
   * has been observed in the wild.
   *
   * If you have that evidence and the answer is null, change `readAccount` and change these two
   * with it. If you do not, leave both alone. A green assertion here is a record of what the
   * function does, not a promise that it is what it should do.
   */

  const skipToClaude = makeDir('skip-to-claude', {
    '.config.json': { somethingElse: true },
    '.claude.json': { oauthAccount: ACCOUNT_B },
  })
  const skipped = readAccount(skipToClaude)
  check('a .config.json with no oauthAccount falls through to .claude.json',
    skipped?.email === ACCOUNT_B.emailAddress, `got ${skipped?.email}`)

  const brokenThenGood = makeDir('broken-then-good', {
    '.config.json': '{ broken',
    '.claude.json': { oauthAccount: ACCOUNT_B },
  })
  const afterBroken = readAccount(brokenThenGood)
  check('a malformed .config.json falls through to .claude.json (current behaviour, unspecified)',
    afterBroken?.email === ACCOUNT_B.emailAddress, `got ${afterBroken?.email}`)

  // ---------------------------------------------------------------------------------------
  // defaultConfigDir. String work only, so no file on this machine is opened.
  // ---------------------------------------------------------------------------------------

  const override = makeDir('override-dir')
  process.env.CLAUDE_CONFIG_DIR = override
  check('defaultConfigDir honours CLAUDE_CONFIG_DIR', defaultConfigDir() === override)

  delete process.env.CLAUDE_CONFIG_DIR
  const fallback = defaultConfigDir()
  check('without the override it is the .claude directory in the home directory',
    fallback === join(homedir(), '.claude'))
  /*
   * The one shape the default must not have. `~/.claude.json` is a real file on most installs and
   * it is not what this returns; `readAccount` is handed the directory, and the sibling is out of
   * its reach by construction. Comparing two strings, opening nothing.
   */
  check('the default is the directory and not the sibling json file',
    !fallback.toLowerCase().endsWith('.json'))

  // ---------------------------------------------------------------------------------------
  // discoverAccounts. It calls readAccount per directory, so the honesty rule has to survive
  // the trip through the account map.
  // ---------------------------------------------------------------------------------------

  /*
   * CLAUDE_CONFIG_DIR stays pointed inside the temp root for all of this. `discoverAccounts`
   * finishes by pushing the default config directory, and without the override that would be the
   * owner's real `~/.claude` and this test would read his machine.
   */
  const signedIn = makeDir('map-signed-in', { '.config.json': { oauthAccount: ACCOUNT_A } })
  const signedOut = makeDir('map-signed-out')
  process.env.CLAUDE_CONFIG_DIR = signedOut

  const mapPath = guard(join(ROOT, 'account-map.json'))
  writeFileSync(mapPath, JSON.stringify({
    roots: [
      { dir: signedIn, email: ACCOUNT_A.emailAddress, prefix: join(ROOT, 'work') },
      // The same directory again under a second root. Its prefix must be kept, not dropped.
      { dir: signedIn, email: ACCOUNT_A.emailAddress, prefix: join(ROOT, 'garden') },
      // A directory that is listed but signed out. It must be discovered and still report null.
      { dir: signedOut, email: 'declared-but-not-signed-in@example.invalid', prefix: join(ROOT, 'other') },
      // A directory the map names that does not exist. Nothing to discover.
      { dir: join(ROOT, 'map-missing'), email: 'gone@example.invalid', prefix: join(ROOT, 'gone') },
    ],
  }, null, 2))
  process.env.CLAUDE_ACCOUNT_MAP = mapPath

  const found = discoverAccounts()
  const inEntry = found.find((a) => a.configDir === signedIn)
  const outEntry = found.find((a) => a.configDir === signedOut)
  check('a signed-in directory in the map is discovered', !!inEntry)
  check('and its identity comes from its own config file',
    inEntry?.identity?.email === ACCOUNT_A.emailAddress, `got ${inEntry?.identity?.email}`)
  check('one entry per directory even when two roots name it',
    found.filter((a) => a.configDir === signedIn).length === 1)
  check('both prefixes of that directory are kept', inEntry?.prefixes.length === 2,
    `got ${JSON.stringify(inEntry?.prefixes)}`)

  /*
   * The map is a declaration, not evidence. This directory has no config file in it, so whatever
   * the map claims, the identity has to be null. A declared email promoted into an identity would
   * be the same false all-clear the sibling fallback was, arriving by a different road.
   */
  check('a signed-out directory is discovered rather than dropped', !!outEntry)
  check('a declared email is never promoted into an identity', outEntry?.identity === null,
    `got ${JSON.stringify(outEntry?.identity)}`)
  check('the declared email is still reported as declared',
    outEntry?.declaredEmail === 'declared-but-not-signed-in@example.invalid')
  check('a directory in the map that does not exist is not discovered',
    !found.some((a) => a.configDir === join(ROOT, 'map-missing')))

  /* No map at all. Nothing to discover but the directory in use, and no account invented. */
  process.env.CLAUDE_ACCOUNT_MAP = join(ROOT, 'no-such-map.json')
  const bare = discoverAccounts()
  check('an absent account map discovers only the directory in use',
    bare.length === 1 && bare[0].configDir === signedOut, `got ${JSON.stringify(bare.map((a) => a.configDir))}`)
  check('and that directory, being signed out, reports no identity', bare[0]?.identity === null)
} finally {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedAccountMap === undefined) delete process.env.CLAUDE_ACCOUNT_MAP
  else process.env.CLAUDE_ACCOUNT_MAP = savedAccountMap
  // Only ever the directory this file made, and it made all of it.
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
