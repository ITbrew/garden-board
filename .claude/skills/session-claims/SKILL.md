---
name: session-claims
description: Lightweight file-ownership signal for when multiple Claude Code sessions work against the same repo checkout at the same time. Use at the start of any unit of work in a repo you know or suspect another session might also be touching, and check for it before editing files in any repo where you haven't just freshly cloned/pulled. Trigger phrases include "who owns this", "is someone else working on this", "claim file", "session collision", or any time git status shows uncommitted changes you didn't make.
---

# Session claims (who owns what, right now)

The problem this solves: two Claude Code sessions working the same checkout at once, with no
signal between them, so a session can only guess "don't touch this" by reading `git status` and
inferring from whatever's already modified. That's fragile and it's exactly how a session ends up
silently working around another session's in-progress edits by inference instead of by contract
(this happened for real on 2026-07-23: a session found a source file already modified and had to
reason its way around it rather than just checking a claim).

This is deliberately not `git` worktrees. Worktrees isolate a session's *edits* from the main
checkout, which is a different problem, and worktrees branch fresh from origin by default, so an
isolated session can't even see another session's uncommitted local work. In a project whose build
generates gitignored files that the tooling then needs, they are outright painful. This is just a
plain, readable, no-infrastructure convention for *announcing intent*.

## The convention

A "unit of work" (a slice, a task, whatever the project calls its chunk of work) gets a claim file
at `.claude/sessions/<name>.md` in the repo root, where `<name>` is a short slug for that unit of
work (a task name, a ticket id, or a timestamp + short description if nothing else fits).

**At the start of a unit of work**, before editing files in a repo another session might also be
touching:

1. Check `.claude/sessions/` for existing claim files. Read them.
2. If the paths you're about to touch overlap with another active claim, stop and surface that to
   the user rather than proceeding — don't silently work around it, and don't silently proceed
   either.
3. If clear, create your own claim file: a short markdown file naming the unit of work, the paths
   you expect to touch (can be approximate — directories are fine), and roughly when you started.
   Keep it to a few lines; this is a signal, not documentation.

**Re-check the claim after every remediation pass, not only at the start.** The claim is written
early, when its file list is still a prediction. Then a reviewer returns findings, the fixes touch
files the prediction never named, and the claim silently goes under-inclusive. That is how a session
ends owning a dirty file it never listed, despite having written a claim in good faith (seen
2026-07-25: an auditor pass added two files and a Stop guard caught the gap, not the session).

Two habits close it. Extend the claim in the same pass as the fix, and before signing off, enumerate
the files you actually touched and grep the claim for each basename instead of trusting memory. Also
correct a claim that has gone stale in *content*, not just coverage: a line reading "NOT edited after
all" that a later pass falsified is worse than a missing line, because the next reader believes it.

**At the end of a unit of work** (once it's committed, or otherwise done and no longer actively
being edited): delete your claim file. A stale claim file is worse than none, since it blocks
other sessions for no reason — delete it as part of finishing, not as an afterthought.

Minimal claim file example:

```markdown
# claim: fix-lighting-boundary
started: 2026-07-23
owner paths:
- src/presentation/runtime-lights.ts
- src/presentation/shot-runner.ts
```

## Claim numbered artifacts too, not just paths

A file path is not the only thing two sessions can collide on. Anything drawn from a shared sequence
collides the same way and is worse, because both sessions succeed: no merge conflict, no compile
error, just two artifacts wearing the same name.

Seen on 2026-07-27, in one evening: a numbered design document `08-*.md` was written twice by two
sessions, and then `11-*.md` was written twice by two more. One of those was the session that had already flagged
the 08 collision in its own claim file, and it then walked into the identical trap one number up.
Prose elsewhere in the repo said "see spec 11", which by then meant a coin flip.

So when work allocates from a sequence (numbered spec/ADR/migration files, port numbers, fixture ids,
enum values that get written into saves), **claim the number in the claim file before creating it**,
and re-check the directory immediately before writing, since another session may have taken it in the
meantime. Renaming afterwards is cheap for the file and expensive for every reference to it: expect
to fix inbound links sitting in other sessions' documents, and note that those links became stale
because of the rename, so they are the renamer's to repair, not the other session's.

## What this is not

Not an enforcement mechanism (a hook that blocks edits to claimed paths could be layered on top
later if it ever becomes worth the setup, but the plain file is the point: cheap, readable at a
glance, no infrastructure). Not a replacement for actually checking `git status` and reading
what's uncommitted — the claim file tells you *intent*, `git status` tells you *what actually
changed*; use both. Not a task tracker; keep it to path ownership, nothing else.
