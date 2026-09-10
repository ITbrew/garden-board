/**
 * Proves a Codex card is told who it is wired to, because nothing else ever tells it.
 *
 * The failure, read out of the owner's own board on 2026-08-15. He wired a Codex card to his
 * orchestrator, asked it to send a message, and it answered in its terminal:
 *
 *   I tried again, but this session still exposes no Wire messaging endpoint or orchestrator
 *   recipient. Nothing was sent, and I won't claim otherwise.
 *
 * That is the right answer to what it could see. Garden had written its PEERS.md naming the
 * orchestrator, its POWERS.md and its outbox, and drawn a two-way wire on the board, and had never
 * mentioned any of it to the session. A Claude card learns all of this from the SessionStart hook.
 * Codex has no hooks, so it learned nothing.
 *
 * Checked at the command line rather than by running a session, because a Codex prompt costs a turn
 * and what is being tested is whether Garden says anything at all. `test-codex-and-claude-share-a-wire`
 * covers the delivery itself and runs with the brief switched off so it stays free.
 */
import { pathToFileURL } from 'node:url'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { codexAdapter, claudeAdapter } = await import(
  pathToFileURL(join(ROOT, 'server', 'dist', 'adapters.js')).href
)

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// Fixture paths, never opened. What is under test is the command line the adapter builds from them.
const MAIL = 'C:\\Users\\owner\\.garden\\mail\\card-0001'
const env = { GARDEN_MAIL_DIR: MAIL, GARDEN_CARD: 'Assistant', GARDEN_SESSION_ID: 'card-0001' }
const commandFor = (extra, opts = {}) => {
  const before = process.env.GARDEN_CODEX_BRIEF
  if (opts.brief === false) process.env.GARDEN_CODEX_BRIEF = '0'
  else delete process.env.GARDEN_CODEX_BRIEF
  const args = codexAdapter.launch('C:\\Work\\App\\1.0', null, extra).args
  if (before === undefined) delete process.env.GARDEN_CODEX_BRIEF
  else process.env.GARDEN_CODEX_BRIEF = before
  return args[args.length - 1]
}

const cmd = commandFor(env)

check('a codex card is given something to read on the way up', cmd !== 'codex', cmd.slice(0, 70) + '…')
check(
  'and it is pointed at its own mailbox, not a general one',
  cmd.includes(MAIL.replace(/\\/g, '/')),
  MAIL.replace(/\\/g, '/'),
)
check('it names the file that lists who it may talk to', cmd.includes('PEERS.md'))
check('and the file where messages to it arrive', cmd.includes('INBOX.md'))
check('and it says which card it is', cmd.includes('Assistant'))

/*
 * The quoting, which is the way this breaks silently rather than loudly.
 *
 * The prompt travels inside a single-quoted PowerShell string. An apostrophe in it closes that
 * string early and the rest of the sentence arrives as commands, which is the same failure the send
 * shim carries three paragraphs about. So the text must not contain one, and that is a property of
 * the text rather than something a caller can be trusted to remember.
 */
const quoted = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"))
check(
  'the brief carries no quote that would end its own string',
  !quoted.includes("'") && !quoted.includes('"'),
  quoted.length ? `${quoted.length} characters, none of them a quote` : '(nothing quoted)',
)

check(
  'a card with no mailbox is launched plain rather than with a broken pointer',
  commandFor({}) === 'codex',
  commandFor({}),
)
check(
  'and GARDEN_CODEX_BRIEF=0 starts one silently, so a harness spends nothing',
  commandFor(env, { brief: false }) === 'codex',
  commandFor(env, { brief: false }),
)

/*
 * Claude is untouched by any of this. Its briefing goes through the hook and the flags it already
 * had, and a change made for one adapter that quietly alters another is how this file's own subject
 * came about.
 */
check(
  'a claude card still launches the way it did',
  !claudeAdapter.launch('C:\\Garden', null, env).args.join(' ').includes('PEERS.md'),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
