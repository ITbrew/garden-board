/**
 * Canon 29: Garden runs as one account.
 *
 * Every fixture is written into a temporary directory this file creates and deletes, with invented
 * `example.invalid` addresses. Nothing here reads the machine it runs on.
 *
 * Run with `npx tsx server/src/accounts.test.ts`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as readF } from 'node:fs'
import { accountRefusal, readAccountRule, readCodexEmail, trustFolders } from './accounts.js'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const ROOT = mkdtempSync(join(tmpdir(), 'garden-accounts-'))
const ALLOWED = 'garden-fixture@example.invalid'
const OTHER = 'other-fixture@example.invalid'

function claudeDir(name: string, email: string | null) {
  const d = join(ROOT, name)
  mkdirSync(d, { recursive: true })
  if (email) writeFileSync(join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return d
}
function codexDir(name: string, auth: unknown) {
  const d = join(ROOT, name)
  mkdirSync(d, { recursive: true })
  if (auth !== undefined) writeFileSync(join(d, 'auth.json'), JSON.stringify(auth))
  return d
}
function idToken(claims: object) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

try {
  // The rule file.
  const noRule = join(ROOT, 'no-rule')
  mkdirSync(noRule)
  check('no accounts.json means no rule', readAccountRule(noRule) === null)

  const broken = join(ROOT, 'broken-rule')
  mkdirSync(broken)
  writeFileSync(join(broken, 'accounts.json'), '{ not json')
  const brokenRule = readAccountRule(broken)
  check('an unreadable rule allows nothing rather than everything', !!brokenRule && brokenRule.allowed.length === 0)

  const dataDir = join(ROOT, 'data')
  mkdirSync(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ allowed: ['Garden-Fixture@Example.invalid'], claude: 'x', codex: 'y' }))
  const rule = readAccountRule(dataDir)!
  check('allowed emails are compared without case', rule.allowed[0] === ALLOWED)

  // Claude.
  check('claude on the allowed account starts', accountRefusal(rule, 'claude', claudeDir('c-ok', ALLOWED)) === null)
  check('claude on another account is refused', /not Garden's account/.test(accountRefusal(rule, 'claude', claudeDir('c-other', OTHER)) ?? ''))
  check('claude signed out is refused', /not signed in/.test(accountRefusal(rule, 'claude', claudeDir('c-out', null)) ?? ''))
  check('claude with no Garden directory is refused', /no Garden account directory/.test(accountRefusal(rule, 'claude', null) ?? ''))

  // Codex: only the email claim of the identity token.
  const okHome = codexDir('x-ok', { tokens: { id_token: idToken({ email: ALLOWED }), access_token: 'secret' } })
  check('codex email is read from the identity token', readCodexEmail(okHome) === ALLOWED)
  check('codex on the allowed account starts', accountRefusal(rule, 'codex', okHome) === null)
  const otherHome = codexDir('x-other', { tokens: { id_token: idToken({ email: OTHER }) } })
  check('codex on another account is refused', /not Garden's account/.test(accountRefusal(rule, 'codex', otherHome) ?? ''))
  // An API-key sign-in, with a placeholder where the key would be.
  const keyField = 'OPENAI_API_KEY'
  const keyHome = codexDir('x-key', { [keyField]: 'placeholder' })
  check('codex on an API key has no email and is refused', /not signed in/.test(accountRefusal(rule, 'codex', keyHome) ?? ''))
  check('codex with no auth.json is refused', /not signed in/.test(accountRefusal(rule, 'codex', codexDir('x-none', undefined)) ?? ''))
  const refusalText = accountRefusal(rule, 'codex', otherHome) ?? ''
  check('a refusal never carries the token', !refusalText.includes(idToken({ email: OTHER }).split('.')[1]!))

  // Folder trust in Garden's own directory.
  const signedOut = claudeDir('t-out', null)
  check('trust is never written into a signed-out directory', trustFolders(signedOut, ['C:\\A']) === 0)
  const signedIn = claudeDir('t-in', ALLOWED)
  check('trust is added for each folder', trustFolders(signedIn, ['C:\\Proj One', 'E:/Two']) === 2)
  const after = JSON.parse(readF(join(signedIn, '.claude.json'), 'utf8'))
  check('keys use forward slashes, as the CLI writes them', after.projects['C:/Proj One']?.hasTrustDialogAccepted === true)
  check('the account is kept', after.oauthAccount?.emailAddress === ALLOWED)
  check('a folder already trusted is left alone', trustFolders(signedIn, ['E:/Two']) === 0)

  // Shell cards and machines with no rule.
  check('a shell card is never refused', accountRefusal(rule, 'shell', null) === null)
  check('with no rule nothing is refused', accountRefusal(null, 'claude', claudeDir('c-any', OTHER)) === null)
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
