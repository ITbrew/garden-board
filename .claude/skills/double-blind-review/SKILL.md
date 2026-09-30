---
name: double-blind-review
description: How to review a visual/UI/rendered change. Two parts. The author always looks at its own screenshots and writes what they show against what was intended (observations, never a verdict). Optionally, a fresh blind subagent is shown the before and after screenshots of the same screen, labelled A and B in random order, and asked what differs and which it would choose for tasks named in a user's words. Use whenever a change affects anything a human would look at (a web page, a native UI, a game render, a CLI's TUI output, a generated document or chart), and on trigger phrases like "take a screenshot", "check it looks right", "verify visually", "test the UI", "before you finish", "double blind", "blind review", "compare before and after", or any point where you're about to write a completion summary for a change with visible output.
---

# Reviewing a visible change: your own look, and an optional blind comparison

Changed 2026-09-29 at the owner's request: "agents shoudl be able to view their own work/screen shots
for review, not blind review only". The author reviews its own screenshots. A blind reader is a
choice, and when used it compares a before and an after rather than describing one image cold.

## Part 1: the author looks at its own screenshots. Always.

**Start from a target image when there can be one.** For a new screen or a redesign, get a reference
before building: the owner's mock or sketch, a design, or a screenshot of the screen as it is now.
The review is then the list of differences between your shot and that target, which is the shape
Anthropic's Claude Code best practices use for UI work. Describing a screen against your own idea
of the goal is the weaker form, for when no target exists.

Capture the running result, not a mock and not a description from reading the code. Then open the
screenshot and write what it shows:

- every piece of text in the area that changed, **quoted exactly**, including truncation;
- where things sit, and what sits next to what;
- anything cut off, overlapping, too faint, too small, or missing;
- each of those set against what the change was meant to produce, with every mismatch stated as a
  finding.

**That list is the review. A verdict is not.** "Looks fine", "renders correctly", "as expected" are
not findings and are never offered as a review. The failure this rule was written against is an
author glancing at its own picture and approving it; what prevents it is that the review must be
made of observations a reader could check against the image.

**Know your blind spot.** You read the code, so ambiguous pixels will look like what you meant. When
the image and your intent seem to agree, look for the reading that would disagree: is that shadow a
gradient or a flat stripe, is that label really legible at that size. When you cannot tell, measure
(sample the pixels, query the DOM) or spend a blind comparison.

**Anything the review finds that can be measured becomes an assertion** in the capture harness, so
nobody has to look for it again.

## Part 2: a blind before-and-after comparison. Optional.

Spend one when the change is about whether something reads clearly, when your own review is unsure,
or when the owner asks for one. Not on changes nobody could see.

1. **Capture the same screen in the same state, before the change and after it.** Same size, same
   data, same scroll position, so the only difference is the change. For a screen that did not
   exist before, there is one image and the comparison questions are dropped.
2. **Label them A and B by coin, not by age**, and never tell the reviewer which is new.
3. **Name the tasks in a user's words.** "Find the control that starts this card", "tell whether
   typing here will work". Never the words of the change ("is the off bar visible"), which tells the
   reviewer what to find.
4. **Dispatch a freshly spawned subagent**, never a `fork` (a fork inherits the conversation, which
   is exactly what must not reach it). Where the project defines a `blind-reviewer` agent, use it.
   Give it the two paths, the tasks, and a findings file to write as it goes. Nothing else: no code,
   no diff, no feature name, no expectation.
   **If your role cannot spawn agents** (a Garden worker is denied `Agent`), send the two paths and
   the tasks to whoever you report to, and they spawn it. Your own look (Part 1) needs nobody.
5. **Quote its findings file**, don't paraphrase it. **A reviewer asked for problems finds some even
   in sound work**, so sort its findings: what blocks a named task or a stated requirement gets
   fixed; preferences are optional and weighed, never chased into extra layers and defensive code. If its choice disagrees with yours, report both
   readings and what each rests on, rather than settling it quietly in your own favour.

### Question template

> Use the Read tool to open these two images of the same screen: A is `<path>`, B is `<path>`. You
> have no other context about this project or what changed; do not guess which is newer. Write your
> answers to `<findings file>` as you go.
>
> 1. What differs between A and B, and where on screen?
> 2. For each of these tasks, which image makes it easier, and what on screen made it so:
>    `<task in a user's words>`; `<task>`.
> 3. Anything in either image that is cut off, overlapping, too faint or unreadable? Say which image.
> 4. Which would you choose, A or B, and why?
> 5. Of everything you noted, which would stop someone doing one of the tasks above? Mark the rest
>    as preference.
>
> Quote any text exactly as it appears. Keep it under 400 words.

One pair per reviewer, and a reviewer is disposable: a second opinion is a second fresh reviewer,
never the same one re-asked.

## Exceptions and saying so

A pure existence check (a file was created, an image is non-empty and the right size) needs no look
at all; check it mechanically. A change with a visible surface always gets Part 1. When no blind
comparison ran, that is normal now and needs no apology, but the completion note says which checks
did run, so an unmentioned skip never reads like a pass.

Make capture a standard step for any project you return to: a small script or documented flow, run
as automatically as the test suite, so before-and-after pairs cost nothing to produce.
