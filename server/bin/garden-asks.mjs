/**
 * The questions in your inbox that are waiting on the owner, pulled out of the reports that carry
 * them.
 *
 * The failure this exists for is measured. On 2026-08-19 a card wrote, in the second paragraph of a
 * long technical report about something else, that the owner had rebaked the wrong eight operators
 * and that any animation he saw in that output proved nothing. It ended: "That is worth a sentence
 * to him tonight, ahead of everything else in this message." It never reached him. The orchestrator
 * read it as content, and for nineteen hours he could have repeated the same wasted work.
 *
 * The card did everything right. It identified the urgency, put it above its own findings, and said
 * in plain words who needed to know and by when. What it could not do is make the request louder
 * than the document it arrived in, because a card has no route to the owner except through the
 * orchestrator, and that route fails silently.
 *
 * The owner has confirmed he wants it to stay that way: cards ask the orchestrator, the orchestrator
 * asks him. So this does not give anyone a new route. It makes the existing one hard to miss.
 *
 * A card marks a line with the token below. This reads every message in the inbox, finds the marked
 * lines, and prints them with the sender, the timestamp and the task, newest last. Nothing is
 * inferred from prose and no message is summarised: a marked line is quoted exactly as written, and
 * an unmarked one is invisible here, which is the honest behaviour when the alternative is guessing
 * at urgency from tone.
 *
 *   [NEEDS-OWNER]
 *
 * Usage:
 *   node <this>                  everything marked and not yet cleared
 *   node <this> --all            including what has been cleared
 *   node <this> --clear          mark everything currently listed as raised with him
 *
 * `--clear` writes a line to ASKED.md beside the inbox. It records that these reached him, which is
 * the fact the orchestrator otherwise has to remember, and remembering is what failed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const TOKEN = '[NEEDS-OWNER]'
const ME = process.env.GARDEN_SESSION_ID || null

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const FLAGS = new Set(['--all', '--clear'])
const opts = {}
for (const token of argv) {
  if (!FLAGS.has(token)) fail(`I do not know the argument "${token}". I take --all and --clear.`)
  opts[token] = true
}

if (!ME) fail('GARDEN_SESSION_ID is not set, so I cannot tell whose inbox to read.')

const mailDir = join(homedir(), '.garden', 'mail', ME)
const inbox = join(mailDir, 'INBOX.md')
const asked = join(mailDir, 'ASKED.md')
if (!existsSync(inbox)) fail(`There is no inbox at ${inbox}.`)

const text = readFileSync(inbox, 'utf8')
const lines = text.split('\n')

/*
 * Messages are split on the header the server writes, rather than on a blank line or a heading
 * level. Bodies contain both, and a splitter that keyed on either would cut a message in half and
 * attribute its second part to the wrong card, which is a worse failure than not finding anything.
 */
const HEADER = /^## From (.+?), (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/

const found = []
let from = null
let when = null
let task = null
for (const line of lines) {
  const h = HEADER.exec(line)
  if (h) {
    from = h[1]
    when = h[2]
    task = null
    continue
  }
  // The server writes the task on its own line just under the header.
  const t = /task [`'"]?([\w.-]+)/.exec(line)
  if (t && task === null && from) task = t[1]
  if (line.includes(TOKEN)) {
    found.push({ from, when, task, line: line.trim() })
  }
}

// What has already been raised with him, so the same line does not get carried twice.
const cleared = new Set()
if (existsSync(asked)) {
  for (const l of readFileSync(asked, 'utf8').split('\n')) {
    const m = /^- \[(.+?)\] (.*)$/.exec(l.trim())
    if (m) cleared.add(m[2])
  }
}

const open = opts['--all'] ? found : found.filter((f) => !cleared.has(f.line))

if (open.length === 0) {
  process.stdout.write(
    found.length === 0
      ? `Nothing in the inbox is marked ${TOKEN}.\n`
      : `Nothing outstanding. ${found.length} marked lines have all been raised with him.\n`,
  )
  process.exit(0)
}

const out = []
out.push(`${open.length} thing${open.length === 1 ? '' : 's'} a card wants the owner to decide.`)
out.push('')
for (const f of open) {
  out.push(`  ${f.when}  ${f.from ?? 'unknown'}${f.task ? `  (${f.task})` : ''}`)
  out.push(`    ${f.line}`)
  out.push('')
}
if (!opts['--clear']) {
  out.push('Raise these with him, then run again with --clear so they stop being listed.')
}
process.stdout.write(`${out.join('\n')}\n`)

if (opts['--clear']) {
  /*
   * Appended rather than rewritten, and stamped.
   *
   * The question this file answers later is not "is it done" but "when was he told", which is
   * exactly the question nobody could answer about the rebake warning. A file that only holds the
   * current state cannot answer it.
   */
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const add = open.map((f) => `- [${stamp}] ${f.line}`).join('\n')
  writeFileSync(asked, (existsSync(asked) ? readFileSync(asked, 'utf8').replace(/\n*$/, '\n') : `# Raised with the owner\n\n`) + add + '\n')
  process.stdout.write(`\nRecorded ${open.length} as raised with him, in ${asked}.\n`)
}
