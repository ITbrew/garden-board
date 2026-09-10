# The commands a card can run

**These are the only way a session reaches the board from inside itself.** Everything else in Garden
arrives over the WebSocket, which only the owner's hands touch.

**All of them take `GARDEN_SESSION_ID` from the environment.** Garden sets it when it spawns the
shell and everything under that shell inherits it. **A card never names itself in an argument**,
because that would be a claim it makes about itself rather than a fact about which terminal it is.

---

## `garden-send.mjs` — hand work along a wire

```
node garden-send.mjs --to "<card>"        --kind <kind> --task <id> --file "<path>"
node garden-send.mjs --to-many "A, B, C"  --kind <kind> --task <id> --file "<path>"
```

**Write the message to a file first, with a file writing tool rather than a shell command.** A quote
inside `--text` is reopened by the shell and the tail of the message is lost before this script's
first line runs. A heredoc survives that and hits a harder wall: a command carrying a few thousand
characters has to be security scanned, so the card stops and waits for the owner by hand.

### `--to-many` and why it is a separate flag

**A broadcast cannot be spelled as a repeated `--to`.** `--to` refuses to appear twice on purpose,
because a message shattered at a quote arrives as exactly that shape and the refusal is how the
break gets noticed. **Keeping that refusal is worth more than the convenience.**

**Three rules it enforces, all learned from one stop on 2026-08-20:**

```
--to and --to-many together   refused. One or the other.
--to-many with --text         refused. A shattered inline body sent to fifteen cards is
                              fifteen bad messages and fifteen reported successes.
a name listed twice           refused, rather than delivering the message twice.
```

**It prints the resolved names before it sends anything**, so a typo in a list of fifteen is caught
while it is still cheap, and it ends with a count and the names of anything that failed.

**Measured cost of not having it:** when the owner reached 95 percent of his weekly usage and asked
for every card to stop, that was fifteen separate invocations, and every card then had to read the
message, which he also paid for.

---

## `garden-status.mjs` — who is alive, and what have they spent

```
node garden-status.mjs                  every live card on this card's board
node garden-status.mjs --to "SFX"       one card
node garden-status.mjs --finished       include cards that have already finished
node garden-status.mjs --json           raw rows
```

**Read only. No argument changes anything.**

### What it answers

**`garden-send` says "filed" or "the card is starting" and then never says anything again.** Until
this existed, the only signal a sender had was a reply, and **silence was indistinguishable from
never started, started and declined, and died.**

**On 2026-08-20 an orchestrator sent three cards the same request twice over four hours, got
nothing, and left them alone on a guess. Running this now shows them at `failed`, and they had been
for days.**

**CORRECTED 2026-08-24: a message to a failed card is NOT lost.** The first version of this file said
it was "filed and never read", and that is false. **Sending to a failed card WAKES it**, and it reads
its inbox as it comes up. Two failed cards were woken this way by a test message whose own body
claimed it would cost nobody anything.

> **The distinction was in `garden-send`'s output the whole time.** It answers **"delivered to X, and
> it has been told on screen"** when the card is up, and **"filed for X and the card is starting"**
> when it is not. **The second sentence says exactly what is happening and it was read as boilerplate
> for a week.**

**So what silence actually meant on 2026-08-20 was: the cards were woken by the first send, came up,
and then failed again or stalled.** Which is a different problem from never receiving anything, and
one nobody could see.

**It also answers the second half:** the same day the owner hit 95 percent of his weekly usage and
the orchestrator could not say which cards had spent it.

### The provenance rule applies to every column

**A number the CLI has not reported prints as `unknown` and never as zero.** A token figure says
whether it came from `transcript` (the CLI's own usage record: exact, written after the turn ends)
or from `terminal` (a figure the CLI printed on its own spinner: live, but rendered rather than
published). **A reader who cannot tell those apart will trust the live one too far.**

**And the count of rows with no figure is printed as its own line**, because a table of mostly
unknown is a different situation from a table of mostly known, and nobody scanning rows adds it up.

### Finished cards are collapsed by default

**A board that has been working for a week accumulates dozens of `done` subagent cards.** The first
version printed all seventy, and the two rows that answered the question, two managers sitting at
`failed` for four days, were on screen and were not found. **That is the same burying the tool exists
to undo.**

---

## `garden-hire.mjs` — bring a card into existence

**Only the orchestrator should run this.** Without `--reports-to` the card is created unreachable
and cannot be wired afterwards, and only the owner can draw a wire between two existing cards.

---

## `garden-restart.mjs` — not for cards

**This restarts the Garden SERVER, not a card.** It is launched detached by the server itself and
waits on the port actually closing. **A card has no reason to run it.**

---

## `garden-asks.mjs` — what a card wants the owner to decide

```
node garden-asks.mjs              everything marked and not yet raised with him
node garden-asks.mjs --all        including what has already been raised
node garden-asks.mjs --clear      record the listed ones as raised
```

**Read only unless `--clear` is passed.**

### The failure it exists for

**On 2026-08-19 a card wrote, in the second paragraph of a long report about something else, that
the owner had rebaked the wrong eight operators and that any animation he saw proved nothing.** It
ended: *"That is worth a sentence to him tonight, ahead of everything else in this message."*

**It never reached him.** The orchestrator read it as content. For nineteen hours he could have
repeated the same wasted work.

**The card did everything right.** It identified the urgency, put it above its own findings, and
named who needed to know and by when. **What it could not do was make the request louder than the
document it arrived in**, because a card reaches the owner only through the orchestrator and that
route fails silently.

### It does not add a route, it makes the existing one hard to miss

**The owner has confirmed cards should keep asking the orchestrator, and the orchestrator asks
him.** So a card marks the line and nothing else changes:

```
[NEEDS-OWNER] There is no wind effect in the five packs. Buy one, or accept the blank.
```

**Nothing is inferred from prose and no message is summarised.** A marked line is quoted exactly as
written; an unmarked one is invisible here. **Guessing at urgency from tone is the inference this
app refuses**, so the marker is the whole mechanism.

### `--clear` answers a different question later

**It appends to `ASKED.md` beside the inbox, with a timestamp.** The question that could not be
answered about the rebake warning was not "is it done" but **"when was he told"**, and a file
holding only current state cannot answer that.

---

## What is still missing, written down rather than discovered again

```
no way to CANCEL a dispatch    a stop has to be sent as a message the card then reads,
                               and a card mid-turn finishes anyway
every card commits as one user     per-commit attribution across cards is impossible, and
                               `git add X && git commit` commits the INDEX, so one card
                               can sweep another's staged files into its own commit
capabilities are undocumented  what a card can actually DO is not in the roster. One card
                               was sent measurement work for hours before it emerged that
                               it has no way to run anything at all
PEERS.md is server-generated   so teaching every card about --to-many needs a server
                               rebuild, not an edit to this file
```

## `garden-supervise.mjs`, keeping the server up and recording it when it is not

**Written 2026-08-24, after fifteen cards died inside eighteen seconds and nothing on the machine
could say why.**

Every card's PTY is a child of the one server process, so when the server goes they all go together,
with no error and no survivor to report it. Two things were missing that day and this is both.

**Nothing recorded the death.** The server's stdout goes to whatever terminal launched it and is
lost when that window closes; the newest server log on the machine was five days stale. The cause
had to be inferred from free memory and an application queue log rather than read. **A supervisor that
restarted the server without writing down why it died would fix the symptom and destroy the only
evidence**, so the log matters more here than the restart.

**Nothing brought it back.** A dead server stayed dead until the owner noticed, which is why he was
copy-pasting resume ids by hand.

```
npm run dev:supervised          the whole board, server supervised, web as usual
npm run dev:server:supervised   just the server
```

The old `npm run dev` is **unchanged and still the default**. The supervised scripts sit beside it
rather than replacing it, because the supervisor has been exercised against dummy children and not
yet against a real server, and switching the default to something unproven is how a bad morning
starts.

**Where it writes:** `~/.garden/logs/server.log`, rotated at 8 MB to `server.log.1`. Rotation is by
size rather than by date on purpose: the interesting window is the minutes before a death, and that
window does not respect midnight. `~/.garden/logs/last-loss.json` holds the most recent death, with
how long it had been up and how many sessions were alive when it went.

**Backoff is 2s doubling to a 60s ceiling**, reset once a run survives two minutes. If the server is
dying because the machine is out of memory, restarting instantly makes the machine worse and buries
the one useful log entry under thousands of its own restarts.

**It does NOT revive cards, deliberately.** A crash loop that relaunched fifteen agents by itself
would spend the owner's money in a circle, and spending is his decision rather than a recovery step.
The health snapshot in `last-loss.json` says how many were live, and `garden-status` prints the
revive command per card.

**Flags:** `--once` runs it and logs the exit without restarting. `--dry-run <cmd>` supervises any
command instead of the server, and `--log-dir <path>` sends the log elsewhere. Those two exist so
this can be tested at all: the standing rule is that a harness never runs against the live board, and
a supervisor with a hard-coded target and log path cannot be exercised without breaking that.

## `garden-wire.mjs`, the half of a card's board powers that had no command

**Written 2026-08-24, after the owner reported that an orchestrator on another project could not make
cards or wires.**

**The capability was never withheld.** `wire.create` in `index.ts` has **no permission check at all**:
it validates that both ends exist and that they are not the same card, and then makes the wire. There
was simply **no tool**, so the protocol allowed something no card could reach.

```
node garden-wire.mjs --to "DEF side"                    wire the caller to that card, both ways
node garden-wire.mjs --from "ATK side" --to "DEF side"   wire two other cards
node garden-wire.mjs --to "Scout" --label "search"       name the line on the board
node garden-wire.mjs --to "Scout" --one-way              caller speaks, the far end cannot answer
```

**Why it matters more than convenience.** `garden-hire.mjs --reports-to` decides the new card's
parent, and **a card hired without it lands with no parent, therefore no wire, therefore unreachable
in both directions**. Until this file existed that mistake was **unrecoverable from a card**: the only
repair was the owner drawing the line by hand. The gap did not just block new connections, it made one
missing flag permanent.

**Titles resolve inside the caller's own project only.** Two boards can hold cards with the same name,
and searching everywhere would let a wire cross projects on a coincidence of spelling. An exact id is
always honoured; only guessing is refused. **A title matching more than one card is refused with the
ids rather than resolved silently.**

**Already-wired is reported as success, not as a timeout.** The server returns early and silently when
the pair already has a wire, so nothing comes back; without that branch the tool would sit until its
own deadline and report that nothing was wired, which is false in the one direction that matters and
sends the caller to retry something that was never broken.

**Verified:** unknown flag refused; unknown card refused with the board's card list; an already-wired
pair reported with its label and exit 0; an ambiguous title refused with three ids. **NOT verified: the
creation path itself**, because exercising it means leaving a real wire on the owner's live board, and
there is no delete tool to take it back.
