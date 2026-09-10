import { Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { TerminalSession } from '@garden/shared'
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
        {open.map((s, i) => (
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
                <button
                  className="btn btn--ghost"
                  title="End this session's process. The card stays on the board."
                  onClick={() => actions.stopSession(s.id)}
                >
                  Turn off
                </button>
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
                <Terminal
                  sessionId={s.id}
                  live={s.status !== 'stopped' && s.status !== 'failed' && s.status !== 'done'}
                />
              )}
            </Panel>
          </Fragment>
        ))}
      </PanelGroup>
    </div>
  )
}
