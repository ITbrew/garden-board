/**
 * Proves server/bin/garden-rotate-conversation.mjs on scratch files. Canon 30.
 * Run: node scripts/test-rotate-conversation.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}
const SCRIPT = new URL('../server/bin/garden-rotate-conversation.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const scratch = mkdtempSync(join(tmpdir(), 'garden-rotate-'))
const file = join(scratch, 'conversation.jsonl')
const library = join(scratch, 'history')
const run = (...extra) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...extra, '--file', file, '--library', library, '--floor-gb', '0'], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` }
  }
}
const j = (o) => JSON.stringify(o)
const user = (text, ts) => j({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const mark = (ts) => j({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: ts })
const snapshot = (ts) => j({ type: 'file-history-snapshot', timestamp: ts, snapshot: 'x'.repeat(5000) })
const image = j({ type: 'user', timestamp: '2026-01-01T00:00:03Z', message: { content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(4000) } }] } })
// Text that mentions a compaction is not one.
const mention = user('what does "compact_boundary" mean, "subtype":"compact_boundary"', '2026-01-01T00:00:04Z')

const early = [user('first ever turn', '2026-01-01T00:00:01Z'), snapshot('2026-01-01T00:00:02Z'), image, mention]
const middle = [mark('2026-01-02T00:00:00Z'), user('summary of the first stretch', '2026-01-02T00:00:01Z'), user('more', '2026-01-02T00:00:02Z')]
const current = [mark('2026-01-03T00:00:00Z'), user('summary of the second stretch', '2026-01-03T00:00:01Z'), snapshot('2026-01-03T00:00:02Z'), user('where we are now', '2026-01-03T00:00:03Z')]
const text = (lines) => lines.join('\n') + '\n'

writeFileSync(file, text(early))
check('a conversation with no compaction is left alone', run().code === 0 && readFileSync(file, 'utf8') === text(early) && !existsSync(join(library, 'conversation')))

writeFileSync(file, text([...early, ...middle, ...current]))
const original = readFileSync(file)
check('under the disk floor it refuses and changes nothing', run('--floor-gb', '1000000').code === 4 && readFileSync(file).equals(original))

const done = run()
check('it runs cleanly', done.code === 0, done.out.trim())
check('the conversation now starts with the last compaction, byte for byte', readFileSync(file, 'utf8') === text(current))

const rawFiles = readdirSync(join(library, 'raw'))
check('one raw archive was added and no temp folder left', rawFiles.length === 1 && !readdirSync(library).some((n) => n.startsWith('.tmp')), rawFiles.join(','))
const part = join(library, 'conversation')
const raw = gunzipSync(readFileSync(join(library, 'raw', rawFiles[0])))
check('the raw archive is every byte that left', raw.toString('utf8') === text([...early, ...middle]))
const files = readdirSync(part).filter((f) => f.endsWith('.jsonl')).sort()
check('each compaction gets its own file', files.length === 2, files.join(','))
const second = readFileSync(join(part, files[1]), 'utf8')
check('a later file starts with its compaction', second.startsWith(middle[0]))
const firstFile = readFileSync(join(part, files[0]), 'utf8')
check('readable files leave out snapshots', !firstFile.includes('file-history-snapshot'))
check('and replace image data with a marker', !firstFile.includes('A'.repeat(1000)) && firstFile.includes('image kept in raw/'))
check('text that only mentions a compaction did not split a file', firstFile.includes('what does'))
const index = readFileSync(join(library, 'INDEX.md'), 'utf8')
check('the index lists both files', files.every((f) => index.includes(f)))
check('and says how they began', index.includes('first ever turn') && index.includes('summary of the first stretch'))

writeFileSync(join(library, 'NOTES.md'), 'mine\n')
const unchanged = run()
check('running again with nothing older does nothing', unchanged.code === 0 && readFileSync(file, 'utf8') === text(current))

const later = [mark('2026-01-04T00:00:00Z'), user('summary of the third stretch', '2026-01-04T00:00:01Z')]
writeFileSync(file, text([...current, ...later]))
check('a later rotation runs', run().code === 0)
check('and the conversation starts at the newest compaction', readFileSync(file, 'utf8') === text(later))
const after = readFileSync(join(library, 'INDEX.md'), 'utf8')
check('the library builds on what it had', after.includes(files[0]) && after.includes('0003-') && readdirSync(join(library, 'raw')).length === 2)
check("the card's own notes are untouched", readFileSync(join(library, 'NOTES.md'), 'utf8') === 'mine\n')

// A file over the cap continues in another.
const big = user('y'.repeat(1024 * 1024), '2026-02-01T00:00:00Z')
writeFileSync(file, text([...Array(45).fill(big), ...later]))
const before = readdirSync(part).length
run()
const capped = readdirSync(part).length - before
check('a file over 20 MB continues in another', capped >= 2, `${capped} files`)

try { rmSync(scratch, { recursive: true, force: true }) } catch { /* Windows may still hold a handle */ }
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
