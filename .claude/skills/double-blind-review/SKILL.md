---
name: double-blind-review
description: How to verify a visual/UI/rendered change without the agent that wrote it grading its own screenshot. Splits verification into two roles that never share context: the coding agent that read the diff and the code, and a fresh subagent that only ever sees a screenshot and neutral questions, never the code, the diff, or the prior conversation. This skill is the PROCEDURE, not the schedule; how often it runs is a per-project setting owned by that project's CLAUDE.md. Use whenever a change affects anything a human would look at (a web page, a native UI, a game render, a CLI's TUI output, a generated document or chart), and on trigger phrases like "take a screenshot", "check it looks right", "verify visually", "test the UI", "before you finish", "testing phase", "double blind", "blind review", or any point where you're about to write a completion summary for a change with visible output.
---

# Double-blind review (code agent + blind screenshot reviewer)

**This is the procedure, not the schedule.** The procedure never varies: the agent that wrote the
code does not grade its own screenshot, and the reviewer is blind by construction rather than by
instruction. How OFTEN it runs does vary, because a single screenshot is worth very different
amounts depending on what is on screen. That setting is owned by each project's CLAUDE.md and
summarised in the global one, under "How often it runs is per project".

Two consequences. Where a project has its own `/blind-review` skill, use that instead of this one:
it knows the local capture harness, the module map, and the cost presets. And where a project says
nothing about frequency, default to running it, then ask the owner to calibrate.

## Why it exists

An agent that just read the code and the diff is the wrong agent to judge whether the rendered
result looks right. It already knows what the code is *supposed* to do, and that knowledge
quietly rewrites what it sees: ambiguous pixels get read as confirmation of the intended
behavior instead of being reported as what they actually are. This is not hypothetical. It
happened in a real session on 2026-07-23: an agent that had just read the lighting code
looked at a screenshot and confidently called a boundary shadow "real, geometry-cast, confirmed
by the code." A second agent given nothing but the same PNG and a neutral question called it
"a flat, hard-edged painted stripe, no gradient, no lamp glow anywhere" — and raw pixel sampling
(comparing RGB values near a lamp versus far from any lamp: identical, no falloff) proved the
blind agent right and the code-reading agent wrong. The fix isn't "look more carefully." The fix
is structural: the agent that read the code must never be the one who judges the screenshot, and
the agent who judges the screenshot must never be told what the code says or what the answer is
expected to be.

## The two roles

**The builder** wrote or reviewed the code change, ran the build, ran the tests, and knows the
intent behind the change. The builder is good at explaining *why* something should work and at
tracing a bug back to a line of code. The builder is bad at looking at a render with fresh eyes,
because it can't un-know what it just read.

**The blind reviewer** is a freshly spawned subagent (a brand-new `Agent` tool call, general or
default subagent type — never a `fork`, since a fork inherits the entire conversation and
defeats the whole point) whose only input is a file path (or a small set of them) and a short,
neutral, non-leading set of questions. It has no idea what the change was supposed to do, what
project this is, what the prior conversation concluded, or what answer would be convenient. It
only describes what is actually in the image.

Never collapse these into one agent. Never let the builder pre-read the screenshot and then
"double check" with a blind pass — by the time the builder has looked, the blind pass is
contaminated even if a fresh agent runs it, because the builder's summary to the user will
already be anchored on its own first impression. The builder must not `Read` the screenshot
itself, full stop, whenever the question is "does this look right."

## The procedure

1. **Make the change and get it running.** Build/compile/start the dev server, whatever "running"
   means for this project.
2. **Capture a screenshot of the actual running result**, not a mock and not a description from
   reading the code. Pick whatever capture method fits the project:
   - Web/browser UI: the `claude-in-chrome` tools (navigate, screenshot).
   - A native desktop app or game: a real screen/window capture (a small capture script, or the
     project's own capture hook if it has one — see the note on consistency below).
   - A CLI/TUI: a captured terminal transcript or a rendered screenshot of the terminal if the
     visual layout itself is what's being verified.
   - A generated artifact (chart, document, diagram): render it to an image file.
3. **Locate the resulting file(s) with `ls`/`Glob` only.** Do not open them yet.
4. **Dispatch a fresh subagent** with only the file path(s) and a neutral question template (below).
   Do not mention the code, the diff, the feature name, what you expect, or any hypothesis.
5. **Relay the blind reviewer's findings essentially verbatim.** That is the verification, not raw
   material for the builder to reinterpret. If something looks off, or the builder's own
   tests/build checks failed, fix it and repeat from step 1 — don't write the completion summary
   yet.
6. **Only once both checks pass** (the builder's normal checks: build succeeds, tests pass, no
   regressions; and the blind reviewer's visual read: looks correct, nothing broken/misplaced/
   glitched) does the builder write the summary of changes and the completion note for the user.
   The completion note should mention that a blind visual pass was run and what it found, briefly.

A second opinion, if wanted, is a *second fresh* subagent run the same way — never the builder
re-looking, and never the same subagent re-asked (it now has its own prior answer in context).

## Neutral question template

Adapt the middle questions to what actually changed; keep the framing neutral regardless.

> Use the Read tool to open this image: `<path>`. This is a screenshot of [a web page / an app
> screen / a running game / a rendered document — one line of neutral framing, no more]. Based
> only on what you visually observe — you have no other context about this project or what
> changed, so don't guess at intent, just describe what's there:
>
> 1. Describe the overall layout and content you see.
> 2. Focus on `<the specific area/component/element in question>` — describe it in detail:
>    position, color, spacing, alignment, any text, any visible state (loading, error, etc.).
> 3. Does anything look broken, misaligned, cut off, overlapping, or visually wrong anywhere in
>    the image? Be specific about location if so.
> 4. `<any specific yes/no visual question relevant to this change — e.g. "is there a visible
>    gap/doorway in the boundary," "does the button appear disabled," "is the chart's legend
>    readable">`
> 5. Anything else that stands out, expected or not.
>
> Answer plainly, section by section. Keep it under 400 words.

## Consistency: make screenshotting a standard part of testing, not an ad hoc extra

Don't invent a one-off capture method each time. For any project you return to more than once,
set up (or ask for) a small, repeatable capture step early — a `tools/screenshot.*` script, a
documented `claude-in-chrome` flow, a project-specific capture hook — the same way a project has
a standard test command. Once it exists, running it before any visual-change completion should be
as automatic as running the test suite. If a project doesn't have one yet and you're about to
verify a visual change, that's the moment to build the small script rather than eyeballing it once
and moving on. A project-level skill of its own is a good place to document the exact commands so
future sessions don't reinvent them, and it can point back to this skill for the blind-review half.

## Exceptions

A pure existence/sanity check that needs no subjective judgment (a file was created, a process
exited 0, an image is non-empty and roughly the right dimensions) doesn't need the blind reviewer.
Check that mechanically. Any question of the form "does this look right" goes through the full
procedure above, with no exceptions for "it's probably fine" or "it's a small change."

The one legitimate reason to skip is the project's own frequency setting, and skipping is never
silent. When a change has a visible surface and the project's policy means no blind pass ran, say
so in one sentence in the completion message, so the owner can call for it in one word. An
unmentioned skip reads exactly like a check that passed, which is worse than not having the check
at all: it spends the owner's trust without buying him anything.
