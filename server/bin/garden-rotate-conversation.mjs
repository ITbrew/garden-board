#!/usr/bin/env node
/**
 * Moves everything before a conversation's last compaction into the card's history library, so the
 * conversation file starts with the compacted version. Canon 30.
 *
 *   node garden-rotate-conversation.mjs --file <conversation.jsonl> --library <dir> [--floor-gb 150]
 *
 * Nothing changes until the last step, a rename, so ending this process at any moment before that
 * leaves the conversation as it was. Only run it on a conversation no process holds; the server checks.
 *
 * Exit: 0 done or nothing to do, 3 the file changed while working, 4 under the disk floor.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const file = arg('--file')
const library = arg('--library')
const floorGb = Number(arg('--floor-gb', '150'))
if (!file || !library) {
  console.error('usage: --file <conversation.jsonl> --library <dir> [--floor-gb 150]')
  process.exit(2)
}
try { setPriority(19) } catch { /* a priority we cannot set is not a reason to stop */ }
// Started with an IPC channel by the server: if the server goes, so does this, whatever killed it.
process.on('disconnect', () => process.exit(0))

const CAP_BYTES = 20 * 1024 * 1024
const NEWLINE = 10

/** Calls `onLine(buffer, offset)` for each line in a byte range, without holding the file in memory. */
async function eachLine(path, end, onLine) {
  if (end === 0) return
  let held = []
  let heldBytes = 0
  let offset = 0
  for await (const chunk of createReadStream(path, { end: end - 1, highWaterMark: 4 * 1024 * 1024 })) {
    let start = 0
    let i
    while ((i = chunk.indexOf(NEWLINE, start)) !== -1) {
      const piece = chunk.subarray(start, i)
      const line = heldBytes ? Buffer.concat([...held, piece]) : piece
      held = []
      heldBytes = 0
      await onLine(line, offset)
      offset += line.length + 1
      start = i + 1
    }
    if (start < chunk.length) {
      // Copied, because the stream may reuse its chunk.
      held.push(Buffer.from(chunk.subarray(start)))
      heldBytes += chunk.length - start
    }
  }
  if (heldBytes) await onLine(Buffer.concat(held), offset)
}

/** A real compaction mark: a top-level line that begins a new chain, not text that mentions one. */
function isBoundary(line) {
  if (!line.subarray(0, 4000).includes('"compact_boundary"')) return false
  try {
    const o = JSON.parse(line.toString('utf8'))
    return o.type === 'system' && o.subtype === 'compact_boundary' && o.parentUuid === null && !o.isSidechain
  } catch {
    return false
  }
}

const before = statSync(file)
let last = -1
await eachLine(file, before.size, (line, offset) => {
  if (isBoundary(line)) last = offset
})
if (last <= 0) {
  console.log('nothing to move')
  process.exit(0)
}

const free = (() => {
  mkdirSync(library, { recursive: true })
  const s = statfsSync(library)
  return Number(s.bavail) * Number(s.bsize)
})()
if (free < floorGb * 1024 ** 3) {
  console.error(`refused: ${(free / 1024 ** 3).toFixed(0)} GB free is under the ${floorGb} GB floor`)
  process.exit(4)
}

// Anything an ended run left is not part of the library.
const conversationDir = join(library, 'conversation')
const rawDir = join(library, 'raw')
mkdirSync(conversationDir, { recursive: true })
mkdirSync(rawDir, { recursive: true })
for (const name of readdirSync(library)) {
  if (name.startsWith('.tmp-')) rmSync(join(library, name), { recursive: true, force: true })
}
const tailTmp = `${file}.rotating`
rmSync(tailTmp, { force: true })

let number = 0
for (const f of readdirSync(conversationDir)) {
  const n = Number(/^(\d+)-/.exec(f)?.[1] ?? 0)
  if (n > number) number = n
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const workDir = join(library, `.tmp-${process.pid}`)
mkdirSync(workDir, { recursive: true })

// The lossless half: every byte that leaves, exactly as it was.
const rawPath = join(workDir, 'raw.jsonl.gz')
const rawHash = createHash('sha256')
await pipeline(
  createReadStream(file, { end: last - 1, highWaterMark: 4 * 1024 * 1024 }),
  async function* (source) {
    for await (const chunk of source) {
      rawHash.update(chunk)
      yield chunk
    }
  },
  createGzip({ level: 6 }),
  createWriteStream(rawPath),
)
const wanted = rawHash.digest('hex')
const backHash = createHash('sha256')
await pipeline(createReadStream(rawPath), createGunzip(), async function* (source) {
  for await (const chunk of source) backHash.update(chunk)
})
if (backHash.digest('hex') !== wanted) throw new Error('the archive did not read back the same')

// The readable half: one file per compaction, capped.
const rows = []
let out = null
const close = () =>
  new Promise((done) => {
    if (!out) return done()
    const finished = out
    out = null
    finished.stream.end(() => {
      // The first lines of a stretch can carry no time, so a file named before one was seen gets it now.
      const date = finished.row.from?.slice(0, 10)
      if (date && finished.row.name.includes('undated')) {
        const named = finished.row.name.replace('undated', date)
        renameSync(join(workDir, finished.row.name), join(workDir, named))
        finished.row.name = named
      }
      rows.push(finished.row)
      done()
    })
  })
const open = async (timestamp, from) => {
  await close()
  number += 1
  const date = (timestamp ?? '').slice(0, 10) || 'undated'
  const name = `${String(number).padStart(4, '0')}-${date}.jsonl`
  out = {
    stream: createWriteStream(join(workDir, name)),
    bytes: 0,
    row: { name, from, to: from, bytes: 0, about: '' },
  }
}
const stampOf = (line) => /"timestamp":"([^"]+)"/.exec(line.subarray(0, 4000).toString('latin1'))?.[1] ?? null
const firstWords = (line) => {
  try {
    const m = JSON.parse(line).message?.content
    const text = typeof m === 'string' ? m : Array.isArray(m) ? m.map((b) => b.text ?? '').join(' ') : ''
    return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}
await eachLine(file, last, async (buffer) => {
  if (buffer.subarray(0, 300).includes('"file-history-snapshot"')) return
  const when = stampOf(buffer)
  const boundary = isBoundary(buffer)
  if (boundary || !out || out.bytes >= CAP_BYTES) await open(when, when)
  const line = buffer.toString('utf8').replace(/"data":"[A-Za-z0-9+/=]{1000,}"/g, '"data":"[image kept in raw/]"')
  if (!out.row.about && !boundary && /"type":"user"/.test(line.slice(0, 2000))) out.row.about = firstWords(line)
  if (when) out.row.to = when
  if (when && !out.row.from) out.row.from = when
  const bytes = Buffer.byteLength(line) + 1
  out.bytes += bytes
  out.row.bytes = out.bytes
  if (!out.stream.write(line + '\n')) await new Promise((r) => out.stream.once('drain', r))
})
await close()

// The new start of the conversation, byte for byte.
await pipeline(createReadStream(file, { start: last, end: before.size - 1 }), createWriteStream(tailTmp))

const now = statSync(file)
if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(tailTmp, { force: true })
  console.error('the conversation changed while this ran; left as it was')
  process.exit(3)
}

renameSync(rawPath, join(rawDir, `${stamp}.jsonl.gz`))
for (const r of rows) renameSync(join(workDir, r.name), join(conversationDir, r.name))
rmSync(workDir, { recursive: true, force: true })
const indexPath = join(library, 'INDEX.md')
if (!existsSync(indexPath)) {
  writeFileSync(
    indexPath,
    '# History library\n\n' +
      'Older parts of this card\'s conversation, one file per compaction in `conversation/`. Search here\n' +
      'only when the work needs something from before, with plain grep -r, since this folder is ignored\n' +
      'by git. `raw/` holds every byte exactly as it was, including images and file snapshots. Keep what\n' +
      'you find worth keeping in NOTES.md beside this file. Garden adds rows below and never touches it.\n\n' +
      '| File | From | To | MB | How it began |\n|---|---|---|---|---|\n',
  )
}
for (const r of rows) {
  appendFileSync(indexPath, `| conversation/${r.name} | ${r.from ?? ''} | ${r.to ?? ''} | ${(r.bytes / 1048576).toFixed(1)} | ${r.about} |\n`)
}
renameSync(tailTmp, file)
console.log(`moved ${(last / 1048576).toFixed(1)} MB into ${rows.length} files; conversation is now ${((before.size - last) / 1048576).toFixed(1)} MB`)
