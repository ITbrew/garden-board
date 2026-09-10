import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { actions, getLayouts, getLimits, onLayouts, onLimits, useApp } from '../state'
import { LimitsPanel } from './LimitsPanel'
/*
 * This rail no longer arranges anything, so it no longer reads the layout table, the wires or the
 * documents. `layout.ts` and `hierarchy.ts` are untouched: the canvas still lays a spawned team out
 * through them, and `docFiles` is still filled by the server and still read by whatever opens a
 * document. What went is this file's use of them.
 */

export function Sidebar({ onFold }: { onFold?: () => void }) {
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const focused = useApp((s) => s.focused)

  const active = projects.find((p) => p.id === activeProjectId)
  /*
   * Nothing in this rail is gated on the tab's account, and that is the decision rather than an
   * omission.
   *
   * The account is chosen once when the tab is created, and every session in it after that,
   * including ones an agent spawns, inherits it silently. Gating the launchers here would mean a
   * spawned card could stall waiting for a sign-in nobody is watching for.
   *
   * There was a `needsAccount` flag on this line, hard-coded to false and read by nothing, left
   * from when the rail was going to do that gating. The reasoning was worth keeping and the flag
   * was not. The subscription to `profiles` went with it: it was read nowhere in this file and was
   * re-rendering the whole rail every time an account changed anywhere.
   */
  /*
   * The saved layouts for this project, from the server.
   *
   * useSyncExternalStore rather than state, since they arrive on the socket and several parts of
   * the rail read them. The automatic one is split out because it is the way back rather than a
   * board the owner chose to keep.
   */
  const layoutList = useSyncExternalStore(
    onLayouts,
    () => getLayouts(activeProjectId),
    () => [],
  )
  const automatic = layoutList.find((l) => l.automatic)
  const saved = layoutList.filter((l) => !l.automatic)

  useEffect(() => {
    if (activeProjectId) actions.listLayouts(activeProjectId)
  }, [activeProjectId])

  /*
   * The ceiling and what counts against it.
   *
   * `counted` only moves when this panel actually asks: the server re-sends it unprompted after
   * `limits.set` changes the ceiling, but not after a plain `session.create` or `session.delete`
   * changes what is counted (see the note on `boardLimits` in state.ts). Watching the open-card
   * count for this project and asking again whenever it moves is what keeps "4 of 12" from going
   * stale the moment a card is made or closed.
   */
  const limitsData = useSyncExternalStore(
    onLimits,
    () => getLimits(activeProjectId),
    () => undefined,
  )
  const openCardCount = useMemo(
    () => sessions.filter((s) => s.projectId === activeProjectId && s.closedAt === null).length,
    [sessions, activeProjectId],
  )
  useEffect(() => {
    if (activeProjectId) actions.refreshLimits(activeProjectId)
  }, [activeProjectId, openCardCount])

  /*
   * The sessions with a process behind them right now.
   *
   * A card outlives its process on purpose, so the board is full of cards that have finished. The
   * question this list answers is what is alive, which is also what "stop all" acts on, so the two
   * are derived from the same thing rather than each deciding for itself.
   */
  const liveSessions = useMemo(
    () => sessions.filter((s) => s.projectId === activeProjectId && s.pid !== null),
    [sessions, activeProjectId],
  )

  /*
   * The cards Play would actually switch on, which is a narrower set than "not running".
   *
   * Three conditions, and each one excludes a card that would otherwise be started pointlessly or
   * wrongly. Only `kind === 'session'` owns a process at all: a subagent or teammate card is the
   * record of an agent that already ran, and starting one spawns a fresh CLI wearing a finished
   * agent's name, which is exactly what `flushMailWake` refuses to do for the same reason
   * (server/src/index.ts, the `s.kind !== 'session'` guard). `closedAt === null` keeps a card the
   * owner deliberately put down where he put it, for the same reason mail never wakes a closed
   * card. And `pid === null` is what makes this the complement of `liveSessions` rather than a
   * second opinion about it: both read the same field, so the two counts in the foot can never
   * disagree about the same card.
   */
  const startableSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.projectId === activeProjectId &&
          s.kind === 'session' &&
          s.closedAt === null &&
          s.pid === null,
      ),
    [sessions, activeProjectId],
  )

  /*
   * The cards that have been taken off the board, newest first.
   *
   * `closedAt` is the only thing that decides this, because it is the only thing that records the
   * owner's decision. A card that merely stopped is still on the board and belongs nowhere near
   * here. Newest first because the card just closed is the one most likely to be wanted back.
   */
  const closedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === activeProjectId && s.closedAt !== null)
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    [sessions, activeProjectId],
  )

  /*
   * Which closed card has its delete armed, if any.
   *
   * This is deliberately not `window.confirm`. Once Chrome has been told to suppress dialogs for a
   * page it returns false for the rest of that page's life, and the delete on doc cards silently
   * did nothing for exactly that reason. A second press on a button that has changed its own label
   * cannot be suppressed by the browser, and it is visible, which a native dialog stops being.
   */
  const [armedDelete, setArmedDelete] = useState<string | null>(null)

  return (
    <aside className="rail">
      {/*
        The fold control belongs to the rail, not to the header.

        It was in the top bar first, and the owner's correction is the general rule rather than a
        preference: "it shoudl be connected to the bar it collapses". A control sitting in one
        region that acts on another has to be learned; one attached to the thing it moves does not.

        Pinned to the rail's own top-right corner, so it is where a window's minimise is. What puts
        it back is a tab at the edge of the canvas, drawn by App, because this whole element is gone
        once it folds and a control that disappears with the thing it hides can never undo itself.
      */}
      {onFold && (
        <button className="rail-fold" title="Hide this bar" aria-label="Hide this bar" onClick={onFold}>
          ‹
        </button>
      )}
      <section className="rail-section">
        <h3 className="rail-title">New terminal</h3>
        <div className="launchers">
          <button
            data-cap="launch-shell"
            className="btn btn--wide"
            disabled={!active}
            onClick={() => active && actions.newSession(active.id, 'shell')}
          >
            Shell
          </button>
          <button
            data-cap="launch-claude"
            className="btn btn--wide"
            disabled={!active}
            onClick={() => active && actions.newSession(active.id, 'claude')}
          >
            Claude Code
          </button>
          <button
            data-cap="launch-codex"
            className="btn btn--wide"
            disabled={!active}
            onClick={() => active && actions.newSession(active.id, 'codex')}
          >
            Codex
          </button>
        </div>
        {/* The path is also on the title, so a rail narrowed to nothing still has it in full. */}
        {active && (
          <p className="hint" title={active.path}>
            Runs in {active.path}
          </p>
        )}
      </section>

      {/*
        What the launchers above and every hiring card are held to.

        Waits for the first answer rather than drawing zeroes while it round-trips: a "0 of 0"
        flashed for one frame reads as an empty board, which on the owner's actual board is never
        true, and is a worse first impression than a blank section for a moment.
      */}
      {active && limitsData && (
        <section className="rail-section">
          <h3 className="rail-title">Ceiling</h3>
          <LimitsPanel projectId={active.id} limits={limitsData.limits} counted={limitsData.counted} />
        </section>
      )}

      {/*
        Three sections stood here and the owner asked for all three to go: the Tasks list ("a giant
        unstructured meaningless list of data ill never read"), "Open a file" over hundreds of
        unsorted paths, and "Arrange the board", whose styles he reported did not produce the shapes
        they named. None of the machinery went with them. Task rows are still kept, still enforced
        and still read by cards and the orchestrator through `task.state` and `garden-task.mjs`;
        what the owner sees of a task is on the card that holds it, its id and state on the face and
        its refusals in the pill above it. Documents still open from document cards, from links in
        messages and from `doc.open` anywhere else, and `doc.create` is unchanged. `layout.ts` is
        untouched, because a spawned team still places itself through it, and the Layouts section
        below keeps Previous and the saved boards.
      */}

      {/*
        The way back, and the boards worth keeping.

        Previous restores the snapshot the server takes before every arrangement, so it survives a
        reload, a restart and another window. The first version of this lived in a browser tab and
        lost the way back the moment the page refreshed, which is exactly the fear the owner
        described about pressing an arrangement on a board he had built by hand.

        A saved layout is the same thing kept deliberately and named. Positions only: it never
        claims to bring a session back, because a process cannot be restored and a card pretending
        otherwise would be the worst kind of lie this board could tell.
      */}
      <section className="rail-section">
        <h3 className="rail-title">Layouts</h3>
        <div className="launchers">
          {/*
            Tidy, first, because it is the one arrangement that survived and the rail is where the
            owner looks for it: "add 'tidy layout' from right click to the layouts section".

            The same action the board's own right-click menu runs, calling `actions.tidyBoard`, not a
            second implementation of packing. Two buttons that repack a board slightly differently is
            how the arrangement styles that were removed from this rail got their reputation.

            Previous sits below the saved boards and undoes whichever of them was pressed.
          */}
          <button
            className="btn btn--wide"
            disabled={!active}
            title="Repack every card on this board into rows, keeping nothing but the order they are in. Previous puts them back."
            onClick={() => active && actions.tidyBoard(active.id)}
          >
            Tidy layout
          </button>
          {saved.map((l) => (
            <div key={l.id} className="layout-row">
              <button
                className="btn btn--wide"
                title={`Restore "${l.name}", saved ${new Date(l.savedAt).toLocaleString()}`}
                onClick={() => actions.restoreLayout(l.id)}
              >
                {l.name}
              </button>
              <button
                className="btn btn--ghost layout-row__drop"
                title={`Forget "${l.name}"`}
                onClick={() => {
                  if (window.confirm(`Forget the layout "${l.name}"? The cards stay exactly where they are.`)) {
                    actions.deleteLayout(l.id)
                  }
                }}
              >
                x
              </button>
            </div>
          ))}
          {/*
            Previous under the buttons it undoes, at the owner's instruction on 2026-09-10: "re
            order layout section 1. tidy 2. web 3. previous 4. save."

            The "web" in his list is a board he saved by name, not an arrangement style: those are
            gone from every surface (canon 02) and none came back. So the order is Tidy, his saved
            boards, then the way back from whichever was just pressed, then Save, which is the only
            button here that changes nothing on screen. Previous sat second until now, which put the
            undo above the thing it undoes.
          */}
          {automatic && (
            <button
              className="btn btn--wide"
              title={`Put every card back where it was before the last arrangement, saved ${new Date(
                automatic.savedAt,
              ).toLocaleTimeString()}`}
              onClick={() => actions.restoreLayout(automatic.id)}
            >
              Previous
            </button>
          )}
          <button
            className="btn btn--wide"
            disabled={!active}
            title="Save where every card is right now, under a name you choose"
            onClick={() => {
              if (!active) return
              const name = window.prompt('Name this layout', 'my board')
              if (name?.trim()) actions.saveLayout(active.id, name.trim())
            }}
          >
            Save this layout
          </button>
        </div>
      </section>

      {/*
        Live sessions only.

        This listed every card in the project, which on a board that keeps its cards forever is a
        list of everything that has ever run. What it is useful for is the opposite question: what
        is running right now, and therefore what is costing something. A card that has stopped is
        still on the board with its history; it just does not belong in a list of live processes.
      */}
      {/*
        Not the growing one any more.

        This section used to take all the leftover height so the controls below it sat against the
        bottom of the rail. Once closed cards were added underneath, that left a blank stripe the
        height of the window between two headings, and a blind reviewer read it as a broken layout
        rather than as spacing. The stretch moved to a spacer below the last list, so the sections
        stay together at the top and the bottom controls still sit where they did.
      */}
      <section className="rail-section">
        <h3 className="rail-title">Running now</h3>
        <ul className="list">
          {liveSessions.map((s) => (
            <li key={s.id}>
              <button
                className={`row ${focused.includes(s.id) ? 'is-active' : ''}`}
                onClick={() => actions.focus(s.id)}
              >
                <span className={`dot dot--${s.status}`} />
                <span className="row-label">{s.title}</span>
              </button>
            </li>
          ))}
          {liveSessions.length === 0 && <li className="hint">Nothing running in this project.</li>}
        </ul>
      </section>

      {/*
        The cards taken off the board, and the only place they can actually be destroyed.

        Nothing here is running, so nothing here gets a status dot: a dot on a closed card would be
        the board asserting a process state it has no process to read. Each row says the three
        things it can prove from its own row, which are the title, the role the owner set on it and
        the moment it was closed.

        Bringing one back is free, because closing never removed anything. Deleting is not: it takes
        the turns, the events, the wires and everything the agent wrote with it, and unlike a doc
        card there is no file left on disk afterwards to open. That is why the destructive button is
        the only one in this rail that has to be pressed twice.

        The whole section disappears when it is empty rather than standing there as a heading over
        nothing, which is how the launchers and the layouts behave.
      */}
      {closedSessions.length > 0 && (
        <section className="rail-section">
          <h3 className="rail-title">Closed cards</h3>
          <ul className="list">
            {closedSessions.map((s) => (
              <li key={s.id}>
                <div className="row-label" title={s.title}>
                  {s.title}
                </div>
                <div className="hint">
                  {s.roleClass ? `${s.roleClass}, ` : ''}
                  {s.closedAt === null ? 'closed' : `closed ${new Date(s.closedAt).toLocaleString()}`}
                </div>
                <div className="layout-row">
                  {armedDelete === s.id ? (
                    <>
                      <button
                        className="btn btn--wide btn--danger"
                        title={`Permanently destroy "${s.title}" and everything it recorded. This cannot be undone.`}
                        onClick={() => {
                          actions.deleteSession(s.id)
                          setArmedDelete(null)
                        }}
                      >
                        Really delete?
                      </button>
                      <button className="btn btn--ghost" onClick={() => setArmedDelete(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn--wide"
                        title="Put this card back on the board with its history intact"
                        onClick={() => actions.restoreSession(s.id)}
                      >
                        Bring back
                      </button>
                      {/*
                        Named and coloured, rather than a lone "x".

                        At icon size beside a full-width button it was, in a blind reviewer's words,
                        near-invisible and hard to hit. Named but still plain, a second reviewer
                        called out that the irreversible action was the less prominent of the two and
                        read as a caption rather than a control. The one thing here that cannot be
                        undone should be the one that looks like it.
                      */}
                      <button
                        className="btn btn--danger"
                        title="Delete this card and its whole history for good"
                        onClick={() => setArmedDelete(s.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        The stretch, so every section above stays packed at the top and the controls below stay at
        the bottom. An empty div rather than growing the last section, because which section is last
        depends on whether anything is closed, and a stretch that moves around is how the gap
        appeared in the first place.
      */}
      <div className="rail-spacer" />

      {/*
        Start and stop everything, at the bottom where things you rarely want belong.

        Stop all ends the processes and leaves every card, its wires and its history exactly where
        they are, which is the same thing turning a card off does, done to all of them at once.

        Named "Play all" at the owner's word, to pair with "Stop all" directly beneath it. The two
        are a pair and act on the same board at once, so they read as one.

        There deliberately was no "start all" beside it until 2026-08-13, on the reasoning that
        picking work back up is a conversation with the session that owns the work rather than a
        button here. The owner changed his mind and the reasoning was wrong about what he wanted,
        not merely overruled: Play is not for handing out work, it is for having every card awake
        and ready before he starts, so that when he does want to talk to one it is already there
        instead of costing him a launch. In his words, sitting idle is free. What he wants capped is
        how many cards are WORKING at once, which is a different count and is not this button.

        So Play produces exactly what `idle` already means: a live process at a prompt with nothing
        to do. It sends the same per-card `session.start` the card's own switch sends, in a loop,
        because there is no batch lifecycle message in the protocol and this needed neither.

        No confirmation, unlike Stop all. Stop all is confirmed because it destroys running work
        that cannot be got back; Play only creates processes, and the button that undoes it is the
        one directly underneath. A dialog in front of the cheap, reversible half of a pair teaches
        the owner to dismiss the dialog in front of the expensive half.
      */}
      <section className="rail-section rail-section--foot">
        <button
          className="btn btn--wide"
          disabled={startableSessions.length === 0}
          title="Starts every card in this project that has a process and is switched off, so they sit idle and ready."
          onClick={() => {
            if (!active) return
            for (const s of startableSessions) actions.startSession(s.id)
          }}
        >
          Play all {startableSessions.length > 0 ? `(${startableSessions.length})` : ''}
        </button>
        <button
          className="btn btn--wide btn--danger"
          disabled={liveSessions.length === 0}
          title="Ends every running process in this project. Every card, wire and history stays."
          onClick={() => {
            if (!active) return
            const n = liveSessions.length
            const ok = window.confirm(
              `Stop ${n} running session${n === 1 ? '' : 's'} in ${active.name}?

` +
                'The cards, their wires and everything they recorded stay on the board. Only the ' +
                'processes end.',
            )
            if (ok) for (const s of liveSessions) actions.stopSession(s.id)
          }}
        >
          Stop all {liveSessions.length > 0 ? `(${liveSessions.length})` : ''}
        </button>
      </section>
    </aside>
  )
}
