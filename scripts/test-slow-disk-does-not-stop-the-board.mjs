/**
 * Proves a stalled read leaves the server's thread free, and that the async chat read gives the same
 * answer as the old one. Canon 01. Scratch files only.
 *
 *   node --import tsx scripts/test-slow-disk-does-not-stop-the-board.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChatPage, readChatPageAsync } from '../server/src/transcript.ts'
import { readProfiles, readProfilesNow, stopProfileReader } from '../server/src/profile-reader.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'slow-disk-'))
const STALL_MS = 1500

const line = (i, role) =>
  JSON.stringify({ type: role, timestamp: '2026-01-01T00:00:00.000Z', message: { role, content: [{ type: 'text', text: `turn ${i} ${'x'.repeat(200 + (i % 7) * 40)} é` }] } })
const file = join(dir, 'conversation.jsonl')
writeFileSync(file, Array.from({ length: 400 }, (_, i) => line(i, i % 2 ? 'assistant' : 'user')).join('\n') + '\n')

/** An open that behaves like a stalled disk: each read answers late, and counts how many ran at once. */
let reads = 0
let atOnce = 0
let mostAtOnce = 0
const slowOpen = async (path) => {
  const real = await open(path, 'r')
  return {
    read: async (...args) => {
      reads++
      atOnce++
      mostAtOnce = Math.max(mostAtOnce, atOnce)
      await sleep(STALL_MS)
      atOnce--
      return real.read(...args)
    },
    close: () => real.close(),
  }
}

/** The longest the thread went without getting to run a timer, while `work` is waited on. */
async function worstLag(work) {
  let worst = 0
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 20)
    last = now
  }, 20)
  const result = await work()
  clearInterval(t)
  return { worst, result }
}

// --- same answers as the reader it replaces ---------------------------------------------------
{
  let same = true
  let before = null
  let pages = 0
  for (;;) {
    const a = readChatPage(file, before, 25)
    const b = await readChatPageAsync(file, before, 25)
    if (JSON.stringify(a) !== JSON.stringify(b)) same = false
    pages++
    if (a.atStart || pages > 100) break
    before = a.cursor
  }
  check('every page matches the old reader, down to the start of the file', same && pages > 3, `${pages} pages`)
  const missing = await readChatPageAsync(join(dir, 'nothing.jsonl'), null)
  check('a missing file gives an empty page', missing.turns.length === 0 && missing.atStart)
  const none = await readChatPageAsync(file, 0)
  check('asking before the start gives an empty page', none.turns.length === 0 && none.atStart)
}

// --- a stalled read does not hold the thread --------------------------------------------------
{
  const { worst, result } = await worstLag(() => readChatPageAsync(file, null, 60, slowOpen))
  check('the page still arrives after the stall', result.turns.length >= 60, `${result.turns.length} turns`)
  check(`the thread kept running through a ${STALL_MS} ms stall`, worst < 300, `worst gap ${Math.round(worst)} ms`)
}

// --- many requests during a stall -------------------------------------------------------------
{
  reads = 0
  mostAtOnce = 0
  const asks = Array.from({ length: 6 }, () => readChatPageAsync(file, null, 60, slowOpen))
  const pages = await Promise.all(asks)
  check('six identical requests during a stall share reads', reads <= 2, `${reads} reads`)
  check('reads of one file never overlap', mostAtOnce === 1, `${mostAtOnce} at once`)
  check('all six are answered', pages.every((p) => p.turns.length >= 60))
}

// --- a later answer is never older than an earlier one ----------------------------------------
{
  const first = readChatPageAsync(file, null, 60, slowOpen)
  await sleep(50)
  const grown = join(dir, 'conversation.jsonl')
  const second = readChatPageAsync(grown, null, 60)
  await sleep(50)
  writeFileSync(grown, line(9999, 'user') + '\n', { flag: 'a' })
  const [a, b] = await Promise.all([first, second])
  const newest = (p) => p.turns[p.turns.length - 1].text.slice(0, 9)
  check('a request made during a slow read waits and sees the newer file', newest(b) === 'turn 9999', `${newest(a)} then ${newest(b)}`)
}

// --- the account reader ------------------------------------------------------------------------
{
  const claudeDir = join(dir, 'claude-home')
  const codexDir = join(dir, 'codex-home')
  mkdirSync(claudeDir)
  mkdirSync(codexDir)
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@example.invalid', displayName: 'One', organizationName: 'Org' } }))
  const payload = Buffer.from(JSON.stringify({ email: 'two@example.invalid' })).toString('base64url')
  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }))
  const mapFile = join(dir, 'map.json')
  writeFileSync(mapFile, JSON.stringify({ roots: [{ dir: claudeDir, email: 'one@example.invalid', prefix: 'x' }] }))
  process.env.CLAUDE_ACCOUNT_MAP = mapFile

  const asked = { dataDir: dir, profiles: [{ adapterId: 'claude', configDir: claudeDir }, { adapterId: 'codex', configDir: codexDir }] }
  const reading = await readProfiles(asked)
  const expected = readProfilesNow(asked)
  check('the worker reads a Claude account', reading.identities[claudeDir]?.email === 'one@example.invalid')
  check('the worker reads a Codex account', reading.codexEmails[codexDir] === 'two@example.invalid')
  check('the worker gives the same reading as the main thread', JSON.stringify(reading) === JSON.stringify(expected))

  let busyRefused = false
  const one = readProfiles(asked)
  await readProfiles(asked).catch(() => { busyRefused = true })
  await one
  check('a second question while one is open is refused, not lost', busyRefused)
  await stopProfileReader()
  const again = await readProfiles(asked)
  check('the reader comes back after being stopped', again.codexEmails[codexDir] === 'two@example.invalid')
  await stopProfileReader()
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `FAILED: ${failures}` : 'ALL PASS')
process.exit(failures ? 1 : 0)
