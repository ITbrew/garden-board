# Roots templates

A card's roots are what its session runs from before it does anything: what it is for, what it owns,
what it must not touch, and who it defers to. They are handed to `garden-hire.mjs` on `--file` and
are written into the new card's own `CLAUDE.md`, below the line Garden maintains.

These are starting points, one per role. Copy one, fill in every `<...>`, delete what does not apply,
and delete these instructions from the copy.

## The test that decides whether they are finished

Read the roots back and ask whether they could belong to a different card. If yes, they are not roots
yet: they are a project description, and the card could have read that anyway. Roots that mostly
restate the project's own instructions are worse than none, because they spend the card's context
telling it what it already had and leave every card believing it has the same job as every other.

## What not to put in

Do not paste canon, a spec or a design document into a set of roots. Cite the path. Each card
carrying only its own narrow context is the reason a board is cheaper than one long session, and
inlining a document the card could open on demand works directly against it.

Do not write encouragement. Every sentence should be answerable with a fact: what it owns, what
refuses it, what broke last time. "Do a great job" costs tokens and changes nothing.

Do not describe the implementation unless the implementation is itself the requirement. State the
behaviour wanted and the constraints that are not negotiable, and leave the method to the card
closest to the code.

Do not restate the deny list. Garden generates what a card is told about its own powers from the
permissions table, so it cannot drift from what the runtime actually refuses. A hand-written second
copy can, and the card that catches it stops trusting everything else it was told.

## Say which limits are enforced and which are asked for

A card that believes an unenforced request is enforced will not check itself. A card that discovers
an "enforced" rule was only a suggestion stops trusting the rest of the brief. Both failures are
worse than the honest sentence.

## The order

1. Write the roots to a file. Use a file writing tool, never a heredoc in a command.
2. `garden-hire.mjs --title ... --role ... --file <that file>`. The card comes back switched off.
3. Seed `LESSONS.md`, `NOTES.md` and `PLAYBOOK.md` in the directory that now exists, once, and never
   overwrite them again.
4. Write the work order under `.claude/work-orders/`.
5. `garden-hire.mjs --start <card id>`.
6. Exchange one message each way before handing over anything real.

The full procedure is the `hiring-a-card` skill. `card-roots` is the standard these templates are
built to meet.
