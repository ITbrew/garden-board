/**
 * Canon 20 `closed` on a scratch Garden: the owner closes a task with a reason through the same door
 * cards use, a close without a reason is refused, and a closed task cannot be closed again.
 * Its own instance and workspace.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Somebody'], entry: 'tsx' })
try {
  const db = new Database(join(board.home, 'garden.db'))
  const now = Date.now()
  db.prepare(
    `INSERT INTO tasks (id, projectId, ownerId, assignerId, requiredRole, territory, acceptance, acceptanceRef,
       verifierId, parentId, state, createdAt, updatedAt, closedAt)
     VALUES ('T-OLD', ?, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, 'unbound', ?, ?, NULL)`,
  ).run(board.project.id, now - 9e9, now - 9e9)
  db.close()

  const task = (...args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [join(import.meta.dirname, '..', 'server', 'bin', 'garden-task.mjs'), ...args], {
        env: { ...process.env, GARDEN_HOME: board.home, GARDEN_PORT: String(board.port), GARDEN_SESSION_ID: '' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }) }
    } catch (e) {
      return { ok: false, out: String(e.stderr || e.stdout || e.message) }
    }
  }
  const p = ['--project', board.project.id]

  const noReason = task('close', '--task', 'T-OLD', ...p)
  check('a close without a reason is refused', !noReason.ok && /reason/.test(noReason.out), noReason.out.trim())

  const done = task('close', '--task', 'T-OLD', '--reason', 'a test that was never real work', ...p)
  check('the owner closes a task with a reason', done.ok && /closed/.test(done.out), done.out.trim())

  const again = task('close', '--task', 'T-OLD', '--reason', 'twice', ...p)
  check('a closed task is not closed again', !again.ok && /already closed/.test(again.out), again.out.trim())

  const db2 = new Database(join(board.home, 'garden.db'), { readonly: true })
  const row = db2.prepare("SELECT state, closedAt FROM tasks WHERE id = 'T-OLD'").get()
  const ev = db2.prepare("SELECT payload FROM events WHERE type = 'TaskClosed'").get()
  db2.close()
  check('the task is closed with a time', row?.state === 'closed' && !!row?.closedAt, JSON.stringify(row))
  check('the reason is kept as an event', !!ev && /never real work/.test(ev.payload), ev?.payload)
} finally {
  await board.stop()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
