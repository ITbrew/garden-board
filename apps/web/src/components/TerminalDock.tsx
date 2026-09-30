import { Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { cardIsOff, type TerminalSession } from '@garden/shared'
import { actions, useApp } from '../state'
import { Terminal } from './Terminal'
import { AgentChat } from './AgentChat'

/**
 * Whether this pane is showing the conversation. The stored choice wins; the default is the card's
 * kind, exactly as on the board, so a card and its pane never disagree about what they are showing.
 */
const chatFor = (s: TerminalSession) => (s.bodyView ? s.bodyView === 'chat' : s.kind !== 'session')

/**
 * Only a card that can actually have a transcript gets the choice. A shell has none and never will,
 * so the switch would be a control with one working position. Matches `canConverse` in SessionNode.
 */
const canConverse = (s: TerminalSession) => s.kind !== 'session' || s.adapterId === 'claude'

/** A short clock time, for the "finished at" line the conversation ends on. */
const formatWhen = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * Where you actually type. Terminals live here at 1:1, outside the canvas transform, which is
 * what keeps text sharp and mouse selection landing on the right character. Splits 1 to 4 ways
 * so several agents can be driven side by side.
 */
export function TerminalDock() {
  const focused = useApp((s) => s.focused)
  const sessions = useApp((s) => s.sessions)

  const open = focused
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s)

  if (open.length === 0) return null

  return (
    <div className="dock">
      <PanelGroup direction="horizontal" autoSaveId="garden-dock">
        {open.map((s, i) => {
          /*
           * The same question the card asks, asked through the same function.
           *
           * This used to be its own test against the status field, and the two had drifted: a card
           * counts a null pid as off and this did not, so a card created but not yet up offered a
           * live cursor over a process that was not there. A pane and a card disagreeing about
           * whether a session is on is the kind of thing nobody reports as a bug, because it looks
           * like typing simply not working.
           */
          const off = s.kind === 'session' && cardIsOff(s)
          return (
            <Fragment key={s.id}>
              {i > 0 && <PanelResizeHandle className="resize-h" />}
              {/*
                * No `id`/`order` here, and that is a measured decision rather than an omission.
                *
                * It was added on the theory that react-resizable-panels re-lays out the whole group
                * when a child appears, so opening a second terminal would resize the first one's
                * process for nothing. Counted at the socket, opening a second pane sends the
                * already-open pane exactly one resize with and without them, because two panes really
                * do share the width and the first pane really is half as wide afterwards. Telling its
                * process that is correct, not waste.
                */}
              <Panel minSize={12} className="dock-pane">
                <header className="dock-head">
                  <span className={`dot dot--${s.status}`} />
                  <span className="dock-title">{s.title}</span>
                  <span className="dock-cwd" title={s.cwd}>
                    {s.cwd}
                  </span>
                  {/*
                    Said in words, because a terminal with stdin disabled looks exactly like a
                    terminal that is working. The last screen the process drew is still on it, the
                    cursor is still where it stopped, and the only difference is that keystrokes go
                    nowhere. That is indistinguishable from a fault unless something says otherwise.
                  */}
                  {off && (
                    <span className="dock-off" title="This card's process has ended. Turn it on to type into it.">
                      off
                    </span>
                  )}
                  {/*
                    Turn on, in the pane rather than only on the card.

                    The dock is where somebody is standing when they find out a card is off: they
                    opened its terminal to wake it. Until this existed the pane answered with a frozen
                    picture, a cursor that took no keystrokes, and a Turn off button for a process that
                    had already ended, and the owner read all of that as the input field being gone.
                  */}
                  {off ? (
                    <button
                      className="btn btn--ghost"
                      title="Start this card's CLI again. It resumes the conversation it was having."
                      onClick={() => actions.startSession(s.id)}
                    >
                      Turn on
                    </button>
                  ) : (
                    <button
                      className="btn btn--ghost"
                      title="End this session's process. The card stays on the board."
                      onClick={() => actions.stopSession(s.id)}
                    >
                      Turn off
                    </button>
                  )}
                  {/*
                    The same choice the card offers, here at full size.
                    The conversation is read from the CLI's own transcript, so it is the one view that
                    still says something for a card whose process has ended and whose terminal is a
                    frozen picture of the moment it stopped.
                  */}
                  {canConverse(s) && (
                    <button
                      className="btn btn--ghost"
                      title={
                        chatFor(s)
                          ? 'Show the terminal in this pane'
                          : 'Show the conversation in this pane, read from this card’s transcript'
                      }
                      onClick={() => actions.setBodyView(s.id, chatFor(s) ? 'terminal' : 'chat')}
                    >
                      {chatFor(s) ? 'Terminal' : 'Conversation'}
                    </button>
                  )}
                  <button
                    className="btn btn--ghost"
                    title="Close this pane. The session keeps running."
                    onClick={() => actions.unfocus(s.id)}
                  >
                    Close pane
                  </button>
                </header>
                {/*
                  The terminal is mounted only when it is being shown, and that is deliberate.
                  Instances are pooled and capped at eight, so a pane parked on the conversation should
                  not be holding one of the eight; and the pool now refuses to evict anything mounted,
                  which would otherwise make a chat pane a permanent reservation for a terminal nobody
                  is looking at.
                */}
                {chatFor(s) ? (
                  <AgentChat
                    sessionId={s.id}
                    transcriptPath={s.transcriptPath}
                    status={s.status}
                    exitedAt={s.exitedAt}
                    formatWhen={formatWhen}
                    className="agent-summary agent-summary--dock"
                  />
                ) : (
                  <div className={off ? 'dock-body dock-body--off' : 'dock-body'}>
                    <Terminal sessionId={s.id} live={!off} />
                    {/*
                      Across the input row, because that is where somebody is looking when they
                      find out. The header chip alone was missed: "if i swap tabs and try to type to
                      .5 ADv i cant type at all". Over the terminal rather than instead of it, so the
                      last screen stays readable above it. Canon 03 revision 12.
                    */}
                    {off && (
                      <div className="dock-offbar" role="status">
                        <span>
                          {s.title} is off
                          {s.exitedAt ? ` since ${formatWhen(s.exitedAt)}` : ''}, so typing here goes nowhere.
                        </span>
                        <button className="btn" onClick={() => actions.startSession(s.id)}>
                          Turn on
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </Fragment>
          )
        })}
      </PanelGroup>
    </div>
  )
}
