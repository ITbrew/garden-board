/**
 * Each message from the owner to an orchestrator carries a reminder to keep the goal ring true, and
 * nothing else does. Canon 26, "Who keeps it current".
 *
 * Runs the hook script directly with a dead port, so it touches no board and spends nothing.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'server', 'hooks', 'garden-hook.mjs')
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const fire = (role, event) => {
  const env = { ...process.env, GARDEN_PORT: '1' }
  for (const k of ['GARDEN_ROLE', 'GARDEN_LAUNCH', 'GARDEN_MAIL_DIR', 'GARDEN_SESSION_ID', 'GARDEN_OWNED_PATHS']) delete env[k]
  if (role) env.GARDEN_ROLE = role
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), env, encoding: 'utf8', timeout: 8000 })
  return { status: run.status, out: JSON.parse(run.stdout || '{}') }
}
const said = (r) => r.out?.hookSpecificOutput?.additionalContext ?? ''
const prompt = (text) => ({ hook_event_name: 'UserPromptSubmit', prompt: text })

const owner = fire('orchestrator', prompt('make the ring bigger'))
check('the hook exits cleanly', owner.status === 0, String(owner.status))
check('an owner message to an orchestrator carries the reminder', /TODO\.md/.test(said(owner)) && /goal-ring/.test(said(owner)), said(owner))
check('in the shape the CLI reads for this event', owner.out?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit')

for (const [name, text] of [
  ['one message, from a board check-in', 'A message arrived on your wires from another card, not from the owner. If it changes'],
  ['several messages', '3 messages arrived on your wires. Read your INBOX.md now.'],
  ['the older wording', 'A message arrived on one of your wires. Read your INBOX.md now.'],
  // What really reached a card on 2026-11-06: the CLI read the typing as a paste.
  ['wrapped as a paste', '\n\n<pasted_content id="36f1">\nA message arrived on your wires from another card, not from the owner.'],
]) {
  check(`mail is left out: ${name}`, said(fire('orchestrator', prompt(text))) === '')
}
check('a message that merely mentions mail still carries it', said(fire('orchestrator', prompt('why did a message arrive on your wires?'))) !== '')
check('the owner typing above a pasted notice still carries it', said(fire('orchestrator', prompt('how do i get\n\n<pasted_content id="36f1">\nA message arrived on your wires'))) !== '')
check('a worker is not reminded', said(fire('worker', prompt('do the thing'))) === '')
check('a card with no role is not reminded', said(fire(null, prompt('do the thing'))) === '')
check('other events say nothing', said(fire('orchestrator', { hook_event_name: 'Stop' })) === '')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
