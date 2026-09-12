# Operating Garden

`README.md` is how to run it. `DEVELOPMENT.md` is how it came to work the way it does. This file is
the manual for the verbs: making a card, changing one, wiring two together, what each role is
refused, and what a session is equipped with before it does anything.

It is written for the agent as much as for the person. A session working inside this repository
should be able to answer "how do I hire a reviewer" from here without reading the server.

---

## The board in one paragraph

A project is a tab. On a tab there are cards, and a card is one CLI session with a title, a role, a
mailbox and a directory of its own that survives being switched off. A wire between two cards is what
permits one to send to the other; without a wire the send is refused with a reason. Documents and
webs are also cards, so the same canvas holds the work and the things the work is about.

Two processes serve it: the backend on 5178 and, in development, Vite on 5177. Server changes are
live only after the backend restarts, which ends every session on the board.

---

## Making a card

There are two routes and they produce the same thing.

**From the board.** Right-click empty canvas. The menu makes a session card, a document card, a web,
or a To Do card. This is the owner's route and it needs no shell.

**From inside a session**, which is the route an orchestrator uses:

```
node "%GARDEN_BIN%\garden-hire.mjs" --title "Loader worker" --role worker --file <roots path>
node "%GARDEN_BIN%\garden-hire.mjs" --start <card id>
```

`GARDEN_BIN` is set in every session Garden spawns. The roots are required and must come from a file
or stdin, never from inside the command: a real set runs to thousands of characters, and a command
carrying that much prose cannot be security scanned, so it stops and waits for a human.

Flags: `--reports-to <id>` draws the wire as it creates, `--owns "path,path"` records what the card
owns, `--model` and `--effort`, `--team-size <n>` for a card that will hire, `--adapter` (default
`claude`). The card comes back **switched off**, whole: mailbox, brief, peers and reading index all
written. Start it as a separate step, after its notes and its work order exist.

The full procedure, including what to decide before any of this, is the `hiring-a-card` skill in
`.claude/skills/`. Templates for the roots themselves are in `templates/roots/`.

## Changing a card

Everything on a card except its role can be changed while it runs: title, model, effort, team size,
owned paths, whether it may use subagents. The board's card menu is the owner's route.

**The role is the exception.** A role selects the permission set the CLI is launched with, and the
CLI reads its permissions once at launch. Changing a role takes effect at the card's next start, not
immediately, so treat it as "stop, change, start" rather than as an edit.

Deleting a card is deliberate and separate. `server/bin/garden-board.mjs` is the maintenance shim:

```
node garden-board.mjs --list [--project <id>]
node garden-board.mjs --reap [--project <id>]        what WOULD go, and nothing else
node garden-board.mjs --reap --yes                   actually delete them
node garden-board.mjs --rename <id> --title "New name"
node garden-board.mjs --stuck [--mins N]
node garden-board.mjs --tail <id> [--lines N] [--grep <re>]
```

`--reap` without `--yes` changes nothing. That is not politeness, it is the rule this project is
built on: cards are never lost to a single keystroke.

## Wires

A wire is permission, not decoration. `socketMaySend` refuses a message between two cards that are
not wired, and says why.

```
node "%GARDEN_BIN%\garden-wire.mjs" --to "DEF side"                  wire the caller to that card
node "%GARDEN_BIN%\garden-wire.mjs" --from "ATK side" --to "DEF side"  wire two other cards
node "%GARDEN_BIN%\garden-wire.mjs" --to "Scout" --label "search"    name the line on the board
node "%GARDEN_BIN%\garden-wire.mjs" --to "Scout" --one-way           caller speaks, far end cannot answer
```

Titles resolve inside the caller's own project and nowhere else. A title matching two cards is
refused rather than guessed at, because picking one silently is how a message reaches the wrong card
and nobody finds out for a day.

A drawn wire that has never carried a message is not yet a wire. Send one each way and confirm the
reply before handing over real work.

## Sending

```
node "%GARDEN_BIN%\garden-send.mjs" --to <card id> --kind done --task T-12 --file <path>
node "%GARDEN_BIN%\garden-send.mjs" --to "Loader team" --kind work --task T-12 --text "one short line"
```

The body goes in a file. `--text` survives only for short lines with no quotes in them, because a
quote inside an argument is reopened by the shell before the script runs and the tail is lost.

The kind is required rather than inferred from the prose, so the board can tell a question from a
result without reading either.

Related shims, all from inside a session:

```
node "%GARDEN_BIN%\garden-status.mjs"             every card on this board, read only
node "%GARDEN_BIN%\garden-task.mjs" show --task T-12
node "%GARDEN_BIN%\garden-asks.mjs"               what is waiting on the owner
node "%GARDEN_BIN%\garden-rotate-inbox.mjs"       report what it WOULD archive
node "%GARDEN_BIN%\garden-loop.mjs" --off --card "<title>"
```

---

## Permissions, and which of them are enforced

Three separate systems refuse things. Confusing them is the usual reason somebody thinks the app is
broken.

**1. The role's deny list, enforced by the CLI.** Each role is launched with tools denied outright.
This is the CLI's own permission layer refusing a tool, not Garden asking nicely.

| Role | Creates board cards | Subagents | Denied outright by the CLI |
| --- | --- | --- | --- |
| `orchestrator` | yes | yes | nothing |
| `manager` | no | yes | nothing |
| `worker` | no | no | `Agent`, `SendMessage`, `TaskCreate/Update/Get/List` |
| `verifier` | no | no | the worker's list plus `MultiEdit`, `NotebookEdit` |
| `reviewer` | no | no | all of those plus `Write`, `Edit`, `Bash`, so it can only read |
| `specialist` | no | yes | **nothing.** See below. |

`boss` and `delegator` are older names kept for cards that predate the change. Both run as a manager.

The specialist row is not a typo and is worth knowing before you rely on it. `specialist` has a role
brief and a skill set but no entry in `ROLE_POWERS`, so the CLI refuses it nothing: a specialist is a
narrow context and a short brief, not a narrow permission set. Hire a worker when the refusal has to
be enforced rather than asked for.

The table itself is `ROLE_POWERS` in `packages/shared/src/index.ts`, and each card is told its own
copy in `POWERS.md`. Never hand-write a second copy of a deny list into a brief: a card told the
editing tools are denied while a shell sits open stops trusting the whole brief.

**2. The board ceiling, enforced by the server.** Three limits, each refusing with its own count:
cards on the board, cards running at once, and children of one card (`--team-size`, falling back to
the board's figure). The ceiling is checked before the role is, and it applies to every path
including the owner's. There is no hurry exception.

**3. Task authority, which is a project setting.** At `enforce`, a socket carrying neither the owner
key nor a card token becomes a guest and may only read. Below that, an unidentified connection is
treated as the owner. Read it and set it with:

```
node "%GARDEN_BIN%\garden-task.mjs" authority
node "%GARDEN_BIN%\garden-task.mjs" authority enforce
```

Guards are the one thing that is never tailored per card. They refuse destructive actions, and a
per-card guard set would mean hiring a card into permission to do the exact thing a guard exists to
stop.

---

## What a card is equipped with

A card's directory is its roots, at `~/.garden/memory/<project>/<title>-<id8>/`. It is loaded as a
plugin for that session alone, so whatever is in it belongs to that card and to no other.

| Column | Per card | How it reaches the session |
| --- | --- | --- |
| Instructions | yes | `--append-system-prompt-file <cardDir>/CLAUDE.md`, whole |
| Memory | yes | `LESSONS.md` at start; `NOTES.md` and `PLAYBOOK.md` named in the index |
| Research | yes | paths in `ROOTS.md`, never bodies |
| Settings | yes | `--settings ~/.garden/hooks/sessions/<cardId>.json` |
| Skills | yes | `--plugin-dir <cardDir>`, plus `--setting-sources project` to drop the user layer |
| Agents | yes | the same pair, from `<cardDir>/agents/` |
| Hooks | yes, plus a shared spine | `<cardDir>/hooks/hooks.json` |
| Guards | no, inherited | the project's own guards fire on every card |

Skills are copied in at hire from the first place that has one by that name: the hirer's own set, the
project's `.claude/skills/`, then the machine's `~/.claude/skills/`. Copies rather than pointers, so
two cards of the same role can differ. A skill added to a role later is topped up at the card's next
launch, and the top-up only ever adds: a folder already there is left exactly as it is.

**What each role keeps** is `ROLE_SKILLS` in `packages/shared/src/index.ts`, and the skills
themselves ship in `.claude/skills/`:

| Skill | Who keeps it | What it is for |
| --- | --- | --- |
| `hiring-a-card` | orchestrator | the procedure for creating a card and giving it a role |
| `canon-library` | orchestrator | writing and revising the description of what the app is |
| `card-roots` | orchestrator, manager | what makes a set of roots worth having |
| `double-blind-review` | orchestrator, manager | verifying a visible change without grading your own screenshot |
| `session-claims` | all but reviewer and verifier | not colliding with another session in the same checkout |
| `exit-interview` | every role | closing a session by writing what was learned where it survives |

A worker keeps only the last two. It hires nobody, so `card-roots` would describe something it cannot
do, and it is denied `Agent`, so `double-blind-review` would brief it to spawn a reviewer it cannot
spawn. A brief describing a refused capability is worse than no brief.

`canon-library` is deliberately withheld from every role that does the work. A card that can both do
the work and revise the description of what the work was meant to be can never be found wrong.

`hiring-a-card` is the orchestrator's alone because the orchestrator is the only role that may create
one. Giving a manager the procedure would describe a command its own runtime refuses.

## The orchestrator, and what it comes equipped with

One card per board talks to the owner, owns the canon, and is the only one that may bring another
card into existence. It is the funnel rather than a restriction: nothing is denied to it, so the
limit that matters is the ceiling, which refuses it like anyone else.

A new orchestrator starts from `templates/roots/orchestrator.md`. It is hired like any other card,
with `--role orchestrator`, and comes up holding the six skills above.

What it is expected to do rather than delegate: keep the canon current, keep `TODO.md`, hold the
registry of which cards exist and what each is for, and ask the owner a question only when the answer
changes what happens next.

## The to-do list

`TODO.md` at the project root is the whole list, and a card's personal list is the subset of lines
ending `@Card title`. There is no second copy, so the two can never disagree. A bar above each card
draws its own progress; ticking an item there writes `[x]` back into that one file.

The list is per project. A card title is unique inside a board and nowhere else, so `@Orchestrator`
means a different card depending on which file the line is in.

## Loops

A loop types a prompt into a card every N minutes, and appears in the rail's Loops section where it
is started, stopped and deleted.

```
node "%GARDEN_BIN%\garden-loop.mjs" --on  --card "Orchestrator" --minutes 15 --prompt-file tick.md
node "%GARDEN_BIN%\garden-loop.mjs" --off --card "Orchestrator"
node "%GARDEN_BIN%\garden-loop.mjs" --delete --card "Orchestrator"
```

Starting a loop types immediately rather than waiting out the first interval. A card may switch its
own loop off, which is how a loop pointed at a to-do list ends when the list does.

---

## Where to read further

`DEVELOPMENT.md` for the architecture and the decisions already settled. `.claude/skills/` for the
procedures a session is expected to follow. `server/bin/README.md` for the shims. The canon library
that records what the owner asked for and when is private to his board and is not published.
