import { useEffect, useState } from 'react'
import { getPreviewLive, onPreviewChange, type Span } from '../preview'
import type { AgentTurn } from '../state'
import { useChatPane } from './AgentChat'

/**
 * A Claude card's terminal: its conversation in terminal type, filling the card and scrolling on its
 * own, with the CLI's live bottom lines beneath it.
 *
 * Claude Code repaints one screen in place and keeps no history in the terminal, so the card used to
 * show as many rows as the dock pane was tall and could only scroll by sending the wheel to the CLI,
 * which scrolled the owner's pane with it. He asked for the card and the pane to scroll separately:
 * "i want to be able to scroll from card or from open panen terminal". So the conversation comes from
 * the transcript, as the conversation view's does, and pages back to the start; the wheel scrolls it
 * natively and is never sent to the CLI. Only the prompt box, the working line and the status line
 * are taken from the screen, because those say what is happening now. Canon 02 revision 13.
 */
export function ClaudeTerminal({
  sessionId,
  transcriptPath,
  status,
  live,
}: {
  sessionId: string
  transcriptPath: string | null
  status: string
  /** True when a process is behind the card. A stopped card's saved screen is not "now". */
  live: boolean
}) {
  const { chat, ref, onScroll, paging, loadingOlder, keys } = useChatPane(sessionId, status, transcriptPath, live)
  const [, bump] = useState(0)
  useEffect(() => (live ? onPreviewChange(sessionId, () => bump((n) => n + 1)) : undefined), [sessionId, live])
  const tail = live ? getPreviewLive(sessionId).rows : []

  // The live lines are part of the same pane, so the wheel over them scrolls the conversation too.
  const onTailWheel = (e: React.WheelEvent) => {
    const el = ref.current
    if (!el || e.ctrlKey) return
    el.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY
  }

  return (
    <div className="mini mini--claude nowheel">
      <div className="claude-log" ref={ref} onScroll={onScroll}>
        {chat && chat.length > 0 && paging?.atStart && <div className="claude-log__edge">Start of this conversation.</div>}
        {chat && chat.length > 0 && loadingOlder && !paging?.atStart && (
          <div className="claude-log__edge">Reading earlier turns.</div>
        )}
        {chat && chat.length > 0 ? (
          chat.map((turn, i) => <Turn key={keys[i]} turn={turn} />)
        ) : (
          <div className="claude-log__edge">
            {chat === undefined
              ? 'Reading this card’s transcript.'
              : transcriptPath
                ? 'Nothing in its transcript yet.'
                : 'No transcript yet. The CLI names one when it starts writing.'}
          </div>
        )}
      </div>
      {tail.length > 0 && (
        <div className="claude-live" onWheel={onTailWheel}>
          {tail.map((spans, i) => (
            <div key={i} className="mini-row">
              {spans.length === 0 ? ' ' : spans.map((s, j) => <SpanView key={j} s={s} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SpanView({ s }: { s: Span }) {
  return <span style={{ color: s.fg, background: s.bg, fontWeight: s.bold ? 600 : undefined }}>{s.text}</span>
}

/**
 * One turn in the CLI's own marks: `>` for what was asked, a white dot for what was said, and a green
 * dot with `Tool(what)` for what was done, which is how the terminal itself shows them.
 */
function Turn({ turn }: { turn: AgentTurn }) {
  if (turn.role === 'asked') {
    return (
      <div className="claude-turn claude-turn--asked" title={turn.full}>
        <span className="claude-turn__mark">&gt;</span>
        <span className="claude-turn__text">{turn.text}</span>
      </div>
    )
  }
  if (turn.role === 'said') {
    return (
      <div className="claude-turn" title={turn.full}>
        <span className="claude-turn__mark">●</span>
        <span className="claude-turn__text">{turn.text}</span>
      </div>
    )
  }
  const cut = turn.text.indexOf(': ')
  const name = cut > 0 && /^[\w.:-]+$/.test(turn.text.slice(0, cut)) ? turn.text.slice(0, cut) : null
  return (
    <div className="claude-turn claude-turn--did" title={turn.full}>
      <span className="claude-turn__mark">●</span>
      <span className="claude-turn__text">
        {name ? (
          <>
            <b>{name}</b>({turn.text.slice(cut + 2)})
          </>
        ) : (
          <b>{turn.text}</b>
        )}
      </span>
    </div>
  )
}
