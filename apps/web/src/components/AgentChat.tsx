import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { onPreviewChange } from '../preview'
import { actions, getAgentChat, getChatPaging, onAgentChat, type AgentTurn } from '../state'

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
 * **It scrolls back to the first thing that was said**, since 2026-09-29: "the cards should also be
 * scrollable the same way terminals are. currently it only lets me scroll to the size of the window
 * instead of the conversatioln". Nearing the top asks for the page above, from the offset the last
 * page began at, so reaching the start of a 735MB transcript costs a page at a time rather than the
 * file. Canon 02 revision 10.
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
  const { chat, ref, onScroll, paging, loadingOlder, keys } = useChatPane(sessionId, status, transcriptPath)

  return (
    <div
      className={className}
      ref={ref}
      onScroll={onScroll}
      style={{ overflowY: 'auto', minHeight: 0, overflowAnchor: 'none' }}
    >
      {/*
        What is above the first row, said rather than left blank. Nothing is drawn while more simply
        exists to be fetched, because nearing the top fetches it and a hint would sit there briefly
        on every scroll.
      */}
      {chat && chat.length > 0 && paging?.atStart && (
        <div className="agent-summary__row agent-summary__row--muted agent-summary__edge">Start of this conversation.</div>
      )}
      {chat && chat.length > 0 && loadingOlder && !paging?.atStart && (
        <div className="agent-summary__row agent-summary__row--muted agent-summary__edge">Reading earlier turns.</div>
      )}
      {chat && chat.length > 0 ? (
        chat.map((turn, i) => (
          <div
            className="agent-summary__row"
            key={keys[i]}
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

/**
 * A card's conversation as a scrolling pane that pages back to the start: the turns, the element to
 * scroll, and the scroll handler that asks for the page above. Shared by the conversation view and by
 * a Claude card's terminal (see `ClaudeTerminal`), so the two can never page differently.
 */
export function useChatPane(sessionId: string, status: string, transcriptPath: string | null, live = false) {
  const [chat, setChat] = useState<AgentTurn[] | undefined>(() => getAgentChat(sessionId))

  useEffect(() => {
    const stop = onAgentChat((id) => {
      if (id === sessionId) setChat(getAgentChat(sessionId))
    })
    actions.readAgentChat(sessionId)
    return stop
  }, [sessionId, status, transcriptPath])

  /*
   * While a process is behind the card, read again whenever its terminal changes, at most about once
   * a second and once more after it goes quiet. A status change alone was not enough: the card goes to
   * working the moment the owner presses Enter, before the CLI has written his message, so the one
   * read it caused found nothing new and the message only appeared when the turn ended or he opened
   * the terminal. "typing into cards doesnt show my message until after i open terminal".
   */
  useEffect(() => {
    if (!live) return
    let last = 0
    let trailing: ReturnType<typeof setTimeout> | null = null
    const read = () => {
      last = Date.now()
      actions.readAgentChat(sessionId)
    }
    const off = onPreviewChange(sessionId, () => {
      if (trailing) clearTimeout(trailing)
      trailing = setTimeout(read, 1200)
      if (Date.now() - last > 1000) read()
    })
    return () => {
      off()
      if (trailing) clearTimeout(trailing)
    }
  }, [sessionId, live])

  const ref = useRef<HTMLDivElement | null>(null)
  /**
   * Whether the owner is at the newest turn, and so whether a new one should carry him with it.
   *
   * This used to pin the pane to the bottom on EVERY change, unconditionally. With only the last
   * sixty turns that was harmless, and with paging it is the other half of the snap-back: however
   * correctly the pages merged, the first thing the agent said afterwards yanked him from wherever
   * he had scrolled to back down to the end. It follows the live end only when he is already there.
   */
  const following = useRef(true)
  const lastHeight = useRef(0)
  const lastFirst = useRef<number | undefined>(undefined)

  /*
   * Before paint, so there is no frame where the text has jumped and then jumps back.
   *
   * Older turns arriving above push everything down by exactly the height they added, so the scroll
   * position moves down by that height and the row he was reading stays where it was on screen. The
   * browser's own scroll anchoring is switched off on the pane below, since it would try to make the
   * same correction and the two together would move it twice.
   */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = chat?.[0]?.off
    const addedAbove = lastFirst.current !== undefined && first !== undefined && first < lastFirst.current
    if (addedAbove) el.scrollTop += el.scrollHeight - lastHeight.current
    else if (following.current) el.scrollTop = el.scrollHeight
    lastHeight.current = el.scrollHeight
    lastFirst.current = first
    /*
     * A page that does not fill the pane gives him nothing to scroll, so no scroll ever asks for the
     * page above and the card would look like it had shown everything. Keep asking until it fills or
     * the start is reached; the action itself refuses at the start and while a request is out.
     */
    if (chat && chat.length > 0 && el.scrollHeight <= el.clientHeight + 4) {
      actions.readOlderAgentChat(sessionId)
    }
  }, [chat, sessionId])

  /*
   * The pane can change height without a turn arriving: a card resized, or the live lines under a
   * Claude card's conversation growing. At the live end it stays at the live end.
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    // Before the very top rather than at it, so the next page is usually there by the time he is.
    if (el.scrollTop < 120) actions.readOlderAgentChat(sessionId)
  }

  const paging = getChatPaging(sessionId)
  const loadingOlder = !!paging && paging.loading > 0 && Date.now() - paging.loading < 10_000

  /*
   * Keys that survive older turns being added above. An index key renumbers every row each time a
   * page arrives, which remounts them all. The line's own offset plus its place within that line is
   * the same wherever the row ends up.
   */
  const keys: string[] = []
  if (chat) {
    let prev: number | undefined
    let n = 0
    for (const turn of chat) {
      n = turn.off !== undefined && turn.off === prev ? n + 1 : 0
      prev = turn.off
      keys.push(turn.off !== undefined ? `${turn.off}.${n}` : `${turn.at ?? 0}-${keys.length}`)
    }
  }

  return { chat, ref, onScroll, paging, loadingOlder, keys }
}
