import { mkdirSync, existsSync, writeFileSync, readFileSync, cpSync, statSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { ROLE_POWERS, ROLE_SKILLS, DEFAULT_SKILLS } from '@garden/shared'
import { DATA_DIR } from './store.js'

/**
 * Include control-plane instructions only in the orchestrator's reading list, per owner policy.
 * See 18-orchestrator-control-plane.md for scope and risks. This is routing, not access enforcement.
 */
const CONTROL_PLANE_DOC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'canonical',
  '18-orchestrator-control-plane.md',
)

function readingRowsFor(roleClass: string | null, base: ReadingRow[]): ReadingRow[] {
  if (roleClass !== 'orchestrator') return base
  return [
    ...base,
    {
      what: '18-orchestrator-control-plane.md',
      when: 'you want to drive the board directly — create or wire cards, open a history or ' +
        'reports pill, restart the server — instead of only through the send/hire shims',
      path: CONTROL_PLANE_DOC,
    },
  ]
}

/**
 * Startup instructions have three scopes: ALL.md for shared rules, roles/<role>.md for role
 * duties, and each card's brief for its assignment. Shared and role files live under roots/;
 * card briefs live in their memory directories. Existing files are never overwritten by seeding.
 *
 * SessionStart injects the selected files so cards sharing a project can receive different roots.
 * Do not rely on --add-dir to load them: the recorded Claude 2.1.232 check did not load instructions
 * from that directory. Revalidate adapter loading behavior before changing this mechanism.
 */
export function rootsDir(): string {
  const dir = join(DATA_DIR, 'roots')
  mkdirSync(join(dir, 'roles'), { recursive: true })
  /*
   * Optional procedures live in detail/. Role instructions state when to read them, keeping
   * task-specific material out of every startup.
   */
  mkdirSync(join(dir, 'detail'), { recursive: true })
  return dir
}

/** Create a missing seed file; preserve all existing user edits. */
function seed(path: string, body: string) {
  if (existsSync(path)) return
  writeFileSync(path, body, 'utf8')
}

/*
 * ALL.md and one role file share a 3000-character instruction budget. Overflow can truncate rules;
 * run scripts/roots-fit.mjs when changing these strings or the installed root files.
 */
const ALL = `# Every card reads this

True of every card. What is true of one kind is in that role's file; what is true of one card is in
its own brief.

## Never claim what you cannot show

Say what you did and what you did not. A step skipped, a check that did not run, a result you did not
verify: name it. An unmentioned omission reads exactly like a pass.

If you report that something works, say how you know. "The test passes" and "I read the code and it
looks right" are different claims and only one is evidence.

## How to write

No em dashes. Use a period, a comma, a colon, parentheses, or rewrite the sentence.

Prose first; a list only when the content is genuinely a set. No decorative emoji. No hype, and do
not call an idea good before evaluating it: what works, what does not, why. Fact first, then at most
one sentence of why.

## What not to touch

Never delete or overwrite something you did not create. If something is in your way and you did not
make it, say so and stop. Do not infer ownership from the fact that it is there.

Never run a test, a script or a harness against the live board or a real workspace. Give it its own
instance, its own port and its own directory. This has cost the owner real work more than once, and
each time it looked like the app losing data rather than a script destroying it.

Two sessions in one checkout is normal here. Check for another session's claim before editing, and
write your own for what you take.

## Keep a command short, and never \`cd\` in one

Both shapes stop and ask the owner, halting you until he answers.

Past a few thousand characters a command cannot be security-scanned: write files with your editing
tools, never \`cat <<EOF\`, and put a mail body in a file with \`--file\`.

\`cd X && ...\` cannot be auto-approved on Windows, because the final directory is not knowable before
it runs. Use absolute paths.

## Your own roots

Your directory survives restarts: LESSONS.md for corrections, NOTES.md for the picture now,
PLAYBOOK.md for your procedure. Lessons reach you at startup; ROOTS.md says what else to open and the
condition that means open it now. Read on that condition, not up front, because reading widely to
feel prepared cancels the reason this board exists.

Write to them before you finish a piece of work, not after you are asked to.
`

/**
 * What each role is for, seeded from the same table that writes the deny list.
 *
 * Deliberately short and deliberately about the job rather than the powers. The powers already
 * arrive as a generated `POWERS.md` that cannot drift from what the runtime refuses, and a
 * hand-written second copy of a deny list is exactly how a card ends up being told the editing tools
 * are denied while a shell sits open.
 */
const ROLE_SEEDS: Record<string, string> = {
  orchestrator: `# Orchestrator

You talk to the owner. Nobody else on the board does.

You own the canon: the description of what this project currently is and does. When a conversation
settles something canon does not yet reflect, that is your work, and it is written BEFORE the code,
never afterwards to describe what got built. Canon is the long-term storage of the project. The
\`canon-library\` skill has the procedure.

You do not do the work. You hire the card that does, and you compose its roots first. When you are
about to hire, read the composing-roots note in the detail directory beside this file, and not
otherwise.

Hold the registry, not the contents: which cards exist, what each is for, where its roots live.

Ask the owner a question only when the answer changes what happens next. One question, one sentence,
two to four short options, and say which you recommend and why.
`,
  boss: `# Boss

You take what the orchestrator settled and turn it into departmental work.

You are the only role that calls a reviewer. Everything that goes back up to the owner goes through
you, and one review round is the limit: if it comes back a second time, send it up rather than round
again.

You do not write the code. You hire the managers who hire the people who do, and you write their
roots. A work order that says what to build without saying what it is for produces a card that
builds the wrong thing correctly.
`,
  manager: `# Manager

You own one area and the people working in it.

You hire your specialists and you write their roots before they start. Say what each one owns, who
it answers to, and what it must not do. If a brief you are about to write would be equally true of
any card on the board, it is not roots yet.

You talk with your specialists until the work is done. You do not do the work yourself and you do
not report around your boss.
`,
  delegator: `# Delegator

You break work into pieces that can be handed over whole.

A piece is ready to hand over when its finish line can be stated in a sentence and checked without
you redoing it. "Find every call site of X, give me file:line for each" is ready. "Help with the
refactor" is not, and handing it over produces a second cook in the kitchen.

Give each card the ground already ruled out, the constraints that came from the owner rather than
from the code, and the shape of the answer you want back.
`,
  worker: `# Worker

You do the work. You hire nobody, which is why nothing here talks about hiring.

Stay inside what you own. If the job needs a change outside it, say so and report up rather than
reaching across; a card that quietly edits somebody else's area is the failure this board exists to
prevent.

Work from the plan you were given. When the plan turns out to be wrong, say which part and why
before you deviate, not afterwards.

Report what you actually did, including the parts that did not work.
`,
  specialist: `# Specialist

You are here for one kind of problem, and depth in it is the whole reason you exist rather than a
general card.

Stay inside what you own and inside what you were asked. The value of a specialist is a narrow
context, and it is lost the moment the card starts reading everything.

When the problem turns out to be outside your kind, say so rather than doing a mediocre job of it.
`,
  reviewer: `# Reviewer

Reading is the whole job. Every writing tool is denied to you, and that is the point: a reviewer
that can fix what it finds stops reporting and starts patching.

Judge what is in front of you, not what it was supposed to be. If you are reviewing a change, review
what the change does, not what its description says it does.

Say what is wrong, where, and what would show it. A finding with no way to check it is an opinion.

If you were given something to look at and it is fine, say it is fine. Inventing a problem to have
something to report is worse than an empty report.
`,
}

/**
 * Make sure the files exist, and hand back the two that apply to this card.
 *
 * A role with no seed of its own still gets the shared file, and gets no role file rather than a
 * generic one: a card told something vague about its role is worse off than a card told nothing,
 * because it will act on it.
 */
export function ensureRoots(roleClass: string | null): { dir: string; shared: string; role: string | null } {
  const dir = rootsDir()
  const shared = join(dir, 'ALL.md')
  seed(shared, ALL)

  for (const [id, body] of Object.entries(ROLE_SEEDS)) {
    if (ROLE_POWERS[id] || id === 'specialist') seed(join(dir, 'roles', `${id}.md`), body)
  }

  const role = roleClass && ROLE_SEEDS[roleClass] ? join(dir, 'roles', `${roleClass}.md`) : null
  return { dir, shared, role }
}

/* ------------------------------------------------------------------------------------------------
 * Per-card roots.
 *
 * The three tiers above answer "what is this kind of card told". They cannot answer "what does THIS
 * card have", because a role is a kind and a card is a spot, and two cards of the same role on the
 * same board routinely need different tools. Canon: `docs/canonical/12-how-a-card-is-hired.md`.
 *
 * The mechanism is `--plugin-dir`, which loads a directory as a plugin for one session only. A
 * plugin carries skills, agents, hooks and commands, so pointing it at the card's own directory is
 * what turns the bottom port from a drawing into a delivery. There is no other route: skill
 * discovery is otherwise fixed to the working directory and the user config directory, and every
 * card on a board shares one working directory. `CLAUDE_CONFIG_DIR` would work and is not used,
 * because on Windows it relocates `.credentials.json` and every card would need its own login.
 * ---------------------------------------------------------------------------------------------- */

/** One row of a card's reading index. The trigger is a task shape, never a topic label. */
export interface ReadingRow {
  /** What to open. */
  what: string
  /** The condition that means open it now, phrased as something the card can match a task against. */
  when: string
  /** Absolute path. Never a body: the point of a board is that each card carries a narrow context. */
  path: string
}

export interface CardRootChoices {
  /** Skill names to snapshot into this card. Omit to take the role's default set. */
  skills?: string[]
  /** Agent definition names to snapshot into this card. */
  agents?: string[]
  /** The reading index. */
  reading?: ReadingRow[]
  /** A hooks.json body, for a card that needs its own hooks on top of the shared spine. */
  hooks?: unknown
}

/**
 * What Garden put here, as opposed to what the card added itself.
 *
 * Refresh re-copies only the names in this manifest. Without it, refresh either wipes what a card
 * collected for itself or never updates anything, and both of those are worse than drift.
 */
interface RootsManifest {
  skills: string[]
  agents: string[]
  refreshed: string
}

const MANIFEST = 'garden-roots.json'

/** Where a skill of a given name can be found, hirer's own set first. */
function skillSources(hirerDir: string | null, projectPath: string | null): string[] {
  const dirs: string[] = []
  if (hirerDir) dirs.push(join(hirerDir, 'skills'))
  if (projectPath) dirs.push(join(projectPath, '.claude', 'skills'))
  dirs.push(join(homedir(), '.claude', 'skills'))
  return dirs
}

function agentSources(hirerDir: string | null, projectPath: string | null): string[] {
  const dirs: string[] = []
  if (hirerDir) dirs.push(join(hirerDir, 'agents'))
  if (projectPath) dirs.push(join(projectPath, '.claude', 'agents'))
  dirs.push(join(homedir(), '.claude', 'agents'))
  return dirs
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Copy one skill into the card, and say whether it was found.
 *
 * A skill that cannot be found is reported rather than silently skipped. A card briefed to use a
 * skill it does not have will discover that only at the moment it tries, which is the most expensive
 * moment to discover it.
 */
function snapshotSkill(name: string, into: string, from: string[]): boolean {
  for (const dir of from) {
    const src = join(dir, name)
    if (isDir(src) && existsSync(join(src, 'SKILL.md'))) {
      cpSync(src, join(into, name), { recursive: true })
      return true
    }
  }
  return false
}

function snapshotAgent(name: string, into: string, from: string[]): boolean {
  for (const dir of from) {
    const src = join(dir, `${name}.md`)
    if (existsSync(src)) {
      mkdirSync(into, { recursive: true })
      cpSync(src, join(into, `${name}.md`))
      return true
    }
  }
  return false
}

/**
 * Build the card's directory into something `--plugin-dir` will load.
 *
 * The name is the directory's own, which already carries the card id, so two cards never collide.
 */
function writePluginManifest(cardDir: string, cardTitle: string) {
  const dir = join(cardDir, '.claude-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name: basename(cardDir),
        version: '1.0.0',
        description: `Roots for the card "${cardTitle}". Written by the card that hired it.`,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
}

function readManifest(cardDir: string): RootsManifest {
  try {
    const parsed = JSON.parse(readFileSync(join(cardDir, '.claude-plugin', MANIFEST), 'utf8'))
    return {
      skills: Array.isArray(parsed?.skills) ? parsed.skills.map(String) : [],
      agents: Array.isArray(parsed?.agents) ? parsed.agents.map(String) : [],
      refreshed: typeof parsed?.refreshed === 'string' ? parsed.refreshed : '',
    }
  } catch {
    return { skills: [], agents: [], refreshed: '' }
  }
}

/**
 * The index that makes a large root set affordable.
 *
 * Written whole every time, because it is Garden's half. What it never contains is a body: canon on
 * the 0.5 board runs to 107 documents and the largest single one is 125KB, so anything inlined here
 * would cost more than the rest of the card's context put together.
 */
function writeReadingIndex(cardDir: string, cardTitle: string, rows: ReadingRow[], memoryDir: string) {
  const lines = [
    `# What ${cardTitle} reads, and when`,
    '',
    'Garden writes this file. Open something from it when the condition next to it matches the task',
    'you were just handed, and not otherwise. Reading widely to feel prepared is the exact behaviour',
    'that cancels the reason this board exists.',
    '',
    '## Always, before you act',
    '',
    `- \`${join(memoryDir, 'LESSONS.md')}\` arrives in your startup context. It is corrections, so it`,
    '  comes before anything you do rather than after.',
    '',
    '## On demand',
    '',
    '| Open | When | Path |',
    '| --- | --- | --- |',
  ]
  const all: ReadingRow[] = [
    {
      what: 'NOTES.md',
      when: 'you are picking a task back up and need the current picture',
      path: join(memoryDir, 'NOTES.md'),
    },
    {
      what: 'PLAYBOOK.md',
      when: 'you are about to do this job again and want how you did it last time',
      path: join(memoryDir, 'PLAYBOOK.md'),
    },
    ...rows,
  ]
  for (const r of all) lines.push(`| ${r.what} | ${r.when} | \`${r.path}\` |`)
  lines.push(
    '',
    'If a document you were sent to contradicts what you were told, say so and report it up. Do not',
    'resolve it yourself, and do not edit canon: canon changes from the top when work proves it',
    'wrong, never from below to match what happened.',
    '',
  )
  writeFileSync(join(cardDir, 'ROOTS.md'), lines.join('\n'), 'utf8')
}

/**
 * Compose one card's roots. Called when a card is hired, and again by `refreshCardRoots`.
 *
 * Everything it writes is Garden's half and is rewritten whole. It never touches `LESSONS.md`,
 * `NOTES.md`, `PLAYBOOK.md`, anything below the marker in `CLAUDE.md`, or a skill the card put in
 * its own directory that this call was not asked for.
 */
export function composeCardRoots(
  cardDir: string,
  card: { title: string; roleClass: string | null },
  choices: CardRootChoices,
  sources: { hirerDir?: string | null; projectPath?: string | null },
  now: string,
): { skills: string[]; agents: string[]; missing: string[] } {
  mkdirSync(cardDir, { recursive: true })
  writePluginManifest(cardDir, card.title)

  const wantSkills =
    choices.skills ??
    (card.roleClass ? ROLE_SKILLS[card.roleClass] : undefined) ??
    DEFAULT_SKILLS
  const wantAgents = choices.agents ?? []
  const missing: string[] = []

  const skillDir = join(cardDir, 'skills')
  mkdirSync(skillDir, { recursive: true })
  const skillFrom = skillSources(sources.hirerDir ?? null, sources.projectPath ?? null)
  const gotSkills: string[] = []
  for (const name of wantSkills) {
    if (snapshotSkill(name, skillDir, skillFrom)) gotSkills.push(name)
    else missing.push(`skill:${name}`)
  }

  const gotAgents: string[] = []
  if (wantAgents.length > 0) {
    const agentDir = join(cardDir, 'agents')
    const agentFrom = agentSources(sources.hirerDir ?? null, sources.projectPath ?? null)
    for (const name of wantAgents) {
      if (snapshotAgent(name, agentDir, agentFrom)) gotAgents.push(name)
      else missing.push(`agent:${name}`)
    }
  }

  if (choices.hooks) {
    const hookDir = join(cardDir, 'hooks')
    mkdirSync(hookDir, { recursive: true })
    writeFileSync(join(hookDir, 'hooks.json'), JSON.stringify(choices.hooks, null, 2) + '\n', 'utf8')
  }

  writeReadingIndex(cardDir, card.title, readingRowsFor(card.roleClass, choices.reading ?? []), cardDir)

  const manifest: RootsManifest = { skills: gotSkills, agents: gotAgents, refreshed: now }
  writeFileSync(
    join(cardDir, '.claude-plugin', MANIFEST),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )

  return { skills: gotSkills, agents: gotAgents, missing }
}

/**
 * Make the card's directory loadable, without re-snapshotting anything.
 *
 * Called on every launch, so it must be cheap and it must not undo tailoring. It writes only the
 * two files that are unambiguously Garden's, the plugin manifest and the reading index, and it
 * composes from scratch exactly once, when the card has no manifest yet and therefore has never
 * been composed. Re-copying skills here would make the snapshot a live mirror in everything but
 * name, and the owner chose snapshot precisely so two cards of the same role can differ.
 */
export function ensureCardRoots(
  cardDir: string,
  card: { title: string; roleClass: string | null },
  sources: { hirerDir?: string | null; projectPath?: string | null },
  now: string,
  reading?: ReadingRow[],
): void {
  if (!existsSync(join(cardDir, '.claude-plugin', MANIFEST))) {
    composeCardRoots(cardDir, card, { reading }, sources, now)
    return
  }
  writePluginManifest(cardDir, card.title)
  /*
   * Rewritten every launch now, not only when a caller happens to pass rows. This one small index
   * file is cheap, and it is the only way a card already hired before an orchestrator-only entry
   * was added — the live 0.5 Orchestrator among them — ever picks the new entry up, since nothing
   * else in this branch touches its reading index at all.
   */
  writeReadingIndex(cardDir, card.title, readingRowsFor(card.roleClass, reading ?? []), cardDir)
}

/**
 * Push a changed essential down to one card.
 *
 * The owner chose snapshot plus refresh over a live shared file, so that two cards of the same role
 * can differ. The cost of that choice is drift, and this is what pays it: it re-copies only what the
 * manifest says Garden put here, so a skill the card collected for itself survives, and so does
 * everything below the marker in its brief.
 */
export function refreshCardRoots(
  cardDir: string,
  card: { title: string; roleClass: string | null },
  sources: { hirerDir?: string | null; projectPath?: string | null },
  now: string,
  reading?: ReadingRow[],
): { skills: string[]; agents: string[]; missing: string[] } {
  const previous = readManifest(cardDir)
  return composeCardRoots(
    cardDir,
    card,
    {
      skills: previous.skills.length > 0 ? previous.skills : undefined,
      agents: previous.agents,
      reading,
    },
    sources,
    now,
  )
}
