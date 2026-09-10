import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE_POWERS } from '@garden/shared'
import { DATA_DIR } from './store.js'

/*
 * Under the workspace rather than under the home directory directly, so GARDEN_HOME moves this
 * with everything else. It did not, which meant a second server started for a test wrote its
 * scratch cards' notes into the owner's real memory directory.
 */
export const MEMORY_ROOT = join(DATA_DIR, 'memory')

/**
 * A card's own notes directory.
 *
 * Keyed by the CARD, not by the process. A session id changes every time it is turned on, so
 * lessons keyed to it would reset constantly, which is the opposite of what retention means. The
 * card id is stable for as long as the card exists, so a role accumulates what it learns across
 * every restart.
 *
 * These are plain files at a stable absolute path, so the agent reads and writes them with the
 * tools it already has, and so does any other agent that is pointed at them.
 */
export function memoryDirFor(projectName: string, cardId: string, cardTitle: string): string {
  const projectDir = join(MEMORY_ROOT, slug(projectName))
  const suffix = `-${cardId.slice(0, 8)}`

  /*
   * A card that was renamed keeps what it learned.
   *
   * The directory name carries the title so it is readable from a file browser, which means a
   * rename would otherwise compute a new path and silently abandon every lesson the card had
   * accumulated. That is the exact opposite of the point. The id suffix is the real key, so an
   * existing directory ending in it wins over whatever the title says today.
   */
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith(suffix)) return join(projectDir, name)
    }
  } catch {
    // No project directory yet, which just means this is the first card in it.
  }
  return join(projectDir, `${slug(cardTitle)}${suffix}`)
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'card'
  )
}

const LESSONS_HEADER = `# Lessons

Things this card learned the hard way, in this project. Append a line whenever a correction lands
or an approach turns out to be wrong. Keep each entry short enough to be worth re-reading at the
start of the next task.

Format: one bullet per lesson, newest at the bottom, with the date.
`

const NOTES_HEADER = `# Notes

Working notes for this card: what it is responsible for, where the relevant code lives, and
anything a future run should not have to rediscover.

This file is read at the start of a task and is meant to stay short. Long-form records of
individual pieces of work belong in the history directory, not here.
`

const PLAYBOOK_HEADER = `# Playbook

How this card does its particular job well, written down so the next run starts where the last one
finished rather than from scratch.

This is the difference between a card that has run fifty times and a card that has run once: the
commands that work here, the checks worth running before calling something done, the places in
this project that always need looking at, and the shortcuts that turned out to be traps.

Add to it whenever something works well enough to be worth repeating. Keep it procedural: a
future run should be able to follow it, not just agree with it.
`

/**
 * Create the directory and seed its files, once. Never overwrites: the whole point is that what
 * accumulated last time survives.
 *
 * Three files, one per kind of knowledge, because a single notes file becomes a dump nobody
 * re-reads. Lessons are corrections, notes are the current picture, and the playbook is the
 * procedure this card has worked out for its own spot in the project.
 */
export function ensureMemory(dir: string): { lessons: string; notes: string; playbook: string } {
  mkdirSync(dir, { recursive: true })
  const lessons = join(dir, 'LESSONS.md')
  const notes = join(dir, 'NOTES.md')
  const playbook = join(dir, 'PLAYBOOK.md')
  if (!existsSync(lessons)) writeFileSync(lessons, LESSONS_HEADER, 'utf8')
  if (!existsSync(notes)) writeFileSync(notes, NOTES_HEADER, 'utf8')
  if (!existsSync(playbook)) writeFileSync(playbook, PLAYBOOK_HEADER, 'utf8')
  return { lessons, notes, playbook }
}

/**
 * The line below which the card's own writing starts.
 *
 * Everything above it is Garden's: who this card is, what it may reach for, and where it sits on
 * the team, rewritten whenever any of that changes. Everything below is the card's, and is carried
 * across untouched, because a brief that wipes an agent's own notes every time its role is edited
 * teaches it not to write any.
 */
const OWN_MARK = '<!-- Below this line is yours. Garden never rewrites it. -->'

/**
 * The card's own CLAUDE.md: what it is, what it may do, and its job on this team.
 *
 * Every card gets one, because a session with no instructions of its own reads only the project's
 * and behaves like every other session in the project, which is the opposite of a team. This is the
 * file the CLI picks up on its own, so it is the one place a role can be stated where the agent
 * will actually see it without anybody pasting it into a prompt.
 *
 * The powers section is quoted from the same table that writes the deny list into the settings
 * file, so a brief can never describe a restriction that was not written.
 */
export function writeCardBrief(
  dir: string,
  card: { title: string; roleClass: string | null; canSpawnAgents: boolean; teamSize: number | null },
  answersTo: string | null,
  projectName: string,
  roots?: string,
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'CLAUDE.md')

  let own = ''
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    const at = current.indexOf(OWN_MARK)
    if (at >= 0) own = current.slice(at + OWN_MARK.length)
  }

  /*
   * What the card that hired this one said it is for, written once when the card is made.
   *
   * Below the line, because it is the card's own half and Garden must never rewrite it: the hirer
   * says what the job is, and the card edits and adds to it as it learns. Seeded only when there is
   * nothing there yet, for the same reason the rest of this file preserves that section. A brief
   * that wipes an agent's own notes every time its role is edited teaches it not to write any.
   *
   * This is the difference the owner asked for. A card hired with no roots reads only the project's
   * instructions and the machine's, and answers as whatever those describe, which is how a hired
   * specialist ends up behaving like every other session in the folder.
   */
  if (roots && !own.trim()) own = `\n\n${roots.trim()}\n`

  const role = card.roleClass ? ROLE_POWERS[card.roleClass] : undefined
  const lines = [
    `# ${card.title}`,
    '',
    `This file belongs to one card on the Garden board for **${projectName}**. Garden maintains`,
    'everything above the line at the bottom; below it is yours.',
    '',
    '## What you are here',
    '',
  ]

  if (role && card.roleClass) {
    lines.push(`You are the **${card.roleClass}**: ${role.summary}.`, '', role.enforced, '')
    lines.push(`Denied by the CLI, so these will refuse rather than fail quietly: ${role.denies.join(', ')}.`, '')
  } else {
    lines.push('No role has been set for this card, so nothing is denied to it and nothing is expected of it', 'beyond what you ask directly.', '')
  }

  lines.push('## Where you sit', '')
  lines.push(
    answersTo
      ? `You answer to **${answersTo}**. Report what you finish to that card and nowhere else.`
      : 'You answer to the owner directly. Nobody else on this board is above you.',
    '',
  )
  if (!card.canSpawnAgents || card.teamSize === 0) {
    lines.push('You may not hire anyone, so the work you are given is yours to do.', '')
  } else if (card.teamSize) {
    lines.push(`Keep to about ${card.teamSize} helper${card.teamSize === 1 ? '' : 's'} at a time.`, '')
  }
  lines.push(
    'Who you may actually send to is in `PEERS.md` beside this file, and it is not advice: a wire on',
    'the board is what permits a message, and anything else is refused with a reason. `PEERS.md` also',
    'holds the exact command for sending one.',
    '',
    '## Your own files',
    '',
    'These are yours and they persist across every restart of this card:',
    '',
    '- `NOTES.md` for the current picture of what you are responsible for.',
    '- `LESSONS.md` for corrections, so the same mistake is not made twice.',
    '- `PLAYBOOK.md` for how you do this job well, written so a later run can follow it.',
    '',
    'Write to them before you finish a piece of work, not after you are asked to.',
    '',
    OWN_MARK,
  )

  writeFileSync(file, lines.join('\n') + (own || '\n'), 'utf8')
  return file
}
