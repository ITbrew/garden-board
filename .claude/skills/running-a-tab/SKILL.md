---
name: running-a-tab
description: How an orchestrator runs a project tab in Garden from request to full ring. Use when the owner gives you work or a loose aim, when goals are open and nothing is moving, when you start or close a ring loop, when you come back after a restart, or when a check-in or loop pass asks you to run the board.
---

# Running a tab

The owner gives you a request. You fill out the ring, start the loop, delegate the work, answer the cards until
the ring is complete, and the loop closes. The owner reads the ring instead of asking for status.

## The order

1. **Fill out the ring.** Turn the request into goals in the project's `TODO.md`, even if it was a loose aim.
   Skill: `goal-ring` has the format. A goal says what is true when it is finished. Each sub-goal has an `End:`
   line someone who did not do the work could check. Finishing every sub-goal must really meet the goal. Ask the
   owner once, in chat, only if the answer would change the goals.
2. **Start the loop,** on yourself, once the goals are real:

       node "%GARDEN_BIN%/garden-loop.mjs" --on --until-ring --card "<your title>" --minutes 10 --prompt-file loop.md

   Write the prompt so each pass moves one open line: hand it to a card, answer a card that is waiting, check
   finished work, or do it yourself. If a loop is already on your card, read it first: this replaces its prompt
   and interval.
3. **Delegate.** Open goals are your instruction to carry on. Turn on the cards the work needs, up to the board's
   limit. A card that is off starts with `garden-hire.mjs --start <card id>` or when mail reaches it. Advisor cards
   wake cards by mail along a wire.
4. **Keep the ring true as work moves.** Tag `#doing` only while work is really under way. Tick a line only when
   its `End:` is met and you can show it. Do it in the same step as the work, so large parallel work can be tracked
   at a glance. Do not send progress reports the ring already shows.
5. **Stop at a full ring.** Garden closes the loop and turns the tab's cards off, you last. The owner assigns more
   work. Do not invent goals to stay busy.

"Keep improving x" is the owner asking for more goals. Brainstorm and continue that type of improvement, write one
small round of goals, work it, and let the owner look when the ring fills.

## What Garden does for you

- **Goals left:** the loop runs, whatever the number of goals, and wakes you if you are off.
- **Every goal done:** the loop closes and the cards turn off.
- **New goals on a finished ring:** the loop starts again.
- **Three passes that change nothing, with no card working:** the loop pauses and every card stays as it is. Any edit to
  `TODO.md` starts it again. So write goals cards can finish alone, and take what only the owner can decide to them
  in chat.
- **Half-typed text:** no automatic line is typed while the owner is part way through a line.

## What the owner controls

They right-click the ring:

- **Start** runs the loop.
- **Pause** holds it until someone presses Start. Do not start a paused loop unless they ask.
- **Disable** turns it off for the tab, and Garden refuses a card that tries to start it. Cards still send and
  receive mail, so answer what arrives.

"Pause the board" and Stop all hold the loop too.

## After a restart

Orchestrators that were on come back, and every other card stays off. Your mail says which cards were running and
in what state. Read it with `BOARD.md` and `TODO.md`, start the cards whose work is unfinished, and leave off any
with nothing to do. A card turned on reopens its own conversation.

Canon 25 and 28 are the full specification.
