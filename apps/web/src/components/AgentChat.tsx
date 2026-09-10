import { useEffect, useRef, useState } from 'react'
import { actions, getAgentChat, onAgentChat, type AgentTurn } from '../state'

/**
 * A session's conversation, read from the transcript the CLI writes rather than from terminal bytes.
 *
 * This lived inline in `SessionNode` and was reachable only on subagent cards, which meant the cards
 * the owner actually works with had no readable record of what was said at all: only a miniature of
 * a terminal, capped at 256 KB, reset by every restart, and drawn out of drawing instructions rather
 * than words. His ask was for a conversation that persists and appears everywhere, so it moved here
 * to be used by a card body and by a dock pane alike.
 *
 * Why it is durable in a way the terminal is not. The turns come from the CLI's own transcript file,
 * so they survive the process ending, the card being turned off and on, and the app restarting. A
 * card that has been quiet for a week still has its conversation.
 *
 * Three different silences are kept apart, and that is the point rather than a nicety. An answer
 * that has not arrived is not the same as a file with nothing in it, and neither is the same as a
 * card the CLI never named a transcript for. Drawing all three as one blank pane is how a card ends
 * up implying a run did nothing.
 */
export function AgentChat({
  sessionId,
  transcriptPath,
  status,
  exitedAt,
  formatWhen,
  className = 'agent-summary nowheel nodrag',
}: {
  sessionId: string
  transcriptPath: string | null
  /** Not read directly. It is here so a new turn is fetched at the moment one is likely to exist. */
  status: string
  exitedAt: number | null
  formatWhen: (at: number) => string
  className?: string
}) {
  const [chat, setChat] = useState<AgentTurn[] | undefined>(() => getAgentChat(sessionId))

  useEffect(() => {
    const stop = onAgentChat((id) => {
      if (id === sessionId) setChat(getAgentChat(sessionId))
    })
    actions.readAgentChat(sessionId)
    return stop
  }, [sessionId, status, transcriptPath])

  // Pinned to the newest turn, the same end a terminal miniature shows. A conversation that opened
  // at the top would put a finished run's first line on screen and hide what it concluded.
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  return (
    <div className={className} ref={ref} style={{ overflowY: 'auto', minHeight: 0 }}>
      {chat && chat.length > 0 ? (
        chat.map((turn, i) => (
          <div
            className="agent-summary__row"
            key={`${turn.at ?? 0}-${i}`}
            // Only when there is more to see. A row whose text is already whole gets no tooltip,
            // so hovering one is a reliable sign that something was shortened rather than a habit.
            title={turn.full}
          >
            <span className="agent-summary__label">
              {turn.role === 'asked' ? 'Asked' : turn.role === 'said' ? 'Said' : 'Did'}
            </span>
            <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{turn.text}</span>
          </div>
        ))
      ) : (
        <div className="agent-summary__row agent-summary__row--muted" style={{ display: 'block', lineHeight: 1.45 }}>
          {chat === undefined
            ? 'Reading this card’s transcript.'
            : transcriptPath
              ? 'Nothing readable in its transcript yet. A card that has just started has not written a turn, so this is empty rather than the run being empty.'
              : 'No transcript path yet. The CLI names one when it starts writing this file, and Garden shows nothing here until it does.'}
        </div>
      )}
      {exitedAt != null && (
        <div className="agent-summary__row" style={{ marginTop: 'auto' }}>
          <span className="agent-summary__label">Finished</span>
          <span>{formatWhen(exitedAt)}</span>
        </div>
      )}
    </div>
  )
}
