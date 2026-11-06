/**
 * A card with more history than the event cap still shows its newest events.
 *
 * Until 2026-09-05 `store.listEvents` returned the OLDEST rows under its cap of 4000. Every reader
 * of a busy card was reading its first weeks and nothing since, and the launch watchdog was one of
 * those readers: it looked for a SessionStart newer than the launch, found none on any card with
 * more than 4000 events, and ended the CLI sixty seconds after every launch. Fifteen of the owner's
 * cards on one board were over the cap, and each of them died mid-turn every time it was started,
 * with "Resume this session with: claude --resume ..." as the last thing on screen.
 *
 * This runs against the built store on a database of its own under the temp directory. No
 * instance, no port, nothing of the owner's. The control at the end reproduces the old query shape
 * directly against the same rows and shows what it missed, so the failure this guards against is
 * demonstrated in the same run rather than described.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'server', 'dist', 'store.js')).href
const { Store } = await import(storeUrl)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + String(detail).slice(0, 160) : ''}`)
  if (!ok) failed++
}

const home = mkdtempSync(join(tmpdir(), 'garden-events-'))
const store = new Store(join(home, 'garden.db'))

const busy = 'busy-card'
const quiet = 'quiet-card'
const base = 1_700_000_000_000
const N = 4100
const insert = store.db.transaction(() => {
  for (let i = 0; i < N; i++) {
    store.insertEvent({
      id: `e-${i}`,
      sessionId: busy,
      ts: base + i,
      type: i === N - 1 ? 'SessionStart' : 'PreToolUse',
      provenance: 'structured',
      payload: { i },
    })
  }
  store.insertEvent({ id: 'q-0', sessionId: quiet, ts: base, type: 'SessionStart', provenance: 'structured', payload: {} })
})
insert()

const newest = base + N - 1
const launchedAt = newest - 5 // the launch happened just before the card's newest SessionStart

const page = store.listEvents(busy)
check('the page is capped', page.length === 4000, page.length)
check('and it is the newest page, oldest first', page[0].ts === base + 100 && page[page.length - 1].ts === newest,
  `${page[0].ts - base} .. ${page[page.length - 1].ts - base}`)
check('so a reader looking for something recent finds it', page.some((e) => e.ts >= launchedAt))
check('and the newest event is the SessionStart that was inserted last', page[page.length - 1].type === 'SessionStart')

check('hasEventSince sees the SessionStart after the launch', store.hasEventSince(busy, launchedAt) === true)
check('and says no when nothing is that new', store.hasEventSince(busy, newest + 1) === false)
check('the board-wide form excludes the card being asked about',
  store.hasEventSince(null, launchedAt, busy) === false, 'only the quiet card is left, and its event is old')
check('and finds another card when one has reported', store.hasEventSince(null, base, busy) === true)

/*
 * The control: the query the store ran before this change, against the same rows.
 *
 * It is the oldest 4000, so the newest 100 events, the SessionStart among them, are not in it.
 * This is the read the watchdog used to make, and it is why the check that follows is false.
 */
const old = store.db.prepare('SELECT ts FROM events WHERE sessionId = ? ORDER BY ts LIMIT 4000').all(busy)
check('control: the old oldest-first page never reaches the launch',
  old.length === 4000 && !old.some((r) => r.ts >= launchedAt), `newest it holds is +${old[old.length - 1].ts - base}`)

store.db.close()
rmSync(home, { recursive: true, force: true })

if (failed) {
  console.log(`\n${failed} FAILED`)
  process.exit(1)
}
console.log('\nALL PASS')
