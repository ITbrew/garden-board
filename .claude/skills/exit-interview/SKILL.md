---
name: exit-interview
description: End-of-session self-debrief that closes a session cleanly. The user is interviewing the agent that is exiting, not the other way around. No questions back to the user, no more context-building, just writing what was learned to the correct durable places, then stopping.
---

# Exit interview

The name is literal: this is an interview the user gives ME, the agent about to exit, not a
survey I hand the user. Don't ask the user anything here, not even a retro-style multiple choice.
Asking a question extends the session; the whole point of this skill is to end it.

## What this is for

A session accumulates real learnings: what got built, what broke and why, what the user
corrected me on, what surprised me, what's still open. Left unwritten, all of that is gone the
moment the session ends and the next one starts cold. This skill is the mechanical step that
turns "things I now know" into "things written down where a fresh session, or the user, will
actually find them."

## What this is not for

Not a chance to keep working. Not a chance to re-derive or re-verify anything already settled
this session. Not a chance to ask "should I also..." Trust what already happened in the
conversation; don't re-read files to double-check things that were already confirmed. If
something is genuinely unresolved and blocking, write it down as an open item, don't ask about it.

## Method

1. **Review the session honestly**, from memory of what actually happened, not a vibe summary.
   What shipped, what broke along the way and why, what the user pushed back on or corrected,
   what took longer or more machinery than it should have, what I'd do differently.

2. **Route each learning to exactly one place.** The same table most projects' CLAUDE.md already
   has under "Changing how agents work":

   | What I learned | Where it goes |
   | --- | --- |
   | A law, fact, or invariant that must always be known | The project's `CLAUDE.md` (short) |
   | A repeatable procedure with steps and traps | A skill in `.claude/skills/<name>/SKILL.md` |
   | A persistent role or perspective an agent should adopt | A subagent in `.claude/agents/<name>.md` |
   | Something that must happen every time, not when remembered | A hook |
   | A durable fact about the project or the user, not derivable from the repo | Memory |

   If the project has its own version of this table (most do, since it's a common pattern), use
   that one instead of inventing a parallel one.

3. **Update anything that drifted.** If a status table, a handoff doc, or a design spec no longer
   matches what actually shipped this session, fix it now, this is the same discipline as
   `/doc-drift`, just run once at the door instead of per-slice.

4. **Save memory for anything that should survive to a different session or a different
   project entirely**: confirmed user preferences, corrected assumptions, project state that
   isn't derivable by reading the repo. Update an existing memory file rather than duplicating one
   if the topic already has an entry.

5. **Do not ask the user anything.** If a learning is ambiguous, write it down with the ambiguity
   stated plainly (e.g. "unclear whether X was intentional, flagging for next session") rather
   than stopping to ask. The user chose not to be interviewed; respect that.

6. **Close OWNERSHIP of the working tree, not just the notes.** This step exists because the
   skill shipped without it and the omission was expensive: sessions ran the exit interview
   faithfully, wrote good memory, and still left dirty files that belonged to nobody. Weeks
   later the tree held 85 modified files of which 64 matched no owner, and no one could tell
   in-flight work from abandoned work. Writing notes is not finishing. Do all three:

   - **Run `git status`.** For every file this session touched, it must end in exactly one of
     two states: committed, or covered by a claim file that names it. Never a third state.
   - **Work that is staying dirty** (in flight, blocked, deliberately unbanked) needs a claim
     in `.claude/sessions/` listing the files it owns and what it is waiting on. If a claim
     already exists but has grown under-inclusive, extend it. A dirty file with no claim is
     indistinguishable from abandoned work the moment the session ends.
   - **Work that banked** means its claim is now stale, and a stale claim blocks other
     sessions for no reason. Delete it.

   Do not sign off while any file this session touched is both uncommitted and unclaimed.
   Files other streams left dirty are not mine to claim or commit, but ARE worth naming in the
   summary under "recorded, no action" so the next session is not left guessing.

7. **Close what is mine to close, before writing the summary.** If something is small,
   reversible, and follows from the work already done, DO IT NOW rather than describing it. A
   session that ends by handing back a chore I could have finished in a minute has not closed
   anything, it has delegated upward. The exception is a change that reverses a decision the user
   already made: that one is theirs, and saying so explicitly is the point of step 8.

8. **Sort every remaining item into exactly one of three registers, and say which.** The whole
   failure mode of this skill is that recorded facts get written in the register of a to-do list,
   so the user finishes an exit interview feeling handed a fresh backlog. Separate them:

   | Register | What it is | How to write it |
   | --- | --- | --- |
   | **Recorded, no action** | A fact a future session may want. Unverified observations, dirty files from other sessions, things noticed in passing. | State it as a note, in memory, and say plainly that nothing is being asked of the user. Never phrase it as a next step. |
   | **Yours to decide** | Genuinely blocked on the user and nothing else: a playtest only they can judge, an app only they can close, a credential only they hold. | Say WHY it is theirs. But apply the two tests below FIRST, because this is the register where work I am avoiding disguises itself as respect for the user's authority. |
   | **Mine, and done** | Anything from steps 6 and 7. | Report as completed, past tense. |

   **Two tests before anything may enter "yours to decide":**

   - **Is it actually a decision, or did I just assert that it was?** State the claim that makes
     it theirs in one sentence, then check it. "Moving this reverses their decision that the
     observer lives outside the repo" collapsed the moment it was examined: that decision was
     about where the observer EXECUTES, and moving the source changed nothing about execution. A
     false premise turned a two-minute chore into a standing question the user was asked three
     times. If the premise does not survive one sentence of scrutiny, the item is mine.
   - **Have I raised it before?** An item surfaced in a previous summary and still open is not a
     decision awaiting input, it is a task being avoided. Do it or cut it. Never raise the same
     open item twice; the user cannot tell a standing question from a nag, and either way they
     are carrying it instead of me.

   If an item does not fit any register, it is probably not worth mentioning at all. Cut it. A
   session that ends with nothing in "yours to decide" is the normal, good outcome, not a sign
   something was missed.

9. **Close with a short written summary, not a question.** State what was written and where
   (file paths), in a few lines. No "let me know if..." No open questions, and no item phrased so
   that a reasonable reader would think they now owe you work. This is the last thing said before
   the session ends, so end it like one.
