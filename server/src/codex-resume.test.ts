import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Its own data directory, so nothing here can read the live board's setup or write near it.
const scratch = mkdtempSync(join(tmpdir(), 'garden-codex-resume-'))
process.env.GARDEN_HOME = join(scratch, 'garden')
const { conversationFor, findCodexConversation } = await import('./codex-resume.js')
const { codexAdapter } = await import('./adapters.js')

const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** A conversation file shaped like Codex 0.165's: one long session_meta line, then the turns. */
function rollout(home: string, day: string, time: string, id: string, roots: string[], source: unknown = 'cli', threadSource = 'user') {
  const [y, m, d] = day.split('-')
  const dir = join(home, 'sessions', y!, m!, d!)
  mkdirSync(dir, { recursive: true })
  const meta = {
    timestamp: `${day}T00:00:00.000Z`,
    type: 'session_meta',
    payload: { id, session_id: id, cwd: roots[0], runtime_workspace_roots: roots, originator: 'codex-tui', source, thread_source: threadSource, base_instructions: { text: 'x'.repeat(23_000) } },
  }
  writeFileSync(join(dir, `rollout-${day}T${time}-${id}.jsonl`), `${JSON.stringify(meta)}\n{"type":"turn"}\n`, 'utf8')
}

const roots = (card: string, drive = 'E:') => [`${drive}\\Work\\Game.1`, `${drive}\\Data\\.garden\\mail\\${card}`, `${drive}\\Work\\Game.1\\.claude\\sessions`]

test('finds the newest conversation naming this card, skipping other cards and subagents', () => {
  const home = join(scratch, 'home-a')
  rollout(home, '2026-10-28', '18-30-17', '01a18510-8fe3-7922-b7ce-0242f25b181b', roots(CARD))
  rollout(home, '2026-10-29', '09-00-00', '01a18600-0000-7000-8000-000000000001', roots(CARD))
  // Later than the card's own, but another card's mailbox.
  rollout(home, '2026-10-30', '10-00-00', '01a18700-0000-7000-8000-000000000002', roots(OTHER))
  // Later still, the card's mailbox, but a helper Codex spawned inside the card.
  rollout(home, '2026-10-30', '11-00-00', '01a18700-0000-7000-8000-000000000003', roots(CARD), { subagent: { thread_spawn: { parent_thread_id: 'x' } } }, 'subagent')
  assert.equal(findCodexConversation(home, CARD), '01a18600-0000-7000-8000-000000000001')
  assert.equal(findCodexConversation(home, OTHER), '01a18700-0000-7000-8000-000000000002')
})

test('within one day the latest start wins, and a mailbox under another drive still matches', () => {
  const home = join(scratch, 'home-b')
  rollout(home, '2026-11-01', '03-58-04', '01a19000-0000-7000-8000-000000000001', roots(CARD, 'C:'))
  rollout(home, '2026-11-01', '03-58-31', '01a19000-0000-7000-8000-000000000002', roots(CARD.toUpperCase()))
  assert.equal(findCodexConversation(home, CARD), '01a19000-0000-7000-8000-000000000002')
})

test('nothing found, a missing home, a broken first line and the day limit all mean start fresh', () => {
  assert.equal(findCodexConversation(join(scratch, 'no-such-home'), CARD), null)
  const home = join(scratch, 'home-c')
  mkdirSync(join(home, 'sessions', '2026', '11', '01'), { recursive: true })
  const broken = join(home, 'sessions', '2026', '11', '01', 'rollout-2026-11-01T01-00-00-01a19000-0000-7000-8000-000000000009.jsonl')
  writeFileSync(broken, '{"type":"session_meta","payload":', 'utf8')
  assert.equal(conversationFor(broken, CARD), null)
  rollout(home, '2026-09-01', '01-00-00', '01a10000-0000-7000-8000-00000000000a', roots(CARD))
  rollout(home, '2026-10-31', '01-00-00', '01a19000-0000-7000-8000-00000000000b', roots(OTHER))
  // Two day folders hold nothing of this card; a limit of two never reaches September.
  assert.equal(findCodexConversation(home, CARD, 2), null)
  assert.equal(findCodexConversation(home, CARD), '01a10000-0000-7000-8000-00000000000a')
})

test('a Codex card with an id resumes it with the same flags and without the brief', () => {
  const profile = { id: 'p', configDir: join(scratch, 'profile-home') } as unknown as Parameters<typeof codexAdapter.launch>[1]
  const env = { GARDEN_MAIL_DIR: `D:\\Data\\.garden\\mail\\${CARD}`, GARDEN_CARD: 'Some Card' }
  const fresh = codexAdapter.launch('D:\\Work\\Game.1', profile, env).args.join(' ')
  const resumed = codexAdapter.launch('D:\\Work\\Game.1', profile, { ...env, GARDEN_RESUME: '01a19000-0000-7000-8000-000000000002' }).args.join(' ')
  if (process.platform !== 'win32') return
  assert.match(resumed, /codex resume .* 01a19000-0000-7000-8000-000000000002/)
  // Every flag a new start gets is still there, in the same order, and nothing else is added.
  const freshFlags = fresh.slice(fresh.indexOf('codex ') + 'codex'.length)
  const resumedFlags = resumed.slice(resumed.indexOf('codex resume') + 'codex resume'.length).replace(/ 01a19000-0000-7000-8000-000000000002$/, '')
  assert.ok(freshFlags.startsWith(resumedFlags), `resume flags ${resumedFlags} are not the start of ${freshFlags}`)
  assert.ok(freshFlags.length > resumedFlags.length, 'a new start carries the brief and a resume does not')
  // An id that is not an id is never placed on the command line.
  const refused = codexAdapter.launch('D:\\Work\\Game.1', profile, { ...env, GARDEN_RESUME: "x'; Remove-Item C:\\" }).args.join(' ')
  assert.doesNotMatch(refused, /codex resume|Remove-Item/)
})

test.after(() => rmSync(scratch, { recursive: true, force: true }))
