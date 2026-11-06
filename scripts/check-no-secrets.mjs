/**
 * Refuses a commit that carries a credential.
 *
 * Written on 2026-09-08 after the owner asked whether anything private had ever reached GitHub.
 * Answering that took a hand-written sweep over every blob in every history of seven repositories,
 * which found nothing and was then thrown away. This is that sweep made permanent, so the question
 * is answered continuously instead of once.
 *
 *   node scripts/check-no-secrets.mjs          the staged changes, which is what the hook runs
 *   node scripts/check-no-secrets.mjs --all    every tracked file, which is what CI runs
 *
 * Deliberately pattern-based rather than entropy-based. An entropy score flags minified bundles,
 * hashes and base64 images, and a check that cries wolf gets switched off within a week. These
 * patterns each name a real credential format, so a match is worth stopping for.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'an OpenAI-style API key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'a GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'a fine-grained GitHub token'],
  [/\bgho_[A-Za-z0-9]{30,}\b/, 'a GitHub OAuth token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, 'a Google API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'/]*:[^\s"'@]+@/, 'a connection string with a password in it'],
  [/(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'a hardcoded secret'],
]

/*
 * This file names every pattern it looks for, so it matches itself on every run.
 *
 * Skipping it by name is the honest fix. The alternative, splitting the patterns across files or
 * building them from fragments, hides what the check does from the person most likely to need to
 * read it, which is whoever it just stopped.
 */
const SELF = basename(new URL(import.meta.url).pathname)

/** Binary and build output. Neither carries a credential a human typed, and both are enormous. */
const SKIP = /\.(png|jpe?g|gif|webp|ico|mp4|zip|woff2?|pdf|tsbuildinfo|db|sqlite3?)$|(^|\/)(node_modules|dist)\//i

const all = process.argv.includes('--all')
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const files = (all
  ? git(['ls-files', '-z'])
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => !SKIP.test(f) && basename(f) !== SELF)

const found = []
for (const file of files) {
  let text
  try {
    if (statSync(file).size > 4_000_000) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue // Staged as deleted, or unreadable. Neither can leak anything.
  }
  const lines = text.split('\n')
  for (const [pattern, what] of PATTERNS) {
    lines.forEach((line, i) => {
      const m = line.match(pattern)
      if (m) found.push({ file, line: i + 1, what, snippet: m[0].slice(0, 40) })
    })
  }
}

if (found.length === 0) {
  console.log(`no credential in ${files.length} ${all ? 'tracked' : 'staged'} file(s).`)
  process.exit(0)
}

console.log(`${found.length} possible credential(s):\n`)
for (const f of found) console.log(`  ${f.file}:${f.line}  looks like ${f.what}  ->  ${f.snippet}`)
console.log(`
If any of these is real: it is compromised the moment it is committed, so rotate it rather than
only removing it. If every one is a placeholder or a test fixture, the pattern is too broad and
belongs edited in this file, with a note saying which line taught you that.`)
process.exit(1)
