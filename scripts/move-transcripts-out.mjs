/**
 * Moves archived transcript bodies out of garden.db into gzipped files (canon 09), once.
 *
 *   npx tsx scripts/move-transcripts-out.mjs            report what would move, change nothing
 *   npx tsx scripts/move-transcripts-out.mjs --apply    move, verify each file, empty each row, VACUUM
 *
 * Optional: --db <path> --archive-dir <dir> --port <n> (defaults: the data dir's garden.db, its
 * transcript-archive folder, and 5178). A test points --db and --archive-dir at its own temp copies.
 *
 * Refuses while a board answers on the port, because VACUUM needs the database to itself and the
 * archiver could write a row mid-move. Refuses before writing anything when the drive is short of
 * room, or under the 150 GB floor the owner set for any job this size. A row is emptied only after
 * its file has been read back and matches the row exactly, so a crash at any point leaves every
 * body in at least one place.
 */
import Database from 'better-sqlite3'
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { archiveFileFor, writeArchiveFile } from '../server/src/archive.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const apply = args.includes('--apply')
const dataDir = process.env.GARDEN_HOME || join(homedir(), '.garden')
const dbPath = opt('--db', join(dataDir, 'garden.db'))
const archiveDir = opt('--archive-dir', join(dataDir, 'transcript-archive'))
const port = Number(opt('--port', '5178'))
// The owner's floor is 150 GB. Only a test over a tiny temp database passes a lower one.
const FLOOR = Number(opt('--floor-gb', '150')) * 1024 ** 3
const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`

if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(2)
}

// A board answering on its port means the server has the database open.
try {
  await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
  console.error(`a board is answering on port ${port}. Stop Garden first, then run this again.`)
  process.exit(3)
} catch {
  // nothing listening, which is what we want
}

const db = new Database(dbPath, { fileMustExist: true })
const rows = db.prepare(`SELECT id, slug, sourcePath, length(CAST(content AS BLOB)) AS n FROM transcripts WHERE content IS NOT NULL AND content <> ''`).all()
const bodyBytes = rows.reduce((t, r) => t + r.n, 0)
const dbBytes = statSync(dbPath).size
console.log(`${rows.length} rows hold ${mb(bodyBytes)} of transcript bodies in a ${mb(dbBytes)} database`)

const unmapped = rows.filter((r) => !archiveFileFor(archiveDir, r.slug, r.sourcePath))
if (unmapped.length) console.log(`${unmapped.length} rows have no archive path and will be left as they are`)

// Room: the gzipped files (never more than the bodies), plus a full copy of the database for VACUUM.
const need = bodyBytes + dbBytes
const fs = statfsSync(dirname(archiveDir) || archiveDir)
const free = fs.bavail * fs.bsize
console.log(`free on the drive: ${gb(free)}, this needs at most ${gb(need)}`)
if (free - need < FLOOR) {
  console.error(`that would leave under ${gb(FLOOR)} free. Not moving anything; ask the owner.`)
  process.exit(4)
}

if (!apply) {
  console.log('dry run: nothing changed. Run again with --apply to move.')
  process.exit(0)
}

const read = db.prepare('SELECT content FROM transcripts WHERE id = ?')
const empty = db.prepare(`UPDATE transcripts SET content = '' WHERE id = ?`)
let moved = 0
let failed = 0
for (const r of rows) {
  const file = archiveFileFor(archiveDir, r.slug, r.sourcePath)
  if (!file) continue
  const { content } = read.get(r.id)
  try {
    writeArchiveFile(file, content)
    if (gunzipSync(readFileSync(file)).toString('utf8') !== content) throw new Error('read-back differs')
  } catch (err) {
    failed++
    console.error(`kept in the database, ${r.sourcePath}: ${err.message}`)
    continue
  }
  empty.run(r.id)
  moved++
}
console.log(`moved ${moved} bodies to ${archiveDir}${failed ? `, ${failed} left in the database` : ''}`)

db.pragma('wal_checkpoint(TRUNCATE)')
console.log('VACUUM (this rewrites the database and can take a few minutes)')
db.exec('VACUUM')
db.close()
console.log(`database is now ${mb(statSync(dbPath).size)}, was ${mb(dbBytes)}`)
process.exit(failed ? 1 : 0)
