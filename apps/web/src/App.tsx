import { useEffect, useSyncExternalStore } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { drawnOnBoard, runningOnBoard } from '@garden/shared'
import { adoptKeyFromUrl, conn } from './connection'
import { actions, useApp } from './state'
import { getIdentity, onTasks } from './tasks'
import { Sidebar } from './components/Sidebar'
import { ProjectTabs } from './components/ProjectTabs'
import { AccountPrompt } from './components/AccountPrompt'
import { UndoBar } from './components/UndoBar'
import { Canvas } from './components/Canvas'
import { TerminalDock } from './components/TerminalDock'

export function App() {
  const connected = useApp((s) => s.connected)
  const lastError = useApp((s) => s.lastError)
  const focusedCount = useApp((s) => s.focused.length)
  /*
   * Cards on the board, and separately how many of them are running.
   *
   * This said "4 sessions" while the rail said "Nothing running in this project", and both were
   * true: four cards existed and none had a process. A blind reviewer read the two together and
   * could not tell whether anything was running, which is the one question a control room has to
   * answer at a glance. Counting cards and live processes separately says the same thing without
   * the contradiction. Closed cards are off the board, so they are not counted here either.
   *
   * Both figures come from the shared predicates rather than being spelled out here, because both
   * were wrong in the same way and separately. This counted every session row, so a board drawing
   * two cards said "6 cards" while the rail said "2 of 12" and the canvas showed two: three numbers
   * for one board, on screen at once. And "running" was a live pid here and a status in the server,
   * which disagree the moment a card is starting, and disagree permanently for a spawned agent,
   * which holds `working` with no process behind it. A reviewer reading only a screenshot found
   * both. One definition each, called from both sides, is the only thing that keeps them together.
   */
  /*
   * Which build the server half says it is, so the header can say when it is not this one.
   *
   * Garden is two processes. The owner restarted the app twice and asked, reasonably, whether he was
   * on the current code; nothing on screen could tell him, and he was not. The page has known its own
   * version since it was built, and that answers nothing on its own, because the half that gets left
   * behind is usually the server: the header can restart the backend without touching the page, and
   * a reload replaces the page without touching the server.
   */
  const serverBuild = useApp((s) => s.serverBuild)
  /*
   * The server's build when it is genuinely a different one, and null when it is not worth saying.
   *
   * A trailing '+' means the checkout had uncommitted changes when that half started, which is true
   * of the page for most of any working day, so a '+' on its own is not a split: read strictly, the
   * chip was lit permanently and said nothing. What survives is a real difference in version or in
   * commit, which is the state a restart fixes.
   */
  const splitBuild = (() => {
    if (!serverBuild) return null
    const DIRTY = '+'
    const bare = (c: string) => (c.endsWith(DIRTY) ? c.slice(0, -1) : c)
    const differs =
      serverBuild.version !== __GARDEN_VERSION__ || bare(serverBuild.commit) !== bare(__GARDEN_BUILD__)
    return differs ? serverBuild : null
  })()
  const cardCount = useApp((s) => s.sessions.filter(drawnOnBoard).length)
  const liveCount = useApp((s) => s.sessions.filter(runningOnBoard).length)
  /*
   * Who the server says this connection is.
   *
   * Safe as a snapshot: `identity` in `tasks.ts` is one module-level value replaced only when
   * `hello.ok` arrives, so between handshakes it is the same reference and React sees no change.
   */
  const identity = useSyncExternalStore(onTasks, getIdentity, getIdentity)

  useEffect(() => {
    /*
     * The key comes in the address the launcher opened, and is out of the address bar before the
     * socket is built. Order matters: the server decides who this connection is in `hello`, so a key
     * adopted after the handshake would not be the owner until something reconnected.
     */
    adoptKeyFromUrl()
    conn.connect()
  }, [])

  /*
   * One class on the root when the server has said this connection is a guest.
   *
   * What it does is in the stylesheet, under `.app--guest`, and it is deliberately a look and never
   * a disabling: every control still sends, and the server's refusal is still the answer.
   */
  return (
    <div
      className={`app ${identity?.kind === 'guest' ? 'app--guest' : ''}`}
      /*
       * What the server said this connection is, where a capture or a reviewer can read it without
       * guessing from what is dimmed. Nothing is styled off it and nothing branches on it; the class
       * above is what the stylesheet uses. "unanswered" is its own value because a handshake that
       * has not come back is not a guest.
       */
      data-identity={identity?.kind ?? 'unanswered'}
    >
      <header className="topbar">
        {/*
          The mark, the same file the browser tab uses, so the icon on the tab and the icon on the
          page cannot drift into being two different drawings.
        */}
        <img className="brand-mark" src="/garden.svg" alt="" width={20} height={20} />
        <span className="brand">Garden</span>
        {/*
          The version, substituted at build time from `apps/web/package.json`, and the commit beside
          it on hover. Every change the owner can see on screen moves the patch number, so this is
          the string he checks against what he was told after a restart.

          It describes the page and nothing else, which is why the chip after it exists. When the
          server answers with a different version or a different commit the two halves are on
          different code, and that is said out loud rather than left to be discovered.
        */}
        <span
          className="brand-version"
          title={`page v${__GARDEN_VERSION__} (${__GARDEN_BUILD__})${
            serverBuild ? `, server v${serverBuild.version} (${serverBuild.commit})` : ', server has not said yet'
          }`}
        >
          v{__GARDEN_VERSION__}
        </span>
        {splitBuild ? (
          <span
            className="brand-split"
            title={`The page is v${__GARDEN_VERSION__} (${__GARDEN_BUILD__}) and the server is v${splitBuild.version} (${splitBuild.commit}). Restart Garden to put both halves on the same code.`}
          >
            {/*
              A state, not a second version number.

              It carried the server's version at first, and the owner read that number as his own:
              a faint "v1.1.1" beside a bright amber "server v1.1.0" says he is on 1.1.1 and was
              read as 1.1.0, because the louder element wins the glance. Two numbers in a header
              also has to be decoded every time it is seen, and it is on screen precisely when
              something is already confusing. So the header carries one number, which is what he is
              running, and this says only that the other half does not match. Both versions and both
              commits are on the hover, where they are wanted once rather than read constantly.
            */}
            builds differ
          </span>
        ) : null}
        <span className="topbar-sub">terminal and agent control room</span>
        <UndoBar />
        <span className="spacer" />
        <span className="stat">
          {cardCount} card{cardCount === 1 ? '' : 's'}, {liveCount === 0 ? 'none running' : `${liveCount} running`}
        </span>
        {/*
          Restart the backend, from the one place a server-wide control belongs.

          It exists because a server change is not live until the backend restarts and there was no
          way to ask for that from the app. Closing a board is not it: that kills every process in
          the board and leaves the same server running, so it costs the sessions and changes nothing
          about the code. Reloading the page is not it either.

          Confirmed, and the confirmation counts the cards rather than warning in the abstract. This
          ends every running process on every board, which is the same weight as "Stop all" in the
          rail and gets the same treatment. What it adds over Stop all is that they come back.
        */}
        <button
          className="topbar-btn"
          disabled={!connected}
          title="Stops the backend and starts it again. Cards that were running come back on their own conversations."
          onClick={() => {
            const n = liveCount
            const ok = window.confirm(
              `Restart the Garden server?

${
                n === 0
                  ? 'Nothing is running, so nothing is interrupted.'
                  : `${n} running card${n === 1 ? '' : 's'} will be stopped and started again. Each resumes its own conversation, but whatever it is part-way through is lost.`
              }`,
            )
            if (ok) actions.restartServer()
          }}
        >
          Restart server
        </button>
        <span className={`conn ${connected ? 'is-up' : 'is-down'}`}>
          {connected ? 'server connected' : 'server offline'}
        </span>
      </header>

      <ProjectTabs />
      <AccountPrompt />

      {/*
        * A dead socket looks exactly like a quiet board, and that is the confusion worth removing.
        * Every card freezes at once, every terminal stops, and the only thing that said so was a
        * small grey chip in the corner of the top bar. This says it across the width of the screen,
        * and says what happens next, because the reconnect is automatic and the owner cannot tell
        * that from the outside.
        */}
      {!connected && (
        <div className="banner banner--offline">
          Not connected to the Garden server. Cards and terminals are frozen, not stopped. Retrying.
        </div>
      )}

      {/*
        One line, and nothing else changes.

        A guest may read the board and change nothing, and the temptation is to grey out every
        control to match. That is the wrong instinct and canon says why: the server refuses, and the
        refusal names the rule. A disabled button says only that this page decided something, which
        is not evidence and cannot be checked; a control that sends and comes back with a sentence
        is the board telling the truth about where the limit lives.

        Drawn only for `guest`. A connection that has not been answered yet is not a guest, and
        saying this during the half second a handshake takes would be the app asserting a state it
        has not been told.
      */}
      {identity?.kind === 'guest' ? (
        /*
          One banner, not two stacked and disagreeing.
          A guest who presses something gets the server's refusal, and that refusal was landing in
          a separate red bar below this one, in a different voice: two bars about the same fact,
          the second of which read as a fault. The refusal now sits under the line that explains
          it, in the same banner, as what happened rather than as an alarm.
        */
        <div className="banner banner--guest">
          <div>This tab is reading only. Open Garden from its launcher to act as the owner.</div>
          {lastError && <div className="banner__under">The server just said: {lastError}</div>}
        </div>
      ) : (
        lastError && <div className="banner banner--error">{lastError}</div>
      )}

      {/* Every boundary here is a drag handle, per the ultrawide layout requirement. */}
      <PanelGroup direction="horizontal" className="body" autoSaveId="garden-body">
        <Panel defaultSize={16} minSize={0} maxSize={40} className="pane">
          <Sidebar />
        </Panel>
        <PanelResizeHandle className="resize-h" />
        <Panel minSize={30} className="pane">
          <PanelGroup direction="vertical" autoSaveId="garden-center">
            <Panel minSize={20} className="pane">
              <Canvas />
            </Panel>
            {focusedCount > 0 && <PanelResizeHandle className="resize-v" />}
            {focusedCount > 0 && (
              <Panel defaultSize={42} minSize={10} className="pane">
                <TerminalDock />
              </Panel>
            )}
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  )
}
