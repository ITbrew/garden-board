---
name: goal-ring
description: How an orchestrator keeps a project tab's goal ring in Garden true. The ring is the owner's view of progress on the tab, drawn from the project's TODO.md. Use when setting goals for a project, when work on a goal starts or finishes, when the owner asks what the goals are or says the ring is wrong, when breaking a large aim into sub-goals, or when deciding what done means for a piece of work.
---

# The goal ring

Every project tab in Garden has one goal ring. It shows the owner how far the tab has come, at a glance,
without asking anyone. It is drawn from `TODO.md` at the project root and follows the file within seconds.
You keep that file true, as work moves, without being asked. Nothing else updates it for you.

The ring tracks progress. It asks nothing of the owner: nothing on it waits for them to unblock it. If you
need a decision, ask in chat and keep the line as it is.

## What the rings mean

The outer ring is the goals. A goal is an overarching outcome, such as "Improve movement systems". The
inner ring is the sub-goals of the selected goal: the path to that outcome, each a piece of work that can
finish. The number in the middle counts goals. Both rings fill clockwise like a clock's hands: a full inner ring is
one whole outer arc, and finished work is always drawn first, whatever order the file lists it in.

## The format

    # TO DO

    ## Now: Combat feel
    Fights read clearly and respond at once.

    - [ ] Improve movement systems @Worker #doing
      - Why: Movement decides how every fight feels.
      - [x] Measure input delay
        - Why: The cuts need a number to beat.
        - End: Delay is recorded for walk, dash and jump.
      - [ ] Cut dash delay #doing
        - End: Dash responds within 50 ms in the test level.
    - [ ] Settle the camera
      - Why: Players lose track of targets in close fights.
      - [ ] Compare two camera distances
        - End: Both are recorded in the same fight, and one is chosen with the reason written down.

The `## Now:` heading names the tab's focus, and the line under it describes it. Top-level items are goals
and items nested under one are sub-goals. `@Card title` names the card working on a line. Keep names short,
because they sit beside the ring, and put the detail in the bullets.

The ring draws the first `Now` section, so keep finished or later work outside it. If the project has no
list yet, create `TODO.md` at its root.

## Writing goals and sub-goals

The owner may hand you a loose aim. Turning it into good goals is your job, or a planner or advisor card's if
you ask one, and it happens before work starts. Ask the owner once in chat only if the answer changes the goals.

Write a goal as the outcome, not the activity. "Improve movement systems" is a goal; "work on movement" is
not, and neither is a single task, which is a sub-goal.

Give every sub-goal an exit: an `End:` line saying what is true when it is done, checkable by someone who
did not do the work. Prefer something that can be measured or looked at. "Dash responds within 50 ms in the
test level" is an exit; "dash feels better" is not. A sub-goal with no exit shows "No exit written yet" to
the owner, so a gap is visible until you fix it. Do not write an exit you could not show.

## The order of a tab's work

Receive a request, fill out the ring, start the loop, delegate the work, answer the cards until the ring is
complete, and let the loop close. Start the loop once the goals are real, on yourself, with a prompt file:

    node "%GARDEN_BIN%/garden-loop.mjs" --on --until-ring --card "<your title>" --minutes 10 --prompt-file loop.md

Write the prompt so each pass moves something: read the list and BOARD.md, hand the next open line to a card
or do it, check finished work and tick what you can show, and report nothing the ring already shows. Goals must
be finishable by cards alone, and anything only the owner can decide goes to them in chat. Garden closes the
loop when every goal is done, and pauses it after three passes that change nothing.

## Keeping it true

The owner reads the ring instead of asking for status, so a stale ring is a wrong report. Open goals are your
instruction to carry on, turning on the cards they need. A full ring means stop: the owner assigns the next
work, and you do not invent goals (canon 28).

Add `#doing` to a goal or sub-goal when work on it starts, and remove it when work stops.

Tick a sub-goal by changing `[ ]` to `[x]` only when its `End:` is met and you can show it. A card you
delegated to reports it done: look at the evidence before ticking. A goal counts as done once all its
sub-goals are done, unless it has a `#doing` tag, so tick it or clear the tag then. A goal with no sub-goals
needs its own `End:` and its own tick.

Change the goals when the plan changes. A ring that describes last week's plan is worse than an empty one.

## What it looks like to the owner

The ring is a plain circle. Each arc is a button: hovering shows its name, card and progress or exit, and
pressing opens a small note with its definition and exit, so keep those short enough to read there. The
middle button lays every arc's name out around the ring at once. Done is deep violet, under way is glowing
lavender, and not started is dark indigo. They read the ring; only you and the cards edit the file.

## Checking your work

After changing the file, read it back and check that the first `Now` section holds what you meant. Canon 26,
"The goal ring", is the full specification. The procedure for delegating a line to a card and starting its
loop is in `~/.garden/roots/detail/the-to-do-list.md`.
