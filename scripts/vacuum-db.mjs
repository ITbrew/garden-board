/**
 * Rewrite garden.db so deleted rows actually leave the file.
 *
 * SQLite does not shrink on DELETE. It unlinks rows and keeps their bytes in the file's free pages,
 * where they stay readable until the file is rewritten. That is normally just wasted disk. On
 * 2026-09-08 it was more than that: 3,336 archived transcripts were deleted, 497 of them copied out
 * from a project the board had been told to stay out of entirely, and until this
 * runs those bytes are still sitting on the drive.
 *
 * VACUUM needs exclusive access, so this REFUSES to run while the server is up rather than
 * competing with it. That is not caution for its own sake: a large write against the live database
 * takes a lock the server needs, and doing exactly that made the owner's board go unresponsive
 * earlier the same evening.
 *
 *   1. Close Garden.
 *   2. node C:\Garden\scripts\vacuum-db.mjs
 *   3. Open Garden from the shortcut again.
 *
 * Expect several minutes on a multi-gigabyte file, and roughly the file's own size in free space
 * while it works, because VACUUM builds the new copy before replacing the old one.
 */
import Database from 'better-sqlite3'
import { statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB = process.env.GARDEN_DB || join(homedir(), '.garden', 'garden.db')
const PORT = Number(process.env.GARDEN_PORT) || 5178
const mb = (b) => (b / 1048576).toFixed(0)

/** Whether something is listening, which here means Garden is still open. */
const serverUp = () =>
  new Promise((done) => {
    const probe = connect({ port: PORT, host: '127.0.0.1' })
    probe.setTimeout(1500)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(false)
    })
    probe.on('error', () => done(false))
  })

if (await serverUp()) {
  console.log(`Garden is still running on port ${PORT}.`)
  console.log('Close Garden first, then run this again. Nothing has been changed.')
  process.exit(1)
}

const before = statSync(DB).size
console.log(`${DB}`)
console.log(`size before: ${mb(before)} MB`)

const db = new Database(DB)
console.log(`free pages before: ${db.pragma('freelist_count')[0].freelist_count}`)

/*
 * Said plainly, because the alternative is what happened to the owner the first time he ran this:
 * "couldnt tell if it was done or not". VACUUM is one synchronous call, so nothing can report
 * progress from inside this process while it runs, and a window that prints a line and then sits
 * still for several minutes is indistinguishable from a window that has hung. No invented ETA: the
 * size is a fact and the rate on this machine is not one I have measured.
 */
console.log('')
console.log(`Rewriting ${mb(before)} MB. This runs in one uninterruptible step, so nothing will`)
console.log('print and the window will look frozen until it finishes. That is normal. Do not')
console.log('close it: the next line it prints is the result.')
const started = Date.now()
db.exec('VACUUM')
const seconds = Math.round((Date.now() - started) / 1000)

console.log(`integrity: ${db.pragma('quick_check')[0].quick_check}`)
console.log(`free pages after: ${db.pragma('freelist_count')[0].freelist_count}`)
for (const t of ['sessions', 'events', 'transcripts', 'tasks', 'wires', 'work']) {
  try {
    console.log(`  ${t.padEnd(12)} ${db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n} rows`)
  } catch {
    // A table this build does not have is not a reason to fail a rewrite that already succeeded.
  }
}
db.close()

const after = statSync(DB).size
console.log(`\nsize: ${mb(before)} MB -> ${mb(after)} MB  (freed ${mb(before - after)} MB in ${seconds}s)`)
