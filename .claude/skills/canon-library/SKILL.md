---
name: canon-library
description: How an orchestrator builds and maintains a canon library - a set of technical specification documents, written in plain English, that describe what an app currently is and does, and that get revised as the owner's requests change the app. Canon is what the boss card reads to decide what work exists, so it is the single source the org chart works from. Use when asked to "write canon", "update the canon", "describe the current state of the app", "spec this out", "document what we have", when bootstrapping canon for a project that has none, or at the point where a conversation with the owner has settled a change that canon does not yet reflect.
---

# The canon library

Canon is the description of what an app claims to be and to do. It exists so that the people
doing the work and the person asking for it are looking at the same document. In an org chart of
cards, the orchestrator writes canon from the owner's words, the boss reads canon and decides
what categories of work it implies, managers take a category each, and specialists build. Nothing
below the orchestrator writes canon.

That separation is the whole mechanism, not an administrative nicety. A card that can both do the
work and revise the description of what the work was supposed to be can never be found wrong. As
soon as canon is editable from below, a `done` report stops meaning anything, because the target
moved. Keep the two apart and a report becomes checkable.

## Where it lives and how it is shaped

Default to `docs/canonical/` in the project repo.

**Check first whether the project's own tooling recognises a canon path, and match it exactly.**
An app that watches for canon being written will have a path test somewhere, and canon written
half an inch outside it is invisible to the thing built to see it. In Garden this is `isCanonPath`
in `server/src/pipeline.ts`, which matches `docs/canonical/` and any file ending `-truth.md` and
nothing else; a library first created at `docs/canon/` had to be moved. Grep for the words canon
or truth in the source before choosing the directory. It costs one search and it is the difference
between canon that registers and canon that does not.

Inside it, an `INDEX.md` with one row per document, and one document per subject.

Many small documents, not one big one. There are two reasons and both are load-bearing. An
orchestrator card is typically denied Edit and given only Write, because canon is authored whole,
which means every revision is a full rewrite: read the current document, write the new version
complete. A large document is expensive to rewrite and easy to corrupt subtly in the process. And
a document scoped to one subject can be handed to one manager without that manager having to work
out which third of it applies to them.

Split a document before it outgrows a single clear subject, rather than after.

Number the files so the reading order is the file order. `00-` for the charter that explains how
canon works, then one number per subject, ending with a document for the gaps. The index says
plainly when something does not exist yet, so a reader can tell an empty canon from a canon they
failed to find.

## What a claim looks like

A claim states something the app is or does, concretely enough that someone can tell whether it
is true yet. "Cards survive being turned off and can be picked up again" is a claim, because there
is a state of the world that settles it. "Improve the board" is not.

Write in the owner's terms, in ordinary sentences. This is a specification, so it must be precise
about names, paths, numbers and limits, but precision is not the same as jargon. Name the exact
identifiers where they matter (a command name, a file path, a table column) because a manager will
search for those strings, and say what the thing does in plain language around them.

Keep the reason attached wherever a decision looks arbitrary. A spec that says what without why
gets "simplified" by the next person who reads it. Most of the hard-won constraints in a mature
project look like arbitrary fussiness until the sentence explaining what broke is sitting next to
them.

A claim does not prescribe an implementation. That decision belongs to the card closest to the
code, and a claim that specifies the how takes it away from them. State the behaviour and the
constraint; leave the method open unless the method is itself the owner's requirement.

Mark what is built against what is wanted. A document that mixes the two without saying which is
which is worse than no document, because it reads as a status report and is actually a wish list.
Give the library a gaps document, and keep three things apart inside it: decided and not built,
which is waiting on work; found unwired, which is code that exists and cannot be reached, and is
different because nobody chose it; and known limits, which will not be fixed.

## Bootstrapping canon for an existing project

The trap is writing canon from the project's own README, DEVELOPMENT.md or design plan. Those are
narratives with rationale woven through, they were written at a moment, and they drift from the
code silently. Canon written from prose inherits every one of those errors and then launders them,
because the boss will treat canon as authoritative.

Read the prose to learn the vocabulary and the intent. Then check the claims against the code.

The efficient route, when subagents are available: send several at non-overlapping slices at once,
one discrete question each. Slices that work for most apps are the external command surface, the
persisted state and disk layout, the user-facing interface, and whatever the project's distinctive
enforcement mechanism is. Give each of them the absolute paths, tell them explicitly not to read
the prose docs, and require file:line for every claim with identifiers quoted exactly as they
appear rather than paraphrased.

Ask each one, explicitly, for the mismatches: a command defined but never handled, a table written
but never read, a control rendered but unreachable, a message type the other side never sends.
Those are the most valuable thing a survey returns, because they are precisely the claims a prose
doc will state as working.

Then treat what comes back as a claim rather than a fact, and open a few of the citations directly
before writing them into canon. An agent that searched two of four naming conventions will still
report that nothing else exists. In the Garden pass, spot-checking caught that a table the prose
placed in one file actually lived in another.

Where the prose and the code disagree, canon follows the code and says that it did.

## Revising canon when the owner changes something

Canon changes when the owner decides something, not when work happens. The sequence is: the owner
says what they want, the orchestrator writes it into canon, and only then does work get dispatched
against it. Writing canon after the fact, to match what got built, is the failure this whole
structure exists to prevent.

When work reveals that a claim is wrong, unbuildable, or was never what the owner meant, that
travels back up as a report and the owner decides. It does not get quietly rewritten from below.

Every document carries a revision line at the bottom: what number, what date, what changed. A card
reading the document needs to be able to tell whether it is looking at something the owner has
seen recently. Keep the line short and factual.

Update `INDEX.md` in the same pass as any document that was added, split or retired. An index that
lags is worse than no index, because it is trusted.

## The standard this holds itself to

State only what can be shown. If canon says a limit is enforced, there should be code that
refuses; if the limit is a request in prose that nothing checks, canon says that instead. The
difference between "enforced" and "asked for" is the most important distinction in the whole
library, because everything downstream is planned on the assumption that canon is accurate about
which is which. Where a limit is half of each, say which half.

Say what the pass did not verify. A library built from a code survey is a claim about what the
code says it does, which is weaker than a claim about what it did, and the difference should be
written down rather than left for a reader to assume the stronger version.

Where something is genuinely unknown, write it as unknown. Unknown is a legitimate state and it is
cheap to resolve later. A confident guess is neither.
