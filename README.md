# Garden

A node-graph control room for AI CLI sessions. Windows 11, one user, one machine.

Every agent you run is a card on a board. Cards are wired to each other, and the wires are not
decoration: a wire is what permits one card to send anything to another, and a card's role is
enforced by the CLI's own permission layer rather than by Garden asking nicely.

This file is how to run it and how to use it. `DEVELOPMENT.md` is the architecture. **`CLAUDE.md` is
written for the agents themselves**: point a Claude Code session at this repository and it can drive
the board, hire cards, wire them and send between them without being taught any of it by hand.

---

## What you need

- **Windows 11.** Garden spawns real terminals through ConPTY and the launcher is PowerShell. It is
  not portable today and nothing here pretends otherwise.
- **Node 20 or newer**, and a C++ toolchain for `node-pty`, which is a native module.
- **At least one CLI to put on the board.** Claude Code is the one with a full hook spine, so its
  cards report status, token use and tool calls. Codex runs but draws as unmonitored, because it has
  no hooks to report through.

Garden keeps everything it owns in `~/.garden`: the SQLite database, each card's memory directory,
the mailboxes, saved boards. Nothing is written inside your project folders except by the agents
themselves.

---

## Running it

```
npm install
npm run stable          # builds everything, then serves the app from the build
```

Then open **http://127.0.0.1:5178/**.

That is the mode to use for real work. The server runs from `server/dist` and serves the built UI
itself, so there is no Vite process and no file watcher. Editing the source changes nothing until
you run `npm run stable` again, which is what makes it safe to use Garden while somebody is
building Garden.

```
npm run dev             # the watcher mode, for editing
```

`npm run dev` runs the server under `tsx watch` and the UI under Vite on 5177. **Every server file
saved restarts the process and kills every terminal you have open.** Use it when you are working on
Garden and nothing else is running in it.

The startup line tells you which one you are in. Nothing else does.

### The launcher

`scripts/launch.ps1` is what a desktop shortcut should point at. It starts whichever halves are not
already up, waits for both ports to answer, and opens the app in its own Chrome window. It is safe to
run twice and safe to run when only half of Garden is up.

Two things it does that are worth knowing, because both were learned the hard way:

- **It always replaces the page half.** Vite runs `strictPort`, so a surviving process keeps 5177 and
  any replacement exits silently. A port answering told you nothing about how old the code behind it
  was, and it served a six-hour-old build twice before this was fixed.
- **It replaces the server half only when the version differs.** The server holds every card's
  terminal, so reusing it is the whole reason a half-started Garden can be completed rather than
  restarted. But reusing it unconditionally meant a new build could never reach the running app. It
  now compares `/health` against `server/package.json` and restarts only when they disagree. If the
  version cannot be read, it reuses: a failed request is not evidence of a stale server, and ending
  every session over an unknown is the worst available guess.

The version is in the header, and a chip reads `builds differ` when the two halves disagree.
`scripts/restart-fresh.ps1` stops everything, rewrites the database and starts again, for the rare
case where you need the file unlocked.

---

## The rule this project exists to enforce

**Never show the owner something Garden cannot prove.**

Every piece of derived state carries a provenance: `structured` (a supported hook or a
machine-readable file said so) or `inferred` (a pattern was matched and could be wrong). The two
are drawn differently. Anything unknown is drawn as unknown, never as absent and never as fine.

Concretely this forbids inferring that a stage happened from silence, reading prose to decide what
an agent did, showing a subagent as interactive when its process has ended, and claiming a session
survived an app restart when a Windows process cannot be re-parented.

---

## The board

A **card** is a session, a subagent, or a file. Cards never overlap: every pair keeps a visible gap,
and that includes the blocks that hang off a card.

Each session card has four connection points.

- **Left and right** join it to other sessions. Left is the card that made it, right is the cards it
  made. When a family grows leftwards the two swap, and the card's own labels swap with them, so a
  dot and the label beside it can never claim opposite things.
- **The top arrow** unfolds that card's **history**: one card per turn it took, newest first.
- **The bottom arrow** unfolds its **roots**: the files it runs from, in columns by kind.

A web belongs to its card. It moves when the card moves, it is placed clear of the card's own edges
and of the arrows and labels that hang off them, and if another card lands on it, that card moves
rather than the web. Drag a web by the title bar on its frame to put it somewhere yourself; it stays
where you put it and everything else gets out of its way.

### Wires

A wire between two cards is what permits a message. Drawn by hand it is two-way from the moment you
draw it; right-click it to make it one way. The arrowheads are the whole statement.

Wires are never changed by arranging the board. **Arranging is purely cosmetic.**

### Arranging, and getting your layout back

Right-click empty canvas for **Tidy layout**. It spaces the cards out without changing a single
wire. There were four named arrangements once (Web, Tree, Sequential, Waterfall) and they were taken
out again: an arrangement that decides where your cards belong is an opinion, and the one job worth
keeping is separating cards that overlap.

A snapshot of every position is taken automatically, on the server, before any arrangement. The
**Previous** button restores it and survives a reload, a restart and a different browser window. You
can also save the board under a name, and the Undo button in the top bar puts back the last
arrangement.

---

## Tabs

One tab per project. The account each tab's sessions run on is stated on the tab, and the server
enforces it: two separately billed Claude accounts can never share a tab.

Right-click a tab for:

- **Save this board** — writes the cards, their positions and every wire into `~/.garden/boards` as
  a JSON file you can keep, copy or read.
- **Open a saved board** — puts one back on screen.
- **Close** — stops everything running in that tab and takes it off the row. **Nothing is deleted.**
  The cards, the wires and where you put them are all kept; the sessions are marked stopped, because
  that is what they are. It asks twice and tells you how many sessions are still running.

The **+** button opens a project folder, a saved board, or a tab you closed earlier.

---

## Cards with a job

Right-click empty canvas and choose **New role card**. The form asks what the card is for, what it
runs on, who it answers to, its model and effort, and how many helpers it may keep.

The role is applied **before the session starts**, and that ordering is the whole point: the CLI
reads its permissions once, at launch, so a card that is started first and given a role afterwards
runs its entire first session unrestricted.

### The five roles, and what each one really loses

Enforcement is a `permissions.deny` entry in the per-session settings file Garden writes and passes
with `--settings`. The CLI refuses the tool. Garden never intercepts a dispatch and never argues
with a permission decision, which is what keeps one authority in charge.

| Role | Denied | Hires | What it is for |
| --- | --- | --- | --- |
| Orchestrator | Edit, MultiEdit, NotebookEdit, Bash | yes | owns the canon, hires the boss, talks to you |
| Boss | Write, Edit, MultiEdit, NotebookEdit | yes | takes a goal, hires managers, hands out departmental tasks |
| Manager | Edit, MultiEdit, NotebookEdit, Bash | yes | plans a department's work and hires the specialists |
| Worker | Agent, SendMessage, Task* | no | does the work; the only role that changes the repository |
| Reviewer | everything above plus Bash | no | reads and reports, and is called by the boss |

**Bash is the entry that matters.** Denying Write and Edit does not stop a card writing a file
through a shell. Any role with no sanctioned way to put bytes on disk loses Bash too. The boss is
the deliberate exception, because running the test suite is its job, and its brief says exactly that
rather than claiming more.

Reading stays open to every role. A card that cannot look at the code cannot brief anyone.

### What a card is given

Every card gets its own directory under `~/.garden/memory`, keyed to the card rather than the
process, so what it learns survives being turned off and on and survives being renamed:

- `CLAUDE.md` — what this card is, what the CLI will refuse it, who it answers to. Garden owns
  everything above a marker line and never touches what the card writes below it.
- `NOTES.md`, `LESSONS.md`, `PLAYBOOK.md` — the card's own, seeded once and never overwritten.
- `PEERS.md` — who it is wired to, which way each wire runs, and the exact command for sending.
- `POWERS.md` — its role, printed with the deny list verbatim.
- `INBOX.md` — what has been sent to it.

---

## How cards talk

An agent sends by running the shim whose path is in its own `PEERS.md`:

```
node <shim> --to "<card title>" --kind <kind> --task <task id> --text "<message>"
```

It posts to a loopback endpoint that can do exactly two things: append to a mailbox and record that
it did. It never types into a terminal, so terminal output can still never cause a command to run.
Who is sending comes from the environment variable Garden set when it spawned the shell, not from
anything the message claims.

### Kinds

`work`, `question`, `answer`, `review`, `done`, `confirm`, `assessment`, `remediation`.

A kind never decides direction. The wire does, and only the wire, so anything can travel either way
along a two-way wire. Two kinds carry a duty:

- **`confirm`** — when a card below you reports `done`, you look at what it did and confirm it.
  Garden refuses to let you report anything up while a report to you is unanswered. This is what
  stops work travelling to the top unread.
- **`assessment`** — how the finished work measures against what was actually asked for, which is a
  different question from whether the code is any good.

### What comes back to you

A task can go round the review loop **once**. After that, remediation downward is refused and the
only direction left is up. When a `done` or an `assessment` reaches an orchestrator, a report card
appears beside it holding: what was reported done, how it measures against what you asked for, what
the reviewer actually found, who confirmed whom on the way up, the questions they asked each other,
and every file written during the task, taken from the CLI's own tool calls.

There is no verdict line, and there never will be. Garden records what happened; whether the work is
right is your call.

---

## Watching it run

A card's status comes from the CLI's own words through hooks, not from process liveness. A subagent
gets a card the moment it is dispatched, wired to its parent, and keeps that card with its transcript
after the agent exits.

The gauge on each card reads the token counter the CLI prints, about a second behind, out of a
1M window. It says whether the figure came from the terminal or from the transcript, and the
transcript always wins. A card with nothing to read keeps a blank gauge rather than a guess.

**Codex sessions have no hook spine**, so those cards draw as unmonitored. That is a real limit,
stated rather than papered over.

---

## Testing it

Tests never touch the board you are using. `scripts/lib/instance.mjs` starts a server of its own on
a free port with `GARDEN_HOME` pointing at a temporary directory, which separates the board, the
mailboxes, the hook files and the notes.

```
node scripts/test-chain.mjs          # the chain, both directions, and the spiral guard
node scripts/test-no-overlap.mjs     # nothing ever covers anything
node scripts/test-web-drag.mjs       # picking up a whole web
node scripts/test-role-card.mjs      # the form, and the deny list it really wrote
node scripts/test-tab-close.mjs      # closing a tab keeps its board
node scripts/test-corner-resize.mjs  # corners, and the header they must not cover
node scripts/measure-cards.mjs       # drawn geometry against stored, side by side
node scripts/check-overlaps.mjs      # reads the live board, read-only, changes nothing
```

`measure-cards.mjs` earns its place: stored rows said the board was fine while the owner was
looking at an overlap, and both were true, because a web's frame is drawn and is not a stored card.

---

## What is not built

- Roots columns only appear when they have files in them. An empty column is not shown.
- The worker's write-notes-then-clear gate. Nothing stops a worker clearing its context before its
  lesson is recorded.
- A view for the pipeline. It is derived and reachable over the socket; nothing draws it.
- A subagent card cannot send mail. It has no process of its own to run the shim from, so it reports
  through its parent.
- Most of the older scripts in `scripts/` still connect to port 5178 rather than starting their own
  instance. Migrate one before you run it against a board you care about.
