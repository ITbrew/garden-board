/**
 * Proves scripts/move-transcripts-out.mjs on a scratch database and a scratch archive folder, never
 * the owner's. Port 59997 is used for the "is a board running" check so the live board on 5178 can
 * never be the one it sees. Run: npx tsx scripts/test-move-transcripts-out.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Store } from '../server/src/store.ts'
import { archiveFileFor } from '../server/src/archive.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const scratch = mkdtempSync(join(tmpdir(), 'garden-move-transcripts-'))
const dbPath = join(scratch, 'garden.db')
const archiveDir = join(scratch, 'transcript-archive')
const store = new Store(dbPath)
const body = (n) => `{"type":"user","message":"turn ${n}"}\n`.repeat(2000)
const rows = [
  { slug: 'C--Proj', sourcePath: 'C:\\Users\\u\\.claude\\projects\\C--Proj\\aaa.jsonl', content: body(1) },
  { slug: 'C--Proj', sourcePath: 'D:\\Tools\\Claude\\projects\\C--Proj\\aaa\\subagents\\agent-x.jsonl', content: body(2) },
  // A row that names no archive path stays exactly as it is.
  { slug: 'C--Other', sourcePath: 'E:\\somewhere\\else.jsonl', content: body(3) },
]
for (const r of rows) {
  store.upsertTranscript({ sessionId: null, agentId: null, sourcePath: r.sourcePath, slug: r.slug, claudeSessionId: null, bytes: r.content.length, lineCount: 2000, capturedAt: 1, content: r.content, meta: null })
}
store.checkpoint()

const run = (...extra) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['--import', 'tsx', 'scripts/move-transcripts-out.mjs', ...extra, '--db', dbPath, '--archive-dir', archiveDir, '--port', '59997', '--floor-gb', '0'], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` }
  }
}

const dry = run()
check('a dry run exits cleanly', dry.code === 0, dry.out.trim())
check('a dry run writes no files', !existsSync(archiveDir))

const huge = run('--floor-gb', '1000000')
check('a floor the drive cannot meet refuses before writing', huge.code === 4 && !existsSync(archiveDir), huge.out.trim())

// Store holds the database open in this process; the script opens its own connection, as it would
// with the server stopped.
const done = run('--apply')
check('apply exits cleanly', done.code === 0, done.out.trim())

const check2 = new Store(dbPath)
for (const r of rows.slice(0, 2)) {
  const f = archiveFileFor(archiveDir, r.slug, r.sourcePath)
  check(`file for ${r.sourcePath.split('\\').pop()} matches the old body`, !!f && existsSync(f) && gunzipSync(readFileSync(f)).toString('utf8') === r.content)
  check(`its row is now empty`, check2.getTranscriptBySource(r.sourcePath)?.content === '')
}
check('the unmapped row keeps its body', check2.getTranscriptBySource(rows[2].sourcePath)?.content === rows[2].content)

const again = run('--apply')
check('a second apply finds nothing more to move', again.code === 0 && /^1 rows/m.test(again.out), again.out.split('\n')[0])

try { rmSync(scratch, { recursive: true, force: true }) } catch { /* WAL handle on Windows */ }
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
