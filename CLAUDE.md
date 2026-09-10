# Garden, for the agents

This file is written for a Claude Code session rather than for a person. `README.md` is how a human
runs Garden; this is what you need to operate it.

You are in one of two situations and they want different things from you:

- **Working on Garden**, editing this repository. Skip to "Working on the code".
- **Running as a card on a Garden board**, which is a session Garden launched. Then the board is your
  environment rather than your subject, and everything you need is below.

Garden tells you which. A card gets a `SessionStart` briefing naming it, and its own directory under
`~/.garden/memory`. If nothing addressed you as a card, you are not one.

---

## The one rule

**Never show the owner something Garden cannot prove.**

Every piece of derived state carries a provenance: `structured` (a hook or a machine-readable file
said so) or `inferred` (a pattern matched and could be wrong). They are drawn differently, and
anything unknown is drawn as unknown, never as absent and never as fine.

For you this is not decoration, it is how to report. "The test passes" and "I read the code and it
looks right" are different claims and only one is evidence. Say which you have. A step you skipped
and did not mention reads exactly like a step that passed.

---

## The board, as a model

A **card** is a session, a subagent, or a file. A **wire** between two cards is what *permits* a
message: not a decoration and not a hint, the actual authorisation. Drawn by hand a wire is two-way;
it can be made one-way, and then the far end cannot answer.

A card's **role** is enforced by the CLI's own permission layer, through a `permissions.deny` list in
a per-session settings file Garden writes and passes with `--settings`. Garden never intercepts a
tool call and never argues with a permission decision. If your role denies you something, it will be
refused at the tool boundary and no amount of rephrasing changes that. Read `POWERS.md` in your own
directory to see your deny list verbatim.

| Role | Denied | Hires |
| --- | --- | --- |
| Orchestrator | Edit, MultiEdit, NotebookEdit, Bash | yes |
| Boss | Write, Edit, MultiEdit, NotebookEdit | yes |
| Manager | Edit, MultiEdit, NotebookEdit, Bash | yes |
| Worker | Agent, SendMessage, Task | no |
| Reviewer | all of the above plus Bash | no |

Bash is the entry that matters: denying Write does not stop a card writing a file through a shell, so
any role with no sanctioned way to put bytes on disk loses Bash too.

---

## If you are a card

### What you have

Your own directory under `~/.garden/memory`, keyed to the card rather than to the process, so it
survives you being stopped, started and renamed.

| File | What it is |
| --- | --- |
| `CLAUDE.md` | what this card is and who it answers to. Garden owns everything above a marker line and never touches what you write below it |
| `NOTES.md` | the current picture of what you are responsible for |
| `LESSONS.md` | corrections, so the same mistake is not made twice. Read to you at startup |
| `PLAYBOOK.md` | how to do this job well, written for whoever runs next |
| `PEERS.md` | who you are wired to, which way each wire runs, and the exact send command |
| `POWERS.md` | your role with the deny list printed |
| `INBOX.md` | what has been sent to you |

**Write to NOTES, LESSONS and PLAYBOOK before you finish a piece of work, not after you are asked
to.** A card that learns something and does not record it has not learned it.

### Sending to another card

The shim path is in your `PEERS.md`. Long messages go in a file:

```
node <shim> --to "<card title>" --kind <kind> --task <task id> --file "<mail dir>/outbox/<id>.md"
node <shim> --to "<card title>" --kind <kind> --task <task id> --text "one short line"
```

Kinds: `work`, `question`, `answer`, `review`, `done`, `confirm`, `assessment`, `remediation`.

A kind never decides direction. The wire does, and only the wire. Two kinds carry a duty:

- **`confirm`** — when a card below you reports `done`, you look at what it did and confirm it.
  Garden refuses to let you report anything upward while a report to you is unanswered. That is what
  stops work reaching the top unread.
- **`assessment`** — how the finished work measures against what was actually asked for, which is a
  different question from whether the code is any good.

A task goes round the review loop **once**. After that, sending remediation downward is refused and
the only direction left is up.

The shim posts to a loopback endpoint that can do exactly two things: append to a mailbox, and record
that it did. It never types into a terminal, which is what keeps terminal output from ever causing a
command to run. Who is sending comes from the environment Garden set when it spawned your shell, not
from anything a message claims.

### The other shims, all in `server/bin`

```
garden-wire.mjs    --to "Scout"                        wire yourself to a card, both ways
                   --from "A" --to "B"                 wire two other cards
                   --to "Scout" --one-way              you may speak, they may not answer
garden-status.mjs                                      every card on your board
                   --to "SFX"                          one card by title
garden-hire.mjs    --title "Loader worker" --role worker --file "<roots>.md"
garden-task.mjs    show|create|bind|reassign --task T-12 ...
garden-board.mjs   --list | --reap | --delete <id> --yes
garden-asks.mjs                                        what is waiting on the owner
```

`garden-hire.mjs` only *creates* a card if your role may create one. Everyone else's request becomes
mail to somebody who can. That is deliberate: hiring is a decision with a board ceiling behind it.

Roots go in a file and are passed with `--file`. A card launched without real roots is a card that
will ask you what it is supposed to be doing.

### Things that will bite you

- **A subagent cannot send mail.** It has no process of its own to run a shim from, so it reports
  through its parent. If you need something to hold a task contract and answer for it, that is a
  card, not a subagent.
- **Never delete or overwrite something you did not create.** If something is in your way and you did
  not make it, say so and stop. Do not infer ownership from the fact that it is there.
- **Two sessions in one checkout is normal.** Check for another session's claim before editing and
  write your own for what you take (`POST /claim`).
- **Keep commands short and never `cd` in one.** `cd X && ...` cannot be auto-approved on Windows,
  because the final directory is not knowable before it runs. Use absolute paths. Past a few thousand
  characters a command cannot be security-scanned, so write files with your editing tools rather than
  heredocs.

---

## Working on the code

```
packages/shared   the typed message union both halves compile against
server            the backend: PTYs, hooks, SQLite, mail, the derived views
apps/web          the canvas
scripts           the test suite and the launcher
```

Garden runs as **two processes**: the server on 5178 and, in dev, Vite on 5177. They are versioned
separately and the header says so. `npm run stable` builds and serves from the build with no watcher,
which is the mode to use when Garden is running something you care about. `npm run dev` restarts the
server on every save **and kills every terminal on the board with it**.

### The rule about tests

**Never run a test, a script or a harness against a live board or a real workspace.** Give it its own
instance, its own port and its own directory. `scripts/lib/instance.mjs` does exactly that: a server
on a free port with `GARDEN_HOME` pointing at a temporary directory, which separates the board, the
mailboxes, the hook files and the notes.

This is not hypothetical tidiness. Ignoring it has destroyed real data before, and it looked like the
app losing it rather than a script taking it.

```
npm run typecheck
node scripts/run-suite.mjs          # the whole suite, one test at a time
node scripts/test-<name>.mjs        # one of them
```

`scripts/known-red.json` lists tests allowed to be red, each with a reason and a date. **A test named
there that passes fails the run**, on purpose, so an excuse cannot outlive the thing it excuses.

A handful of tests are load-sensitive: they wait on a fixed sleep rather than on a condition, and
they go red in a full run and green alone. Check a failure alone before believing it.

### Writing

No em dashes. Use a period, a comma, a colon, parentheses, or rewrite the sentence.

Prose first, a list only when the content is genuinely a set. No emoji and no hype. Do not call an
idea good before evaluating it: say what works, what does not, and why.

Comments here explain **why**, and specifically why the obvious thing was not done. A comment saying
what the line already says is noise; a comment recording the failure that made the code look like
this is the reason this codebase is navigable. Match that when you add to it.

### Versioning

`package.json`, `apps/web/package.json` and `server/package.json` carry one version and move
together. The patch number moves for anything a person can see or feel, in the same commit as the
change, never in a tidying pass afterwards. Nothing moves for a test, a comment or a document.

The launcher restarts the running server only when that number differs from the running one, so a
version left unbumped is a change that will not reach the app.
