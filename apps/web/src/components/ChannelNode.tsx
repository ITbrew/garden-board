import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import type { Channel, TerminalSession } from '@garden/shared'
import { actions, getChannelMtime, getChannelSaveState, getChannelText, onChannelChange } from '../state'

/**
 * One place the owner and one card talk, and nothing else on it.
 *
 * The problem it exists for, in his words: "currently orchestrator gets tied up in a lot of things
 * and its hard for me to found our back and forth". A card's terminal carries every tool call, every
 * file it read and every message off every wire, and the two sentences he actually exchanged with it
 * are somewhere in the middle. So this shows those two sentences and refuses everything else.
 *
 * It is a view of a file, not a transport. `NOTES.md` in the bound card's own mail directory is the
 * only copy of the conversation: he appends by pressing Send, the card appends with the file writing
 * tools it already has, and this redraws when the bytes on disk change. Nothing is held here that is
 * not there, which is what makes the card and the board incapable of disagreeing about what was said.
 */

/**
 * One entry in the file, as it is drawn.
 *
 * The file is markdown with `## Who, when` headings, which is a format both sides can append to with
 * no parser and no lock: two processes appending to the end of a text file is the whole protocol.
 * Anything before the first heading is shown as a preamble rather than dropped, because the seeded
 * header explains what the file is and a card reading it should not be the only one who sees that.
 */
interface Entry {
  who: string
  when: string
  body: string
  mine: boolean
  /**
   * Character offset of this entry's `##` heading in the RAW text.
   *
   * Carried so that a click on a DRAWN entry can put the caret on the SAME entry once the card
   * flips to the editor. The drawn conversation and the file are two different shapes, and without
   * an offset travelling with the entry there is no way back from one to the other.
   */
  start: number
}

function parse(text: string): { preamble: string; entries: Entry[] } {
  const lines = text.split('\n')
  const entries: Entry[] = []
  let preamble: string[] = []
  let current: Entry | null = null

  let offset = 0
  for (const line of lines) {
    const lineStart = offset
    // +1 for the newline split() removed. The final line over-counts by one and nothing reads it.
    offset += line.length + 1
    const head = /^##\s+(.+?)(?:,\s*(.+))?\s*$/.exec(line)
    if (head) {
      if (current) entries.push({ ...current, body: current.body.trim() })
      const who = (head[1] ?? '').trim()
      current = {
        who,
        when: (head[2] ?? '').trim(),
        body: '',
        mine: /^owner$/i.test(who),
        start: lineStart,
      }
      continue
    }
    if (current) current.body += `${line}\n`
    else preamble.push(line)
  }
  if (current) entries.push({ ...current, body: current.body.trim() })
  /*
   * The file's own heading marks come off the preamble before it is drawn.
   *
   * It is the first line of a markdown file being shown in something that is not a markdown viewer,
   * so a literal `#` sits there looking like syntax that failed to render. A reviewer who had only
   * the picture could not tell whether the whole pane was a rendered file or a chat window, and the
   * stray hash is what made that ambiguous.
   */
  const head = preamble
    .join('\n')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
  return { preamble: head, entries: entries.filter((e) => e.body || e.who) }
}

export type ChannelNodeData = {
  channel: Channel
  session: TerminalSession | null
  selected?: boolean
}

export const ChannelNode = memo(function ChannelNode({ data, selected }: NodeProps) {
  const { channel, session } = data as ChannelNodeData
  const [text, setText] = useState(() => getChannelText(channel.id))
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  /**
   * The whole file, held here while he is editing it, or null when he is not.
   *
   * Null rather than a separate boolean, so there is one thing to look at rather than two that can
   * disagree. While it is a string the card is showing his copy; while it is null the card is
   * showing the file. Nothing merges the two: a card that answered mid-edit is a refusal from the
   * server, not a guess made here.
   */
  const [editing, setEditing] = useState<string | null>(null)
  /**
   * The textarea, and the offset the caret should take when it appears.
   *
   * `autoFocus` alone puts the caret at index 0 and leaves the box scrolled to the top, so clicking
   * a reply from this morning to fix a typo threw him to the top of the file and he scrolled back
   * down by hand. His words: "when i click into our conversation to edit the file, it moves the
   * cursor to the top of the file instead of where i was pointed."
   *
   * Null means the end of the file, which is the right default for an append-only log: a click on
   * empty space below the last entry is a click meaning "write a new one".
   */
  const editBox = useRef<HTMLTextAreaElement | null>(null)
  const caretAt = useRef<number | null>(null)
  /**
   * What the file's timestamp was when the editor opened, held for as long as it is open.
   *
   * Captured here rather than read when Save is pressed, and that distinction is the whole of the
   * stale-write check. By the time he presses Save the card may have appended its reply, which
   * refreshes the timestamp the board holds, so a check made then compares the newest write against
   * itself and always passes. Measured before this ref existed: the reply was erased and the card
   * drew "saved" over it.
   */
  const editingSince = useRef(0)
  /**
   * The bytes his edit is derived from, which is not the same as the bytes on disk.
   *
   * Kept because the card at the other end writes into this file too, and the difference between
   * what he started from and what is there now is the only way to tell an append from a rewrite.
   */
  const baseText = useRef('')
  const [saveState, setSaveState] = useState(() => getChannelSaveState(channel.id))
  const [conflict, setConflict] = useState<string | null>(null)

  /**
   * How long after the last keystroke the file is written.
   *
   * Long enough that a sentence is one write rather than forty, short enough that closing the
   * laptop mid-thought does not lose the thought. Every write is a whole-file write, so this is
   * also what bounds how much the card at the other end can append behind him before he is told.
   */
  const SAVE_AFTER_MS = 700
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)

  /**
   * What the file should say once the write Garden is doing right now has landed.
   *
   * The server writes, then pushes the file, then answers, so the echo of his own save arrives back
   * here before the confirmation does. Without this the merge below sees bytes that do not begin
   * with the ones he started from, every single time he deletes anything, and calls his own save a
   * rewrite by somebody else.
   */
  const expected = useRef<string | null>(null)

  const writeNow = (value: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pending.current = null
    expected.current = value
    actions.saveChannel(channel.id, value, editingSince.current)
  }
  const scheduleSave = (value: string) => {
    pending.current = value
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => writeNow(value), SAVE_AFTER_MS)
  }
  /** Write whatever is waiting, right now. Used when the editor closes or loses focus. */
  const flushSave = () => {
    if (pending.current !== null) writeNow(pending.current)
  }
  // A pending write must not outlive the card that owns it.
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  useEffect(
    () =>
      onChannelChange(channel.id, () => {
        const disk = getChannelText(channel.id)
        setText(disk)
        setSaveState(getChannelSaveState(channel.id))

        /*
         * Fold in what the card added, rather than refusing or overwriting it.
         *
         * With a save button this was a refusal: the file moved underneath, so the write was turned
         * away and he was told why. Auto-saving makes that answer useless, because it would fire
         * every time he paused typing. It also makes the merge easy and honest, and the reason is
         * that the card at the other end only ever APPENDS. So if what is on disk begins with the
         * bytes his edit was derived from, everything past that point is new, and adding it to the
         * end of his copy keeps both his edits and the card's reply with nothing inferred.
         *
         * When it does NOT begin with those bytes, something rewrote the middle and there is no
         * honest merge. That says so and stops saving rather than picking a winner, which is the
         * same rule the rest of this app follows about anything it cannot prove.
         */
        setEditing((mine) => {
          if (mine === null) {
            baseText.current = disk
            editingSince.current = getChannelMtime(channel.id)
            return null
          }
          // His own write coming back. Not a change by anyone else, so it only moves the baseline.
          if (disk === expected.current) {
            expected.current = null
            baseText.current = disk
            editingSince.current = getChannelMtime(channel.id)
            return mine
          }
          if (disk === baseText.current) return mine
          if (disk.startsWith(baseText.current)) {
            const added = disk.slice(baseText.current.length)
            baseText.current = disk
            editingSince.current = getChannelMtime(channel.id)
            setConflict(null)
            return mine + added
          }
          setConflict('This file was rewritten while you were editing, so your copy is no longer being saved.')
          return mine
        })
      }),
    [channel.id],
  )
  useEffect(() => {
    actions.readChannel(channel.id)
  }, [channel.id])

  const { preamble, entries } = useMemo(() => parse(text), [text])

  /*
   * Follow the bottom, because the newest exchange is the one being had.
   *
   * Only when the view is already near the bottom: yanking the scroll down while he is reading back
   * through what was said is the behaviour every chat window gets wrong, and this one holds a
   * conversation short enough that scrolling back is a normal thing to be doing.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (near) el.scrollTop = el.scrollHeight
  }, [text])

  const bound = !!channel.sessionId
  const title = session?.title ?? 'not wired to a card yet'

  const send = () => {
    const body = draft.trim()
    if (!body || !bound) return
    actions.sendChannel(channel.id, body)
    setDraft('')
    setNote(null)
  }

  return (
    <>
    <div
      className={`channel ${selected ? 'is-selected' : ''} ${bound ? '' : 'is-unbound'}`}
      style={{ width: channel.width, height: channel.height, fontSize: channel.fontSize ?? undefined }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={280}
        minHeight={220}
        onResizeEnd={(_, p) => actions.setChannelBox(channel.id, p.width, p.height)}
      />

      <div className="channel-head">
        <span className="channel-title">{bound ? `You and ${title}` : 'Message card'}</span>
        <button
          className="channel-x nodrag"
          title="Take this card off the board. The conversation stays in the file."
          onClick={(e) => {
            e.stopPropagation()
            actions.deleteChannel(channel.id)
          }}
        >
          ×
        </button>
      </div>

      {!bound && (
        /*
         * An unwired card says what to do with it rather than looking broken.
         *
         * This is a real and expected state, not an error: he draws the card, then draws the wire.
         * A blank box with a dead input in it would read as the feature not working.
         */
        <p className="channel-empty">
          Draw a wire between this card and a session card. That binds the two, and everything either
          of you says lands in that card's own <code>NOTES.md</code>.
        </p>
      )}

      {editing === null ? (
        /*
         * Click into it to edit the file itself.
         *
         * A click rather than a button, at his word: "i can click into the window to edit the file
         * right on the card". Guarded on the selection being collapsed, so dragging across a line to
         * copy it does not throw him into an editor when he wanted the text. That guard is the whole
         * reason this is not simply an onClick.
         */
        <div
          className="channel-log nowheel nodrag"
          ref={scroller}
          title={bound ? 'Click to edit this file' : undefined}
          onClick={(ev) => {
            if (!bound) return
            if (!window.getSelection()?.isCollapsed) return
            /*
             * Which entry was under the pointer, read from the DOM rather than from a per-entry
             * handler.
             *
             * One handler on the container cannot race a second one on the child, and a click that
             * lands on the padding between two entries resolves to no entry instead of to whichever
             * handler happened to fire. `closest` walks up from whatever was actually hit, so the
             * name, the timestamp and the body all answer the same.
             */
            const hit = (ev.target as HTMLElement | null)?.closest?.('[data-start]')
            const at = hit?.getAttribute('data-start')
            caretAt.current = at == null ? null : Number(at)
            editingSince.current = getChannelMtime(channel.id)
            baseText.current = text
            expected.current = null
            setConflict(null)
            setEditing(text)
          }}
        >
          {bound && preamble && <p className="channel-preamble">{preamble}</p>}
          {bound && entries.length === 0 && (
            <p className="channel-empty">Nothing said yet. What you write here is all this card sees.</p>
          )}
          {entries.map((e, i) => (
            <div key={i} data-start={e.start} className={`channel-turn ${e.mine ? 'is-mine' : 'is-theirs'}`}>
              <span className="channel-who">
                {e.mine ? 'You' : e.who}
                {e.when && <span className="channel-when"> {e.when}</span>}
              </span>
              <div className="channel-body">{e.body}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="channel-edit nowheel nodrag">
          {/*
            The raw file, not the rendered conversation.

            Editing what is drawn would mean writing back something reconstructed from it, and the
            headings that say who spoke are part of the file rather than decoration. So this is the
            bytes, and what he saves is exactly what he sees.
          */}
          <textarea
            className="channel-edit__text"
            value={editing}
            autoFocus
            spellCheck={false}
            /*
             * Placing the caret needs the element, so it happens in the ref callback rather than in
             * an effect: the effect would run a frame later and he would see the box jump.
             *
             * Scrolling to it is done by measuring rather than by multiplying a line count by a line
             * height, because these lines WRAP and a wrapped line is two rows on screen and one in
             * the string. Briefly assigning the text up to the caret and reading `scrollHeight` asks
             * the browser the question instead of estimating it, and the real value is put back in
             * the same synchronous block, so React's value is never observed to differ.
             */
            ref={(el) => {
              editBox.current = el
              if (!el || el.dataset.placed === '1') return
              el.dataset.placed = '1'
              const pos = caretAt.current ?? el.value.length
              const full = el.value
              el.value = full.slice(0, pos)
              const above = el.scrollHeight
              el.value = full
              el.setSelectionRange(pos, pos)
              // A third of the way down reads as "here", where the very top reads as "somewhere".
              el.scrollTop = Math.max(0, above - el.clientHeight / 3)
            }}
            onChange={(ev) => {
              setEditing(ev.target.value)
              scheduleSave(ev.target.value)
            }}
            onBlur={() => flushSave()}
            /*
              Keys stop here, the same way the session card's input line stops them.

              The canvas listens for keys of its own, and a card that lets typing through is a card
              where a keystroke can mean two things at once. That comment on the session card was
              written after a Tab both cycled a permission mode and moved the focus away, in one
              press. Nothing is known to be broken here today; this is the same discipline rather
              than a fix.
            */
            onKeyDown={(ev) => {
              ev.stopPropagation()
              if (ev.key === 'Escape') {
                ev.preventDefault()
                flushSave()
                setEditing(null)
              }
            }}
          />
          {/*
            No save button, at his word: "remove save button after that is done, autosave is good
            for that card". What is left says what the card is doing rather than asking him to do
            it, and closing is the only action, because there is nothing to confirm.
          */}
          <div className="channel-edit__foot">
            <span className="channel-hint">saves as you type · esc closes</span>
            <button
              className="channel-send channel-send--ghost"
              type="button"
              onClick={() => {
                flushSave()
                setEditing(null)
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/*
        What became of the last save, in the three states it actually has.

        `saving` is not a success and is not drawn as one: the bytes have gone and nothing has come
        back yet. Only the server saying so turns it into `saved`, and the one failure worth having
        is the card having written its reply while he was typing, which is refused rather than
        overwritten and says so here.
      */}
      {saveState?.status === 'pending' && <p className="channel-note">saving…</p>}
      {saveState?.status === 'ok' && (
        <p className="channel-note">saved {new Date(saveState.at).toLocaleTimeString('en-GB', { hour12: false })}</p>
      )}
      {saveState?.status === 'error' && <p className="channel-note channel-note--bad">{saveState.error}</p>}
      {conflict && <p className="channel-note channel-note--bad">{conflict}</p>}

      {note && <p className="channel-note">{note}</p>}

      <form
        className="channel-form nodrag"
        onSubmit={(ev) => {
          ev.preventDefault()
          send()
        }}
      >
        <textarea
          className="channel-input"
          value={draft}
          disabled={!bound}
          placeholder={bound ? `write to ${title}` : 'wire this to a card first'}
          onChange={(ev) => setDraft(ev.target.value)}
          /*
           * Enter sends, shift and enter makes a paragraph.
           *
           * The same call the card's own input line already makes, and made for the same complaint:
           * "terminals are typically 1, so i press enter waiting for response but its sitting in
           * input field". A message box that needs a button press to send is the same surprise.
           */
          onKeyDown={(ev) => {
            ev.stopPropagation()
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault()
              send()
            }
          }}
        />
        <button className="channel-send" type="submit" disabled={!bound || !draft.trim()}>
          Send
        </button>
      </form>
    </div>

    {/*
      The connection dots live outside the card, not inside it, and this is the second time that
      lesson has been learned on this board.

      A dot sits half past the card's edge so a wire visibly lands ON something rather than touching
      a bare border. The card clips its own overflow to keep the conversation inside its rounded
      corners, and a clipped dot is not merely half drawn: it is not there to click. Measured with
      `document.elementFromPoint` at the dot's own centre, which returned the canvas behind it on
      this card and the handle itself on a session card. Rendering the ports as siblings rather than
      children is what the session cards already do, and the comment there says why.

      Both sides, and each side carries both directions, because the card it belongs to can sit
      either side of it. The same `node-pin` the rest of the board uses, so a connection point looks
      like a connection point everywhere rather than being a thing to learn twice.
    */}
    <div className="port port--left">
      <Handle id="in" type="target" position={Position.Left} className="node-pin" />
      <Handle id="outLeft" type="source" position={Position.Left} className="node-pin node-pin--stacked" />
      <span className="port-label port-label--left">{bound ? 'Wired' : 'Wire to a card'}</span>
    </div>
    <div className="port port--right">
      <Handle id="out" type="source" position={Position.Right} className="node-pin" />
      <Handle id="inRight" type="target" position={Position.Right} className="node-pin node-pin--stacked" />
      <span className="port-label port-label--right">{bound ? 'Wired' : 'Wire to a card'}</span>
    </div>
    </>
  )
})
