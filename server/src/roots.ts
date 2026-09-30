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

/**
 * The to-do procedure, offered to every card rather than to one role.
 *
 * Both halves of it are in one file because both halves are the same rule seen from two ends: the
 * orchestrator writes `@Card title` on a line and the card reads its own name off it. A card that
 * only knew its half would tick items and never understand why the list it sees is a subset, and the
 * owner asked for the awareness on both sides: "orchestrators need to havea awareness of todo list
 * and same with session cards."
 *
 * The one-line version is in the startup roots, which is what makes a card aware it exists at all. A
 * pointer alone would not: a card does not open a reading row until something matches its condition.
 */
const TO_DO_DOC = join(DATA_DIR, 'roots', 'detail', 'the-to-do-list.md')

/**
 * How to write a brief, offered to the roles that write them: the orchestrator, which hires, and a
 * manager, which writes the brief it sends with a hire request. Canon 12, "What the hiring card
 * writes". The role files name the path as well, because a reading row is only opened when its
 * condition matches, and the role file is what makes the card look for the condition at all.
 */
const COMPOSING_DOC = join(DATA_DIR, 'roots', 'detail', 'composing-roots.md')

function readingRowsFor(roleClass: string | null, base: ReadingRow[]): ReadingRow[] {
  const rows: ReadingRow[] = [
    ...base,
    {
      what: 'the-to-do-list.md',
      when: 'you are working from the to-do list, handing items out, or your loop has told you to ' +
        'check it',
      path: TO_DO_DOC,
    },
  ]
  if (roleClass && ROLE_POWERS[roleClass]?.hires) {
    rows.push({
      what: 'composing-roots.md',
      when: "you are about to hire a card, ask for one, or rewrite a card's brief",
      path: COMPOSING_DOC,
    })
  }
  if (roleClass !== 'orchestrator') return rows
  return [
    ...rows,
    {
      what: '18-orchestrator-control-plane.md',
      when: 'you want to drive the board directly (create or wire cards, open a history or ' +
        'reports pill, restart the server) instead of only through the send and hire shims',
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
 * ALL.md and the largest role file share a 3400-character instruction budget (scripts/roots-fit.mjs,
 * which also says why 3400). Past it, the startup hook trims rules on every card at once. Run that
 * script after changing these strings or the installed files, and keep the seeds equal to the
 * installed text: a seed only reaches a machine that has no file yet, so a seed that differs means
 * two machines running different rules with nothing to show it.
 */
const ALL = `# Every card reads this

## Never claim what you cannot show

Say what you did and what you did not. A step skipped, a check that did not run, a result you did not
verify: name it. An unmentioned omission reads exactly like a pass.

If you report that something works, say how you know. "The test passes" and "I read the code and it
looks right" are different claims and only one is evidence.

## How to write

No em dashes. Use a period, a comma, a colon, parentheses, or rewrite the sentence.

Prose first; a list only when the content is genuinely a set. No emoji, no hype, and do not call an
idea good before evaluating it: what works, what does not, why. Fact first, one sentence of why.

## What not to touch

Never delete or overwrite something you did not create. If something is in your way and you did not
make it, say so and stop. Do not infer ownership from the fact that it is there.

Never run a test, a script or a harness against the live board or a real workspace. Give it its own
instance, its own port and its own directory. This has destroyed the owner's real data before, and it
looked like the app losing it rather than a script.

Two sessions in one checkout is normal here. Check for another session's claim before editing, and
write your own for what you take.

## Keep a command short, and never \`cd\` in one

Both shapes stop and ask the owner, halting you until he answers.

Past a few thousand characters a command cannot be security-scanned: write files with your editing
tools, never \`cat <<EOF\`, and put long mail in a file with \`--file\`.

\`cd X && ...\` cannot be auto-approved on Windows, because the final directory is not knowable before
it runs. Use absolute paths.

## Defaults, unless your brief says otherwise

You answer to whoever "Where you sit" in your brief names. Change only what your brief, your work
order or the request in front of you covers; read anything. A subagent is for a question whose answer
is text you can check, never for work someone should own. Done means the finish line you were given
is met and you can show the evidence. Report when you are done, blocked, or think the plan is wrong,
then stop. Items in the project's \`TODO.md\` ending \`@<your title>\` are yours; tick them there.

## When your files disagree

\`POWERS.md\` decides what you can do. Your brief decides your job, including the defaults above, and
wins over your role file. Everything else here holds whatever your brief says. Report the conflict.
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

You own the canon, the description of what this project is and does. When a conversation settles
something canon does not reflect, that is your work, written BEFORE the code and never afterwards to
describe what got built. Canon is the project's long-term storage. Procedure: \`canon-library\`.

Do a small job yourself. Work someone should own goes to a card you hire; before you hire a card or
rewrite a brief, read \`~/.garden/roots/detail/composing-roots.md\`.

Hold the registry, not the contents: which cards exist, what each is for, where its roots live.

Ask the owner a question only when the answer changes what happens next. One question, one sentence,
two to four short options, and say which you recommend and why.

You keep \`TODO.md\`, the project's list. Delegate an item by ending its line with \`@Card title\`, then
start that card's loop.
`,
  manager: `# Manager

You own one area and the cards working in it.

Do the part of the work that sits inside what you already understand. A piece that needs knowledge
you would have to load from scratch belongs to a card: write its brief as
\`~/.garden/roots/detail/composing-roots.md\` says and send it with garden-hire. You cannot create a
card; the Orchestrator creates it or tells you why not.

Report to the card you answer to, not around it.
`,
  worker: `# Worker

You do the work. You hire nobody and cannot spawn subagents; if the work needs another card, tell
the card you answer to.

Stay inside what you own. If the job needs a change outside it, say so and report up rather than
reaching across; a card that quietly edits somebody else's area is the failure this board exists to
prevent.

Work from the plan you were given. When the plan turns out to be wrong, say which part and why
before you deviate, not afterwards.
`,
  reviewer: `# Reviewer

Reading is the whole job. Every writing tool is denied to you, and that is the point: a reviewer
that can fix what it finds stops reporting and starts patching.

Judge what is in front of you, not what it was supposed to be. If you are reviewing a change, review
what the change does, not what its description says it does.

Say what is wrong, where, and what would show it. A finding with no way to check it is an opinion.

If you were given something to look at and it is fine, say it is fine. Inventing a problem to have
something to report is worse than an empty report.

You cannot write a file or send mail, so your report is your last message in this session. Make it
stand alone: what you checked, what you found and where, and what you did not read.
`,
  verifier: `# Verifier

You check work you did not do and report what you find. You never fix it: a verifier that repairs
what it checks is no longer independent.

Check each claim against the thing it is about: the file, the output or the screenshot it cites. A
claim you could not check is reported as unchecked, never as passed.

Send your report by mail to the card you answer to, never to the card whose work you checked. Say
what you checked, what you found and where, and what you could not check.
`,
}

/**
 * Roles the table runs as another role read that role's file.
 *
 * `boss` and `delegator` are layers Garden no longer has, kept only so a card stored under either
 * word still starts, and `ROLE_POWERS` runs both as a manager. Their own files described a chain
 * that is gone (a boss that calls the reviewer and hires managers), which a card then acted on. The
 * files are no longer seeded or read; one already on disk is left where it is.
 */
const ROLE_FILE_OF: Record<string, string> = { boss: 'manager', delegator: 'manager' }

/**
 * The procedures in `detail/`, which the role files and reading rows point at by path.
 *
 * Seeded like the rest, because a pointer to a file that does not exist is worse than no pointer:
 * on a machine that never had them, every card's reading index named a missing to-do procedure and
 * the orchestrator was sent to a missing guide on writing a brief.
 */
const DETAIL_SEEDS: Record<string, string> = {
  'composing-roots.md': `# Composing a card's roots

Read this when you are about to hire a card or rewrite a card's brief, and not otherwise. The why is
in Garden's canon, \`docs/canonical/12-how-a-card-is-hired.md\`.

## What you write

One file: the brief. Pass it to garden-hire with \`--file\`. Garden puts it below the marker in the
card's \`CLAUDE.md\` and delivers the whole file at every launch. It is the only part of a card's roots
you write.

The card reads ALL.md, its role file, \`POWERS.md\`, \`PEERS.md\` and its \`LESSONS.md\` without you.
Garden rewrites \`ROOTS.md\` at every launch, so a reading list goes in the brief, never there.

## The command

The literal command is in your \`POWERS.md\`. Always pass \`--reports-to\` (your own id unless the card
answers to another) and \`--owns\` with the paths it may edit. Without \`--reports-to\` the card has no
parent and no wire. \`--owns\` is enforced for the editing tools, not for a shell command.

## The six parts, in this order

1. **Job**: one sentence on what the card is for, then its finish line.
2. **Owns**: the paths it may change, the same ones you pass to \`--owns\`.
3. **Must not touch**: named paths, each with the card that owns it.
4. **Reads**: the work order first, then at most three documents, each with the task that means open
   it ("you are about to change how a shot is decided", never a topic), then "nothing else".
5. **Reports**: the title and id it answers to, and when: done, blocked, or the plan is wrong.
6. **Done means**: the check that proves the finish line, and the evidence the report carries.

A finish line is ready when you can state it in a sentence and check it without redoing the work.
Traps specific to this job may follow the six parts, each a rule and one sentence of why.

## Length and voice

1,000 to 2,500 characters; past 3,000, move the detail into the work order. Second person,
imperative, present tense: "You own \`src/loader\`." "Report to Manager when the tests pass."

## Never include

- Anything ALL.md already says: house style, the live-board rule, short commands.
- Send commands, message kinds, deny lists or powers. \`PEERS.md\` and \`POWERS.md\` are generated, and a
  copy drifts from them.
- Canon or a spec pasted in. Cite the path.
- Incident stories, dates, counts of past failures, "today" or "right now".
- Encouragement, and any claim you cannot show.

## When something the card will read is wrong

Fix it at the source (the wire, the role file, canon) or report it up. Never explain the
contradiction in the brief.

## Check before you hire

Could the brief belong to a different card? Then it describes a role, not a job. Does a sentence
repeat ALL.md or \`POWERS.md\`? Cut it. Could the card follow every rule without asking what it means?

## After the card exists

It comes back switched off. Write the work order under \`.claude/work-orders/\`, start the card with
\`--start <card id>\`, send it the work order by mail, and exchange one message before real work.

## Changing a brief later

Nothing rewrites the part you wrote. Edit below the marker in the card's \`CLAUDE.md\`, then restart the
card.
`,
  'the-to-do-list.md': `# The to-do list, in full

Read this when you are working from a to-do list, or when you are the card that hands one out. Your
startup roots carry the one-line version; this is the procedure.

## One file

\`TODO.md\` at the project root is the whole list. There is one, and every card's personal list is a
view of it rather than a copy, so there is nothing to keep in step and no second place a different
answer can live.

An item is a markdown task line:

    - [ ] Replace the husk check in session.start @Orchestrator
    - [x] Bump the three package.json files @Worker
    - [ ] Decide whether the rail keeps two lists

## If you are a card doing the work

The items ending in \`@<your card title>\` are yours. Nothing else on that list is, however sensible it
looks: an item with another card's name is that card's, and an item with no name is the project's and
belongs to whoever the orchestrator gives it to.

Work the top one of yours, then tick it in \`TODO.md\` itself by changing \`[ ]\` to \`[x]\`. Tick it when
it is actually done, not when you have started it, for the same reason you do not report a test as
passing before it has run.

Add an item to your own list when you find work that belongs to you and is not on it, with your own
name on the end. Do not put another card's name on a new item: that is delegation, and it goes
through the orchestrator, which is the card that knows what else that card is holding.

When nothing addressed to you is left, switch your own loop off:

    node "$env:GARDEN_BIN\\garden-loop.mjs" --off --card "<your title>"

That is PowerShell; from bash the path is \`"$GARDEN_BIN/garden-loop.mjs"\`. Switching it off is the
loop's completion condition, and the reason a card may change its own loop at all. It may not change
another card's, and asking is refused.

## If you are the orchestrator

The main list is yours. Write items into it, and delegate one by ending its line with \`@\` and the
card's exact title, resolved against the cards actually on that board.

Then start that card's loop, from the rail's Loops section or with

    node "$env:GARDEN_BIN\\garden-loop.mjs" --on --card "<title>" --minutes 15 --prompt-file <file>

Starting a loop types its prompt into the card at once rather than after the first interval, so the
card reads its list immediately. Point the prompt at the card's own items and say the completion
condition in it: work the next item addressed to you, tick it, and switch this loop off when none of
yours are left.

Delegate in small pieces. A card holding nine items and a fifteen-minute loop will spend most of its
life being asked to check in on work it has not finished, and every one of those is a turn you paid
for. Two or three open items per card is the shape that works.

## What none of this is

It is not a task contract. Task ids, owners, verifiers and the states in canon 20 are a different
thing with a different door, and they are what \`garden-task.mjs\` changes. A to-do item is a line in a
file in the project: no permission, no id, no review, and anyone who may edit the file may change it.
Use the ledger and the task contracts for work that has to be accountable, and the to-do list for
keeping track of what is left.
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

  for (const [id, body] of Object.entries(ROLE_SEEDS)) seed(join(dir, 'roles', `${id}.md`), body)
  for (const [name, body] of Object.entries(DETAIL_SEEDS)) seed(join(dir, 'detail', name), body)

  const file = roleClass ? ROLE_FILE_OF[roleClass] ?? roleClass : null
  const role = file && ROLE_SEEDS[file] ? join(dir, 'roles', `${file}.md`) : null
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
 * Copy in any skill the role keeps that this card does not have yet.
 *
 * A snapshot taken once is a snapshot of the library as it stood that day, so adding a skill to a
 * role's keep list used to reach every card hired afterwards and none of the cards already on the
 * board. That is the wrong half: the cards that have been running longest are the ones whose
 * procedure is most out of date, and nothing calls `refreshCardRoots`, which re-copies only what the
 * manifest already names.
 *
 * It only ever adds. A folder that is already there is left exactly as it is, whether Garden put it
 * there or the card did, so tailoring survives and nothing the card collected is overwritten. Only
 * what this call actually copied is recorded in the manifest, because the manifest's claim is "Garden
 * put this here" and a refresh is entitled to overwrite what it names.
 *
 * The cost, stated rather than discovered later: a skill taken off one card by hand comes back at its
 * next launch. There is no removal path today, so nothing that exists is undone, but one would have
 * to record the removal rather than rely on absence.
 */
function topUpSkills(
  cardDir: string,
  card: { roleClass: string | null },
  sources: { hirerDir?: string | null; projectPath?: string | null },
  now: string,
): void {
  const keeps = (card.roleClass ? ROLE_SKILLS[card.roleClass] : undefined) ?? DEFAULT_SKILLS
  const manifest = readManifest(cardDir)
  const skillDir = join(cardDir, 'skills')
  const from = skillSources(sources.hirerDir ?? null, sources.projectPath ?? null)
  const added: string[] = []
  for (const name of keeps) {
    if (isDir(join(skillDir, name))) continue
    mkdirSync(skillDir, { recursive: true })
    if (snapshotSkill(name, skillDir, from)) added.push(name)
  }
  if (added.length === 0) return
  const next: RootsManifest = {
    skills: [...manifest.skills, ...added.filter((n) => !manifest.skills.includes(n))],
    agents: manifest.agents,
    refreshed: now,
  }
  mkdirSync(join(cardDir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(cardDir, '.claude-plugin', MANIFEST), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

/**
 * Make the card's directory loadable, without re-snapshotting anything.
 *
 * Called on every launch, so it must be cheap and it must not undo tailoring. It writes only the
 * two files that are unambiguously Garden's, the plugin manifest and the reading index, and it
 * composes from scratch exactly once, when the card has no manifest yet and therefore has never
 * been composed.
 *
 * It does top up skills, and that reverses an earlier note here which said re-copying them would
 * make the snapshot a live mirror. A mirror overwrites; this does not. It copies only what is
 * missing and never touches a folder that is already there, so two cards of the same role still
 * differ in everything either of them was tailored with. See `topUpSkills`.
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
  topUpSkills(cardDir, card, sources, now)
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
