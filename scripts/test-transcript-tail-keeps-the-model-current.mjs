/**
 * A card's model is read from the end of its transcript, however long that transcript is.
 *
 * The owner found this in the rail: "i want garden running now list to show the model that card is
 * currently running in and effort level ... i have an orchestrator on fable low and its showing
 * previous setting of opus". The card was on fable. Garden said opus, which is the model it had
 * announced at `SessionStart`, because the only thing that would have corrected it could not read
 * the file.
 *
 * `Ingest.readUsage` did `readFileSync(path, 'utf8')` over the whole transcript. Node refuses to
 * make a string longer than 0x1fffffe8 characters, so on that card's 666MB transcript every refresh
 * threw `ERR_STRING_TOO_LONG` into a catch clause written for a file that is missing. Nothing on
 * screen said the reader had failed: the gauge was blank, which is also what a session with no
 * transcript looks like, and the model was stale, which looks like a model.
 *
 * What would go red before the change:
 *
 *   - `tailLines` is not exported, so `ingest.ts` cannot use it.
 *   - `readUsage` reads the whole file, so the third check below finds `readFileSync` in it.
 *
 * What this file cannot do is build a 666MB transcript to reproduce the throw, so it does not
 * pretend to: it proves the reader takes the end of a file far larger than its window, that the
 * window grows when the first one holds no usage record, and that the usage reader no longer reads
 * whole files. The real file was checked by hand once, read-only, and the new reader answered
 * `claude-fable-5-1` in 6ms where the old one threw.
 *
 * Reads `server/dist`, so build before running it.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_TAIL_BYTES, TAIL_BYTES, tailLines } from '../server/dist/transcript.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'garden-tail-'))

/** One transcript record with a usage block, which is the shape the reader looks for. */
const usageLine = (model, tokens) =>
  JSON.stringify({
    type: 'assistant',
    message: { model, usage: { input_tokens: tokens, output_tokens: 1 } },
  })

/** Filler that is a valid record and carries no usage, the way tool results do. */
const fillerLine = (n) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(n) } })

// --- the end of the file wins, and the rest of it is never read ---

/*
 * Bigger than the window on purpose. The model named at the start is the one the card announced at
 * startup, and the model named at the end is the one it is running now, which is exactly the
 * arrangement that had the owner reading opus off a card on fable.
 */
const big = join(dir, 'big.jsonl')
writeFileSync(big, usageLine('claude-opus-5', 1000) + '\n')
const chunk = fillerLine(20_000) + '\n'
let written = 0
while (written < TAIL_BYTES * 2) {
  appendFileSync(big, chunk.repeat(50))
  written += chunk.length * 50
}
appendFileSync(big, usageLine('claude-fable-5-1', 2000) + '\n')

const t0 = Date.now()
const lines = tailLines(big, TAIL_BYTES)
const ms = Date.now() - t0

const newest = (ls) => {
  for (let i = ls.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(ls[i])
      if (p?.message?.usage) return p.message.model
    } catch {
      /* a record this does not understand is skipped, the way the reader skips one */
    }
  }
  return null
}

check('the newest model wins on a file larger than the window', newest(lines) === 'claude-fable-5-1', String(newest(lines)))
check('and the start of the file was never read',
  !lines.some((l) => l.includes('claude-opus-5')),
  `${lines.length} lines back from a file of ${(written / 1024 / 1024).toFixed(1)}MB`)
/*
 * Not a benchmark, a cliff. Reading the whole file takes time proportional to its size and this does
 * not, so a second here would mean the window had stopped being a window.
 */
check('and it cost almost nothing', ms < 500, `${ms}ms`)

// --- the window grows when the first one holds no usage record ---

/*
 * A card whose records are hundreds of kilobytes each can have no assistant message at all in four
 * megabytes. Without the growth the reader would answer "nothing here" and the card would keep its
 * old model, which is the same wrong answer by a different route.
 */
const sparse = join(dir, 'sparse.jsonl')
writeFileSync(sparse, usageLine('claude-sonnet-5', 500) + '\n')
appendFileSync(sparse, (fillerLine(100_000) + '\n').repeat(60))

const firstWindow = tailLines(sparse, TAIL_BYTES)
check('a window with no usage record in it finds nothing', newest(firstWindow) === null, String(newest(firstWindow)))
const grown = tailLines(sparse, MAX_TAIL_BYTES)
check('and the larger window finds it', newest(grown) === 'claude-sonnet-5', String(newest(grown)))

// --- the usage reader does not read whole files any more ---

/*
 * A static check, because this is the regression itself rather than a behaviour: `readChat` was
 * given a tail reader for exactly this reason and `readUsage` beside it was left reading the whole
 * file. What went wrong was not the logic in either reader, it was two readers of the same file each
 * deciding how much of it to read.
 */
const ingest = readFileSync(join(ROOT, 'server', 'src', 'ingest.ts'), 'utf8')
/*
 * From the usage reader to the end of the class, which is both it and the scan it delegates to.
 * Sliced to the end of the file rather than to the next member, because `transcriptFor` sits ABOVE
 * it: an end index before the start index gives an empty string, and an empty string contains no
 * `readFileSync`, so the check passed itself. It did exactly that on its first run.
 */
const usageReader = ingest.slice(ingest.indexOf('private readUsage'))
check('the usage reader takes a tail rather than a whole file',
  usageReader.includes('tailLines') && !/readFileSync/.test(usageReader),
  usageReader.includes('readFileSync') ? 'readFileSync is still in readUsage' : 'tailLines')

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
