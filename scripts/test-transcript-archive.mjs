/**
 * Proves the transcript archiver against a scratch fixture, never the owner's real
 * ~/.claude/projects tree. Run with `npx tsx scripts/test-transcript-archive.mjs` from the repo
 * root, since it imports the archiver and store straight out of server/src rather than talking
 * to a running server.
 *
 * Covers: a new file gets archived, a second run over the same tree is a no-op, a file that grew
 * since the last run is re-copied, an oversized file is skipped and reported rather than silently
 * dropped, and the stored content matches the source byte for byte.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../server/src/store.ts'
import { scanTranscripts, archiveOnce } from '../server/src/archive.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const root = mkdtempSync(join(tmpdir(), 'garden-transcripts-'))
const dbPath = join(mkdtempSync(join(tmpdir(), 'garden-archive-db-')), 'test.db')

// --- fixture tree, shaped like ~/.claude/projects ---

const slugDir = join(root, 'C--Some-Project')
mkdirSync(slugDir, { recursive: true })

const sessionId = '11111111-1111-1111-1111-111111111111'
const sessionTranscript = join(slugDir, `${sessionId}.jsonl`)
writeFileSync(sessionTranscript, '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}\n')

const subDir = join(slugDir, sessionId, 'subagents')
mkdirSync(subDir, { recursive: true })
const agentId = 'a1b2c3'
const agentTranscript = join(subDir, `agent-${agentId}.jsonl`)
writeFileSync(agentTranscript, '{"type":"user","message":"go audit the widget"}\n')
writeFileSync(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'audit the widget', spawnDepth: 1 }))

const oversizedTranscript = join(slugDir, 'ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl')
writeFileSync(oversizedTranscript, 'x'.repeat(1024))

// --- scan ---

const scanned = scanTranscripts(root)
check('finds the session transcript', scanned.some((f) => f.absPath === sessionTranscript))
check('finds the subagent transcript', scanned.some((f) => f.absPath === agentTranscript))
const agentFile = scanned.find((f) => f.absPath === agentTranscript)
check('subagent file carries its agent id', agentFile?.agentId === agentId, String(agentFile?.agentId))
check('subagent file carries its parent session id', agentFile?.claudeSessionId === sessionId, String(agentFile?.claudeSessionId))
check('meta.json siblings are not themselves picked up as transcripts',
  !scanned.some((f) => f.absPath.endsWith('.meta.json')))

// --- archive: first run ---

const store = new Store(dbPath)
const first = archiveOnce(store, { root, maxBytes: 512, slugs: null })
check('two real transcripts are added on first run', first.added === 2, String(first.added))
check('the oversized file is skipped, not archived', first.oversized.includes(oversizedTranscript), JSON.stringify(first.oversized))
check('the oversized file is counted among skipped', first.skipped >= 1, String(first.skipped))

const storedSession = store.getTranscriptBySource(sessionTranscript)
check('the session transcript is retrievable by source path', !!storedSession)
check('archived content matches the source file byte for byte',
  storedSession?.content === '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}\n')

const storedAgent = store.getTranscriptBySource(agentTranscript)
check('the subagent row keeps its agent id', storedAgent?.agentId === agentId, String(storedAgent?.agentId))
check('the subagent row keeps its meta.json', !!storedAgent?.meta?.includes('Explore'), storedAgent?.meta)

const stats = store.transcriptStats()
check('stats count the two archived files', stats.count === 2, String(stats.count))

// --- archive: second run is a no-op ---

const second = archiveOnce(store, { root, maxBytes: 512, slugs: null })
check('a second run over an unchanged tree adds nothing', second.added === 0, String(second.added))
check('a second run over an unchanged tree skips what it already has', second.skipped >= 2, String(second.skipped))

// --- a transcript that grows gets re-archived ---

writeFileSync(sessionTranscript, '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}\n{"type":"user","message":"more"}\n')
const third = archiveOnce(store, { root, maxBytes: 512, slugs: null })
check('a grown transcript is re-archived', third.added === 1, String(third.added))
const grownRow = store.getTranscriptBySource(sessionTranscript)
check('the re-archived content reflects the growth', grownRow?.content?.includes('more'))

// --- listing ---

const listed = store.listTranscripts(10)
check('listTranscripts returns what was archived', listed.length === 2, String(listed.length))
check('listTranscripts leaves the raw content out', !('content' in (listed[0] ?? {})))

// --- the project filter: only what the board knows about is archived ---
//
// Garden used to walk all of ~/.claude/projects and copy every transcript it found, so an app for
// this repo ended up holding 3.7 GB of the owner's unrelated work. These assertions are the reason
// that cannot come back.

const outsiderDir = join(root, 'C--Not-On-The-Board')
mkdirSync(outsiderDir, { recursive: true })
const outsider = join(outsiderDir, '22222222-2222-2222-2222-222222222222.jsonl')
writeFileSync(outsider, '{"type":"user","message":"someone else\'s project"}\n')

const db2 = join(mkdtempSync(join(tmpdir(), 'garden-archive-db2-')), 'test.db')
const store2 = new Store(db2)

// The derived set, on a board that knows about nothing at all.
const empty = archiveOnce(store2, { root, maxBytes: 512 })
check('a board with no projects archives nothing', empty.added === 0, String(empty.added))
check('and reports the untouched files as skipped', empty.skipped >= 3, String(empty.skipped))
check('nothing from an unlisted project was stored', !store2.getTranscriptBySource(outsider))

// An explicit allow list naming only the fixture's own slug.
const scoped = archiveOnce(store2, { root, maxBytes: 512, slugs: new Set(['C--Some-Project']) })
check('an allowed slug is archived', scoped.added === 2, String(scoped.added))
check('a slug outside the allow list is still not archived', !store2.getTranscriptBySource(outsider))
check('the allowed project did get through', !!store2.getTranscriptBySource(sessionTranscript))

// The slug mapping is lossy, so the check must be equality and never a prefix.
const prefixTrap = archiveOnce(store2, { root, maxBytes: 512, slugs: new Set(['C--Not']) })
check('a slug is not matched by prefix', prefixTrap.added === 0, String(prefixTrap.added))
check('the prefix trap left the outsider alone', !store2.getTranscriptBySource(outsider))

// --- cleanup: this is a scratch fixture and a scratch db, never the owner's real ones ---
// better-sqlite3 holds its WAL file open on Windows with no close() exposed on Store, so a
// leftover temp db directory here is a harmless quirk of this test script, not a real failure.

rmSync(root, { recursive: true, force: true })
try {
  rmSync(join(dbPath, '..'), { recursive: true, force: true })
} catch {
  // still locked by the WAL handle; the OS temp dir will reclaim it eventually.
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
