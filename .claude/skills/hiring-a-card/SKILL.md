---
name: hiring-a-card
description: The procedure for bringing a new card into existence on a Garden board and giving it a specialized role - deciding whether it should be a card at all, picking the roleClass that decides what its runtime refuses, writing and delivering its roots, the literal garden-hire.mjs commands in the order they have to run, how a card gets a skill no other card has, and how to prove the card came up as the thing you hired. Use when asked to hire, create, spin up, add or set up a card, a worker, a reviewer, a verifier, a specialist or a manager, when handing a piece of the project to somebody new, or when a card already exists and is answering as the wrong thing.
---

# Hiring a card

Two documents already say what to write. `card-roots` says what makes a set of roots worth having,
and `~/.garden/roots/detail/composing-roots.md` says what the eight columns are. Neither says how to
make the card. This does: the decisions in the order they have to be made, and the commands.

Canon: `docs/canonical/12-how-a-card-is-hired.md` for why, `16-who-hires.md` for who may.

## First, decide it is a card

A card is expensive in a way a subagent is not: it holds a window of context for as long as it is
on, keeps a mailbox, appears on the board, and outlives the turn that asked for it. That cost buys
exactly one thing, which is that the work can be questioned later by talking to the thing that did
it.

Three tests, all of which must pass, or the job goes to a subagent and nothing is created:

1. **Something survives the agent besides text.** If its edits are the deliverable, it is a card. If
   its answer is text you act on, it is a subagent.
2. **You cannot check the answer without redoing the work.** "Find every call site of X with
   file:line" is checkable by spot-checking three citations, so it is a subagent.
3. **It would be given a task id.** Anything with an owner, a verifier or a review is a card,
   because a subagent cannot hold a task contract.

A reviewer that reads one screenshot once and answers one question fails all three. Four cards were
made that way and cluttered a board nobody could then tell apart.

## The role is the permissions, and it is read once

`--role` is not a label. It selects the deny list the CLI is launched with, and the CLI reads its
permissions once at launch, so a role cannot be changed without restarting the card.

| Role | Creates cards | What it is for |
| --- | --- | --- |
| `orchestrator` | yes | talks to the owner, owns the canon, the only role that may create |
| `manager` | no | plans a department's work, hires specialists through its orchestrator, does its share |
| `worker` | no | does the work itself, and is the only role that changes the repository |
| `specialist` | no | one kind of problem, and depth in it is the reason it is not a general card |
| `reviewer` | no | reads and reports, and is called by the orchestrator rather than by anyone else |
| `verifier` | no | checks a claim against the thing it is about, and cannot edit or delegate |

`boss` and `delegator` still exist and are layers Garden no longer has. Both run as a manager. Do not
hire either one; the names survive for cards that predate the change.

What each role is refused is generated from one table and told to the card in its own `POWERS.md`.
Never hand-write a second copy of a deny list into the roots: a card told the editing tools are
denied while a shell sits open stops trusting the whole brief.

## What "specialized" actually means

The role is the shape. Four things make the card particular, and only the first is chosen by `--role`:

- **The deny list**, from the role.
- **The roots**, which say what this card is for, what it owns, what it must not touch, and who it
  defers to. This is the load-bearing one. `card-roots` is how to write them and its test is the one
  that matters: read them back and ask whether they could belong to a different card.
- **`--owns`**, a comma separated list of paths. It is how "yours" becomes a fact rather than a hope.
- **Its skills**, which is the section below.

A card is specialized by all four agreeing. A card hired as a `specialist` with generic roots is a
general card with a narrower deny list, which is worse than either.

## The order, which is forced on you

The card's own directory is named with its id, and the id does not exist until the card does. So:

**1. Write the roots to a file first.** Use a file writing tool, never a heredoc. Real roots run to
thousands of characters, and a command carrying that much prose cannot be security scanned, so it
stops and waits for the owner. Put the file in your own outbox.

**2. Create the card, switched off.**

```
node "%GARDEN_BIN%\garden-hire.mjs" --title "Loader worker" --role worker --file "<path to roots>"
```

Other flags, all optional: `--reports-to <card id>` draws the wire, `--owns "path,path"`,
`--model` and `--effort`, `--team-size <n>` for a card that will hire, `--adapter` (defaults to
`claude`). The roots may go on stdin instead of `--file`, but not both: passing both is refused
rather than guessed at.

It comes back whole and switched off. Its mailbox, its `CLAUDE.md`, its `PEERS.md` and its `ROOTS.md`
are already written, and its skills are already copied in.

**3. Write its notes into the directory that now exists.** `LESSONS.md`, `NOTES.md` and `PLAYBOOK.md`
in `~/.garden/memory/<project>/<title>-<id8>/`. Seed them once and never overwrite them afterwards,
because what accumulates there is the reason they exist. Locate the directory rather than guessing at
its name.

**4. Write the work order** under `.claude/work-orders/` or `.claude/plans/`, not into the spawn
prompt. A prompt is gone when the turn ends; a file can be reread on turn forty and cited in a report.

**5. Start it.**

```
node "%GARDEN_BIN%\garden-hire.mjs" --start <card id>
```

**6. Deliver the work order by mail**, addressed by card id, and exchange one message in each
direction before handing over anything real. A wire that is drawn but has never been walked is not a
wire.

## Giving a card a skill nobody else has

At hire time a card is given the skills its role keeps, copied from the first of these that has one
by that name: your own `skills/` directory, then the project's `.claude/skills/`, then
`~/.claude/skills/`. Copies, not pointers, so two cards of the same role can end up with different
sets and neither drifts when the library changes.

To hand a card a skill that is not in its role's list, write the skill folder into
`<card dir>/skills/<name>/SKILL.md` after the card exists and before you start it. The card's
directory is loaded as a plugin for that session alone, so anything there belongs to that card. A
skill the card did not get from Garden survives every later top-up.

To give a skill to every card of a role, put it in `~/.claude/skills/` and add its name to
`ROLE_SKILLS` in `packages/shared/src/index.ts`. That list is a keep list rather than a deny list on
purpose: the machine's skill library is shared by every project, so naming what a role keeps means a
new skill is unavailable until somebody decides it belongs, which is a decision rather than an
oversight. The top-up at launch is additive, so cards already on the board pick the new entry up the
next time they start.

Note that `--setting-sources project` drops the user layer at runtime. `~/.claude/skills/` is a place
Garden copies **from** at hire time, not a place a running card can see.

## Where it goes wrong

**The ceiling refuses before the role does.** Three separate limits: cards on the board, cards
running, and children of one card (`--team-size`, falling back to the board's figure). Every refusal
names the count, so read the number rather than retrying.

**Nothing that stops to ask a human may be left unsettled before the card starts.** The first card
hired under these roots came up red, frozen on a permission prompt nobody could answer. Pre-approve
the MCP servers and the tools it needs.

**An unrecognised argument means your shell shattered the command.** PowerShell 5.1 reopens the
command line at a quote inside an argument. `garden-hire.mjs` refuses rather than creating from what
survived, and says so; treat that message as evidence about the shell, not about the flags.

**A card hired with no roots reads only the project's instructions** and answers as whatever those
describe. That is the "it inherited everything ever written" complaint, and it is why empty roots are
a refusal rather than a default.

## How to know it worked

Ask the card to state one rule from its roots without telling it where to look. Then check its
startup context carries no `[Trimmed]` marker on its instructions or its peers, and that asked what
skills it has, it names its own and not the machine's.

A card that cannot do the first of those was hired with a project description rather than roots, and
the fix is to rewrite them, not to explain the brief in mail.
