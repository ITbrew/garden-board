/**
 * Proves a card measures its tokens against the model it is running, from one table.
 *
 * The failure this exists for happened three times. The window started as one flat million for the
 * whole board, which measured a Sonnet card against five times its real size. Then `ingest.ts` grew
 * a second table giving Opus 200,000 while `tokens.ts` still said a million, so the same bar jumped
 * by a factor of five depending on which source last reported. Those two were reconciled, and a
 * third survived in the card itself as the literal string "of 1,000,000" beside the token count.
 *
 * That third one is what the owner was reading on 2026-08-15. He moved his orchestrator to Fable,
 * whose window this did not know, so the gauge went blank, which was correct. The line underneath it
 * went on saying "278,747 of 1,000,000", which was not, and a number is more believable than a blank
 * bar, so the wrong one won. His words: "i swapped orchestrator to fable but health bar still shows
 * out of 1m and not updating".
 *
 * Two checks, because the bug has two halves. What the table says, and whether anybody has quietly
 * written down a second copy of the answer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/*
 * The source, not a build. `@garden/shared` publishes `./src/index.ts` as its entry and emits only
 * declarations, so there is no JavaScript to import; the consumers compile it themselves. Node 24
 * strips the types on the way in, which means this test reads the same file the app does rather than
 * a copy that could be stale.
 */
const { contextWindowFor } = await import(
  `file://${join(ROOT, 'packages', 'shared', 'src', 'index.ts').replace(/\\/g, '/')}`
)

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// --- what the table answers ----------------------------------------------------------------------

const cases = [
  ['claude-opus-5', 1_000_000, 'the model the board mostly runs on'],
  ['claude-opus-5[1m]', 1_000_000, 'the variant picked by hand'],
  ['claude-fable-5', 1_000_000, 'documented at a million, and the model that exposed all this'],
  ['claude-sonnet-5', 1_000_000, 'the fifth generation is a million, unlike the ones before it'],
  ['claude-3-5-sonnet-20241022', 200_000, 'an older Sonnet must NOT be given a million'],
  ['claude-haiku-4-5-20251001', 200_000, 'Haiku is still two hundred thousand'],
  [null, null, 'a card that has not reported a model yet'],
  ['some-model-shipped-next-week', null, 'an unknown model is unknown, not assumed'],
]

for (const [model, want, why] of cases) {
  const got = contextWindowFor(model)
  check(
    `${model ?? '(no model)'} -> ${want === null ? 'unknown' : want.toLocaleString()}`,
    got === want,
    got === want ? why : `got ${got === null ? 'unknown' : got.toLocaleString()}`,
  )
}

// --- and whether a second copy of the answer has appeared -----------------------------------------

/*
 * A window written anywhere but the table is the bug itself, in its only recurring form. Comment
 * lines are skipped because this file's own history is written in them, and so is the card's.
 */
const TABLE = join('packages', 'shared', 'src', 'index.ts')
const WINDOWS = /(?<![\d_,.])(1[_,]?000[_,]?000|200[_,]?000)(?![\d_,.])/

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const files = [
  ...walk(join(ROOT, 'server', 'src')),
  ...walk(join(ROOT, 'apps', 'web', 'src')),
  ...walk(join(ROOT, 'packages', 'shared', 'src')),
]

/*
 * Comments are stripped by walking the file, not by testing each line for a prefix.
 *
 * A first version tested prefixes, which is wrong for exactly the text it was written to allow:
 * prose on the third line of a block comment starts with a word, and this file's own account of the
 * bug quotes the number it is looking for. It reported the comment describing the defect as the
 * defect. Crude but correct beats clever and self-accusing.
 */
const stripComments = (text) => {
  let out = ''
  let inBlock = false
  for (const line of text.split('\n')) {
    let kept = ''
    for (let i = 0; i < line.length; i++) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inBlock = false
          i++
        }
        continue
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true
        i++
        continue
      }
      if (line[i] === '/' && line[i + 1] === '/') break
      kept += line[i]
    }
    out += `${kept}\n`
  }
  return out
}

const strays = []
for (const file of files) {
  const rel = relative(ROOT, file)
  if (rel === TABLE) continue
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    const code = line.trim()
    if (!WINDOWS.test(code)) return
    /*
     * One exception, named rather than pattern-matched away: the terminal reader turns "1.2M tokens"
     * into a number, and its multiplier is a unit conversion rather than a claim about any model.
     */
    if (rel.replace(/\\/g, '/').endsWith('server/src/tokens.ts') && /s === 'm'/.test(code)) return
    strays.push(`${rel}:${i + 1}  ${code.slice(0, 70)}`)
  })
}

check(
  'no file outside the table writes a context window of its own',
  strays.length === 0,
  strays.length ? strays.join(' | ') : `${files.length} files scanned`,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
