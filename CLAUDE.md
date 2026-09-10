# Garden

A node-graph control room for AI CLI sessions. Windows 11, personal use, one user, one machine.

Read `DEVELOPMENT.md` for architecture and what is built.

## The rule this project exists to enforce

**Never show the owner something Garden cannot prove.**

Label derived state as `structured` when supported by a hook or machine-readable record, or
`inferred` when based on a pattern. Display these differently. Unknown is neither absent nor healthy.

Concretely, that forbids: inferring a stage happened from silence, regexing prose to decide what
an agent did, showing a subagent as interactive when its process has ended, and claiming a
session survived an app restart when a Windows process cannot be re-parented.

## Blind review: default ON

Every change with a visible surface ends with a double-blind pass. Capture with:

```
npm run dev          # both servers must be running
node scripts/capture.mjs
```

Shots land in `docs/shots/`. Then hand the image paths to a **freshly spawned** subagent with
neutral questions only, per the `double-blind-review` skill. The agent that wrote the code must
not open the screenshots to judge them, and must not use a `fork` as the reviewer. Relay what the
reviewer found, roughly verbatim. If no blind pass ran, say so in the completion message.

Debugging geometry or content by querying the DOM through the capture script is fine and
encouraged. That is reading data, not grading pixels.

## Things that will bite

`node-pty` is native. It works here only because it ships a `win32-x64` prebuild; npm 11 also
blocks install scripts unless the package is listed in `allowScripts` in the **root**
`package.json`, since a workspace-level entry is silently ignored.

**Use node-pty's bundled ConPTY:** `useConptyDll: true` in `server/src/pty-manager.ts`.
The recorded resize test produced six duplicate screens with Windows ConPTY and none with the
bundled version. `GARDEN_CONPTY_DLL=0` is the fallback for this experimental flag. Run
`scripts/test-conpty-reflow.mjs` when changing terminal rendering.

xterm.js must never be rendered inside the canvas transform. It is not scale-aware, so a scaled
terminal selects the wrong characters, and it is expensive enough that instances are pooled in
`apps/web/src/terminal-pool.ts` and capped. Terminals live in the 1:1 dock.

**Backend restarts end the board's PTY sessions.** `npm run dev:server` runs without a watcher;
saving source does not activate backend changes. The launcher must not use `npm run dev:server:watch`.
Coordinate deliberate restarts after the work is saved and ready, and report whether a change is
only on disk or active in the running backend.

Keep the existing edit order: **client files first, `server/src` and `packages/shared/src` last**.
Finish the batch before restarting; a source save itself does not restart the normal backend.

Opening a terminal pane must focus the terminal so subsequent keystrokes reach it.

## Version

Garden's version is in the header, and it is how the owner checks that a restart put him on the code
he was told about. Any change he can see on screen or feel in behaviour bumps the patch number in
`package.json`, `apps/web/package.json` and `server/package.json`, all three together, in the same
commit as the change rather than in a pass afterwards. A test, a comment or a document moves nothing.
Then tell him the number to look for. Canon: `docs/canonical/22-which-build-is-running.md`.

The two halves each carry their own version and commit, and the header draws a warning chip when they
differ, which is what a backend restarted on its own looks like.

## Style

Follow the machine's global instructions in `~/.claude/CLAUDE.md`. In short: no em dashes,
prose over bullet lists, no decorative emoji, no hype, and lead status reports with what was
actually verified rather than a test count.
