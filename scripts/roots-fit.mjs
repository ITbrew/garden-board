#!/usr/bin/env node
/**
 * Which cards will have their startup context trimmed, and by how much?
 *
 * The startup hook shares a fixed budget across everything it injects. If a card's files total less
 * than the budget, nothing is cut and the card gets all of it exactly. Past that, the small files
 * stay whole and the large ones split what is left, so the loss is real but it lands where it does
 * least damage. What this script answers is the question nobody could answer before: which cards are
 * over, and what is paying for it.
 *
 * It also enforces the one hard rule. The two instruction tiers, `ALL.md` and the role file, are
 * served from a reserve before anything else competes. They are the files saying what a card must
 * never do, and they must fit that reserve. When they do not, they are trimmed on every card on
 * every board at once, which is how the shared file spent an unknown length of time silently losing
 * its live-board safety rule.
 *
 * Usage: node scripts/roots-fit.mjs [--home <dir>]
 * Exit 0 when the instruction tiers fit, 1 when they do not. Card overruns are reported, not failed:
 * a busy card with a long inbox is normal and the sharing handles it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argHome = process.argv.indexOf('--home')
const HOME = argHome > -1 ? process.argv[argHome + 1] : process.env.GARDEN_HOME || join(homedir(), '.garden')

/*
 * These must match `sessionStartContext` in server/hooks/garden-hook.mjs. Duplicated on purpose: a
 * check that imports the numbers it is checking cannot catch someone changing them.
 */
const BUDGET = 9200
/*
 * The reserve is shared by three files, not two: ALL.md, the role file, and PEERS.md. Peers joined
 * them because a cut peers list fails invisibly, where a cut powers list fails at the moment the
 * card tries something and is refused.
 *
 * So the writing budget for the two instruction files is the reserve minus what peers needs. The
 * split is a convention here rather than a number the hook knows: the hook serves ALL.md, the role
 * file and PEERS.md from the 6200 in that order, and this script is what decides how much of it the
 * instructions may fairly take.
 *
 * It was 3000 for instructions and 3200 for peers, taken from the largest PEERS.md on the board.
 * Moved to 3400 on 2026-09-11 to pay for the to-do rules, which every card needs at startup rather
 * than on demand: a card that does not know the list exists will not go and look for it. What that
 * costs is real and is the reason it is written down here: 400 characters that a long PEERS.md can
 * no longer count on, on a board where 93 of them are already past their allowance and being shared
 * down. If wires start going unseen, this number is the first thing to look at.
 */
const RESERVE = 6200
const INSTRUCTIONS = 3400
const PEERS_ALLOWANCE = RESERVE - INSTRUCTIONS

const size = (p) => {
  try {
    return readFileSync(p, 'utf8').trim().length
  } catch {
    return 0
  }
}

const list = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const rootsDir = join(HOME, 'roots')
const shared = size(join(rootsDir, 'ALL.md'))

console.log(`Roots under ${HOME}\n`)
console.log(
  `The reserve is ${RESERVE}: ${INSTRUCTIONS} for ALL.md plus one role file, ${PEERS_ALLOWANCE} for PEERS.md.\n`,
)

let failed = false
const roleFiles = list(join(rootsDir, 'roles')).filter((f) => f.endsWith('.md'))
for (const f of roleFiles) {
  const role = size(join(rootsDir, 'roles', f))
  const total = shared + role
  const mark = total > INSTRUCTIONS ? 'OVER' : 'ok  '
  if (total > INSTRUCTIONS) failed = true
  console.log(`  ${mark}  ALL.md (${shared}) + ${f} (${role}) = ${total}`)
}
if (roleFiles.length === 0) console.log('  no role files found')

// Per card: everything the hook injects, against the budget. Not a failure, a forecast.
const rows = []
const verbose = []
const memory = join(HOME, 'memory')
for (const project of list(memory)) {
  const projectDir = join(memory, project)
  try {
    if (!statSync(projectDir).isDirectory()) continue
  } catch {
    continue
  }
  for (const card of list(projectDir)) {
    const dir = join(projectDir, card)
    if (!existsSync(join(dir, 'LESSONS.md'))) continue
    const lessons = size(join(dir, 'LESSONS.md'))
    // The mail directory is keyed by the full card id, which the directory name only prefixes.
    const prefix = /-([0-9a-f]{8})$/i.exec(card)?.[1]?.toLowerCase()
    const mailDir = prefix ? list(join(HOME, 'mail')).find((m) => m.toLowerCase().startsWith(prefix)) : null
    const mail = mailDir ? join(HOME, 'mail', mailDir) : null
    const powers = mail ? size(join(mail, 'POWERS.md')) : 0
    const peers = mail ? size(join(mail, 'PEERS.md')) : 0
    const inbox = mail ? size(join(mail, 'INBOX.md')) : 0
    /*
     * Reported, not failed. Past the allowance the sharing still handles it gracefully, and the
     * generator that would have to get shorter is claimed by another session. This is a note about
     * writing discipline in `writePeers`, not a broken card.
     */
    if (peers > PEERS_ALLOWANCE) verbose.push(`${project}/${card}: PEERS.md ${peers}`)
    const total = shared + 800 + lessons + powers + peers + Math.min(inbox, 400)
    if (total > BUDGET) rows.push({ card: `${project}/${card}`, total, lessons, powers, peers, inbox })
  }
}

console.log(`\nCards whose files total more than the ${BUDGET} character budget, so sharing applies:\n`)
if (rows.length === 0) console.log('  none')
for (const r of rows.sort((a, b) => b.total - a.total).slice(0, 12)) {
  console.log(`  ${r.card}`)
  console.log(
    `    ${r.total} asked: lessons ${r.lessons}, powers ${r.powers}, peers ${r.peers}, inbox ${r.inbox}`,
  )
}
if (rows.length > 12) console.log(`  ... and ${rows.length - 12} more`)

if (verbose.length > 0) {
  console.log(`\n${verbose.length} PEERS.md past the ${PEERS_ALLOWANCE} allowance, largest first:\n`)
  for (const v of verbose.slice(0, 8)) console.log(`  ${v}`)
  if (verbose.length > 8) console.log(`  ... and ${verbose.length - 8} more`)
  console.log('\n  Not a failure. Sharing still handles it, but it is prose that could be shorter.')
}

console.log(
  failed
    ? '\nFAIL: the instruction tiers do not fit their reserve. They are trimmed on every card until they do.'
    : '\nThe instruction tiers fit.',
)
process.exit(failed ? 1 : 0)
