---
name: card-roots
description: How to write the roots of a card you are about to hire - the brief, plan and per-card notes that a freshly launched session runs from, unique to that card rather than shared. Covers what goes in the work order versus the card's own memory directory, the two-pass order forced by the card id not existing until the card does, and why roots that merely repeat the project's CLAUDE.md are worse than none. Use when hiring a boss, a manager, a specialist or any board card, when asked to "write its roots", "set up the boss", "give it a brief", "onboard a card", or before spawning any agent that will persist and own a piece of the project.
---

# Writing a card's roots

Roots are what a session runs from: its instructions, its own notes and lessons, its settings, the
plan it works against, and the guards that fire on it. In Garden they hang off the card's bottom
port. In any project, they are the total of what a fresh session knows before it does anything.

The card above writes the roots of the card below, before that card starts work. A card launched
without roots spends its first turn working out what it is, from documents written for somebody
else.

## Roots are per card, and that is the whole point

Two cards on the same project doing different jobs get different roots. Roots are the only thing
that tells a fresh session what its *particular* spot is. A shared brief describes the project, and
a project description is precisely what the card does not need, because it could read that anyway.
What it cannot derive is what it is for, what it owns, who it answers to, and what it must not do.

So roots that mostly restate the project's `CLAUDE.md` are worse than no roots at all. They burn the
card's context telling it what it already had access to, and they leave every card believing it has
the same job as every other card. If a paragraph you are about to write would be equally true of any
card on the board, cut it and link to the shared document instead.

The test: read the roots back and ask whether they could belong to a different card. If yes, they
are not roots yet.

## The two halves, and who writes each

**The system writes the powers.** Where a harness generates a role brief from a permissions table,
let it. The value of a generated brief is that what a card is told about its powers cannot drift
from what its runtime actually refuses. Hand-writing a second copy of the deny list is how a card
ends up being told the editing tools are denied while a shell sits open.

**You write the job.** What this card is for in one paragraph. The piece of the project it owns.
The plan it works from. Who it reports to and how a report is sent, with the literal command or
path. The standards it inherits, stated as constraints rather than encouragement. And the things
that will bite in this project specifically, each with the sentence explaining what broke, because a
constraint with no reason attached gets optimised away by the next reader.

Say which limits are enforced and which are asked for. A card that believes an unenforced request is
enforced will not check itself, and a card that discovers an "enforced" rule was merely a suggestion
stops trusting the rest of the brief.

## Where each part lives

The plan half belongs in a file, not in the spawn prompt. A prompt is gone when the turn ends; a
file can be reread on turn forty, handed to a replacement card, and cited in a report. Prefer
whatever path the project's own tooling already recognises as a plan or work order, so that handing
out the plan is a visible event rather than an invisible one. Grep for the path test before choosing
the directory.

The durable half is the card's own notes directory: corrections, the current picture, and the
procedure this card has worked out for its own spot. Seed it once and never overwrite it, because
what accumulated there is the reason it exists. Key it to the card rather than to the process, so it
survives the card being turned off and on.

## The order, which is forced on you

A card's notes directory is usually named with the card's id, and the id does not exist until the
card does. So roots are written in two passes:

1. Before hiring: the plan and the brief, since the card must be able to read them on its first
   turn. Reference them by absolute path in the spawn prompt.
2. Immediately after the card appears: its own notes, written into the directory the system just
   created for it. Locate the directory rather than guessing at it.

Then, before handing over real work, exchange one message in each direction and confirm the reply
came back. A chain that is drawn but has never been walked is not a chain.

## What not to put in

Do not paste canon or the spec into the roots. Cite the path. The point of the board is that each
session carries only its own narrow context, and inlining a document that the card could read on
demand works directly against the reason the structure exists.

Do not write encouragement. "Do a great job" costs tokens and changes nothing. Every sentence in a
set of roots should be answerable with a fact: what it owns, what refuses it, what broke last time.

Do not describe the work in a way that prescribes the implementation, unless the implementation is
itself the requirement. State the behaviour wanted and the constraints that are not negotiable, and
leave the method to the card closest to the code. A brief that specifies the how takes the decision
away from the only card positioned to make it well.
