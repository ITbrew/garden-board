import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { DocCard, Project } from '@garden/shared'
import { actions, getDocContent, getDocSaveState, onDocChange } from '../state'
import { DEFAULT_PORT } from '@garden/shared'

/*
 * A file card no longer names its own category.
 *
 * The web already lays these out in labelled columns, so a card sitting in the Instructions
 * column printing the word "Instructions" spends header space to repeat what the column above it
 * has already said, and pushes the one thing that identifies the card, its file name, into an
 * ellipsis. The card shows what it is (a document or an image) and what it is called, and the
 * column says which group it belongs to.
 */

/**
 * How long an unanswered write goes on saying "saving" before it says "no answer".
 *
 * This timer changes a word and nothing else. It cannot make a save succeed or fail, because both
 * of those only ever come from the server. What it does is stop an in-flight state from reading as
 * an in-flight state forever: after a few seconds "saving" is no longer a fair description of
 * silence, and "no answer" says the same unknown in the words the owner would use.
 */
const NO_ANSWER_MS = 4000

/**
 * A confirmed save is stamped with the time it was confirmed, and then it stays.
 *
 * Two arguments pulled in opposite directions here and the clock settles both. Department E, in
 * `.claude/work-orders/e3-proposed-server-changes.md`, wanted the badge taken down after a couple of
 * seconds, because a bare "saved" left up stops describing the write that happened and becomes a
 * claim that the file is saved NOW, which nothing here can prove: an agent on this board can rewrite
 * that file while the owner is looking elsewhere. A blind reviewer, given only pictures of the old
 * card, wanted the opposite and said what was missing: no confirmation, no timestamp, and a card
 * that after the click is indistinguishable from one nobody ever clicked.
 *
 * "saved 09:12" is not a claim about the file's present state, so E's objection does not apply to
 * it. It is a record of one event that the server did confirm, and it stays true afterwards however
 * many times the file changes. So it can be left up, which is what the reviewer needed, and the
 * reviewer asked for a timestamp by name.
 */
const stampOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export type DocNodeData = {
  card: DocCard
  project: Project | undefined
  width: number
  height: number
}

/** A markdown file pinned to the canvas, readable and editable in place. */
export const DocNode = memo(function DocNode({ data, selected }: NodeProps) {
  const { card, project, width, height } = data as DocNodeData
  const [, bump] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /*
   * Which save this card is waiting on, if any.
   *
   * This used to be a boolean set to true on the click, which is what made the badge report that a
   * save had been attempted and not that one had landed. It is now a token, and it exists only so
   * an answer can be matched to the write that asked for it: an answer to a save the owner has
   * since replaced must not close an editor he has gone back into.
   */
  const [mySave, setMySave] = useState<number | null>(null)
  const [noAnswer, setNoAnswer] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => onDocChange(() => bump((n) => n + 1)), [])

  const isImage = card.kind === 'image'

  useEffect(() => {
    // Images are fetched over HTTP by card id, so there is nothing to read down the socket.
    if (!isImage && !card.collapsed && getDocContent(card.id) === undefined) actions.readDoc(card.id)
  }, [card.id, card.collapsed, isImage])

  const raw = getDocContent(card.id)
  const html = useMemo(() => {
    if (raw === undefined) return null
    const rendered = marked.parse(raw, { async: false, gfm: true, breaks: false }) as string
    // These files come from repositories and the renderer holds a socket that can start
    // processes, so a script tag in a README must never become code execution.
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } })
  }, [raw])

  /**
   * Waiting for the file, because the owner asked to edit it before it had arrived.
   *
   * Opening a card that has not been read yet used to seed the editor with `raw ?? ''`, and for any
   * card whose text was still in flight that meant an empty textarea. A history file is always in
   * that state, since it is only read once the card is on screen, so opening one showed a blank
   * editor and looked like the file had failed to open. Pressing Cancel left edit mode, the
   * rendered text appeared, and the file seemed to open only when the owner gave up on it.
   *
   * Nothing here fabricates content or guesses at it: the card says it is loading and the editor
   * opens on the real text the moment it lands.
   */
  const [awaitingText, setAwaitingText] = useState(false)

  const saveState = getDocSaveState(card.id)

  /**
   * The text a re-opened editor should hold.
   *
   * Normally the file as the card last read it. After a refused write it is the text the owner
   * tried to save, because that work is not on disk and the card is the only place it still exists.
   * Seeding the editor with `raw` there would quietly throw away exactly the edit the card is
   * telling him was not saved.
   */
  const editorSeed = () =>
    saveState && saveState.status !== 'ok' ? saveState.content : (raw ?? '')

  const startEdit = () => {
    if (raw === undefined) {
      // Ask for it now. The read is normally already in flight from the effect above, and asking
      // twice is harmless, but a collapsed card was never read at all and this is the only prompt.
      actions.readDoc(card.id)
      setAwaitingText(true)
      return
    }
    setDraft(editorSeed())
    setEditing(true)
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  useEffect(() => {
    if (!awaitingText || raw === undefined) return
    setAwaitingText(false)
    setDraft(editorSeed())
    setEditing(true)
    requestAnimationFrame(() => areaRef.current?.focus())
  }, [awaitingText, raw])

  /**
   * Double-click opens the file for editing and grows the card at the same time. Editing inside a
   * card the size of a postage stamp is not editing, so the two belong together.
   */
  const openForEdit = () => {
    if (card.size === 'normal') actions.toggleDocSize(card.id)
    startEdit()
  }

  const dirty = editing && draft !== (raw ?? '')

  const save = () => {
    const token = actions.saveDoc(card.id, draft)
    setMySave(token)
    setNoAnswer(false)
    /*
     * What used to be here waited 700ms and then decided the save had worked, which is a guess
     * about how long a server takes wearing the clothes of an answer. Nothing here decides
     * anything: the editor closes when the server confirms the write, and this timer only changes
     * the word in the badge once silence has gone on long enough that "saving" flatters it.
     */
    window.setTimeout(() => {
      const s = getDocSaveState(card.id)
      if (s?.token === token && s.status === 'pending') setNoAnswer(true)
    }, NO_ANSWER_MS)
  }

  /*
   * The editor closes because the server said the file was written, and for no other reason.
   *
   * A refused write leaves it open with the text still in it, which is the only way the owner can
   * try again or copy his work out. A write nobody has answered also leaves it open, because
   * closing it would be this card deciding an outcome it has not been told.
   */
  useEffect(() => {
    if (!editing || mySave === null) return
    if (saveState && saveState.token === mySave && saveState.status === 'ok') setEditing(false)
  }, [editing, mySave, saveState?.token, saveState?.status])

  /**
   * What this card is entitled to say about its file, and which claim wins when several are true.
   *
   * Waiting beats everything, because while a write is outstanding nothing else about it is known.
   * A refusal beats unsaved work: both mean the disk does not have the text, and "the file rejected
   * this" is the half worth the owner's attention. Unsaved work beats a confirmed save, so a card
   * being typed into says so rather than showing a stamp from ten minutes ago. A confirmed save is
   * the only thing that ever gets to look like good news, and it is drawn only when the server has
   * said the bytes are on disk.
   *
   * The bar this has to clear was set by the blind reviewer that read the old card, unprompted: the
   * post-click shots were indistinguishable from a card nobody had ever clicked, apart from a pill
   * that had gone. So every one of these four says something a reader can act on, and the neutral
   * no-badge state now means only one thing: nothing has been attempted here.
   */
  const badge =
    saveState?.status === 'pending'
      ? noAnswer
        ? {
            cls: 'doc-unknown',
            text: 'no answer',
            title: 'The write was sent and the server has not answered it. Whether this file was written is not known.',
          }
        : {
            cls: 'doc-unknown',
            text: 'saving',
            title: 'Sent to the server. Not confirmed written yet.',
          }
      : saveState?.status === 'error'
        ? {
            cls: 'doc-failed',
            text: 'not saved',
            /*
             * The reason as the server gave it, with a sentence in front of it that the person who
             * clicked can actually use.
             *
             * The raw exception is kept verbatim and never parsed: deciding what went wrong from the
             * text of an error message is the inference this app exists to refuse, and the same
             * argument is why the server was asked not to prettify it either. But a blind reviewer
             * called that string a developer message that says nothing about what to do next, and it
             * was right. Presenting it with an explanation is not the same as interpreting it.
             */
            title:
              'This file was NOT written. Your changes are still in this card and nowhere else, so ' +
              'press Edit to get them back.\n\nThe server reported:\n' +
              saveState.error,
          }
        : dirty
          ? { cls: 'doc-dirty', text: 'unsaved', title: 'Unsaved changes' }
          : saveState?.status === 'ok'
            ? {
                cls: 'doc-saved',
                text: `saved ${stampOf(saveState.at)}`,
                title:
                  `The server confirmed this file was written to disk at ${stampOf(saveState.at)}. ` +
                  'That is a record of one write, not a promise about the file now: anything on this ' +
                  'board can change it afterwards, and this card would not know.',
              }
            : null

  return (
    /*
     * A fragment so the resizer sits outside the card rather than inside it. .node clips to its
     * rounded corners, and that clip was cutting away half of every corner handle along with the
     * whole of its enlarged target, which is what made a diagonal so hard to grab.
     */
    <>
      <NodeResizer
        isVisible={!card.collapsed}
        minWidth={200}
        minHeight={120}
        lineClassName="card-resize-line"
        handleClassName="card-resize-handle"
        onResizeEnd={(_e, params) => actions.setDocBox(card.id, params.width, params.height)}
      />
    <div
      className={`node node--doc ${selected ? 'is-selected' : ''}`}
      style={
        {
          width,
          height: card.collapsed ? undefined : height,
          '--card-font': `${card.fontSize ?? 12}px`,
        } as CSSProperties
      }
      onWheelCapture={(e) => {
        if (!e.ctrlKey) return
        e.preventDefault()
        e.stopPropagation()
        actions.nudgeDocFont(card.id, e.deltaY < 0 ? 1 : -1)
      }}
    >

      {/* A file hangs off the session that runs from it, so its owner wire arrives at the top. */}
      {/* Wires attach to a visible dot, never to a bare edge, so it is obvious where a
          connection lands and which point to aim at. */}
      <div className="port port--top">
        <Handle id="owner" type="target" position={Position.Top} className="node-pin" />
        <span className="port-label port-label--top">Belongs to</span>
      </div>

      {/*
        The same "belongs to" connection, on the underside, for cards that sit ABOVE their owner.

        A history card is drawn above the session that did the work, so a wire arriving at its top
        would have to loop the long way around the card to reach a session below it. Giving the
        card a second owner point on its underside keeps that wire short and keeps the rule
        intact: history always leaves the session's top dot and lands on the underside of the
        card it belongs to.

        Only on history cards. Giving every card two dots that mean the same thing would undo the
        rule this exists to serve, which is that a dot's position tells you what it is for.
      */}
      {card.web === 'history' && (
        <div className="port port--bottom">
          <Handle id="ownerBelow" type="target" position={Position.Bottom} className="node-pin" />
          <span className="port-label port-label--bottom">Belongs to</span>
        </div>
      )}

      {/*
        One exception to the no-side-connectors rule, and it earns it.

        A turn that reviewed a picture gets a dot on its right holding what it looked at. That is
        not a file the session runs from and it is not a record of the turn, it is the evidence the
        turn's own claim rests on, so it needs its own place rather than being folded into either
        web. It appears only on a turn card that actually recorded an image, so a dot on a card
        always means there is something behind it.
      */}
      {card.web === 'history' && card.images.length > 0 && (
        <div className="port port--right">
          <Handle id="evidence" type="source" position={Position.Right} className="node-pin node-pin--under" />
          <button
            className="port-dot port-dot--evidence nodrag"
            title={`Show the ${card.images.length === 1 ? 'picture' : `${card.images.length} pictures`} this turn reviewed`}
            onClick={() => actions.toggleEvidence(card.id)}
          />
          <span className="port-label port-label--right">Reviewed</span>
        </div>
      )}
      {card.kind === 'image' && card.ownerId && (
        <div className="port port--left">
          <Handle id="evidenceIn" type="target" position={Position.Left} className="node-pin" />
          <span className="port-label port-label--left">Reviewed by</span>
        </div>
      )}

      {/*
        No other side connectors on a document, deliberately.

        A file is not a peer of a session and cannot talk to one. It belongs to whichever card
        runs from it, and that relationship has exactly two forms: something a session reads,
        which hangs off the bottom dot, or a record of what a session just did, which hangs off
        the top one. Offering left and right dots here invited a file to be wired the way two
        agents are wired, which says something that is not true and puts file wires in the middle
        of the agent traffic.
      */}

      {/*
        Double-click is a toggle, not a one-way door.

        The first one opens the file for editing and grows the card, because editing in a card the
        size of a postage stamp is not editing. The second one puts it away again: it saves first,
        drops back to the normal size, and collapses to the header pill, so the same gesture that
        opened it closes it and no work is lost on the way. Saving before collapsing matters,
        because a collapsed card has no editor to save from afterwards.
      */}
      <header
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (isImage) return actions.toggleDocSize(card.id)
          if (!editing) return openForEdit()
          if (dirty) save()
          if (card.size !== 'normal') actions.setDocSize(card.id, 'normal')
          setEditing(false)
          actions.setDocCollapsed(card.id, true)
        }}
        className="node-head node-head--doc"
        style={{ borderTopColor: isImage ? '#a3e635' : project?.color ?? '#38bdf8' }}
      >
        <button
          className="twisty nodrag"
          title={card.collapsed ? 'Show this document' : 'Hide the contents, keep the card'}
          onClick={() => actions.setDocCollapsed(card.id, !card.collapsed)}
        >
          {card.collapsed ? '▸' : '▾'}
        </button>
        <span className={`doc-icon ${isImage ? 'doc-icon--img' : ''}`}>{isImage ? 'IMG' : 'MD'}</span>
        <span className="node-title" title={card.relPath}>
          {card.title}
        </span>
        {/*
          The badge sits outside the editing test, and outside the collapsed test, on purpose.

          It used to live in the "not editing" half of the header, which is why it never appeared
          at all: the editor stayed open waiting for an answer that never came, and the one branch
          that could have said anything was the branch the card was not in. Collapsing was the
          same trap by another route. A card tidied away to a pill mid-save is still a card whose
          file may not have been written, so it keeps the right to say so; the pill loses the
          buttons, not the news.
        */}
        {!isImage && badge && (
          <span className={badge.cls} title={badge.title}>
            {badge.text}
          </span>
        )}
        {!card.collapsed && !isImage &&
          (editing ? (
            <>
              <button
                className="btn btn--primary nodrag"
                title="Write this back to the file (Ctrl+S)"
                onClick={save}
              >
                Save
              </button>
              <button
                className="btn btn--ghost nodrag"
                title="Discard changes"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn--ghost nodrag"
                title="Edit this file here as plain text and write it back to disk"
                onClick={startEdit}
              >
                Edit
              </button>
              <button
                className="btn btn--ghost nodrag"
                title="Re-read the file from disk"
                onClick={() => actions.readDoc(card.id)}
              >
                Reload
              </button>
            </>
          ))}
        {/* Minimize, not close. Removing a card is right-click, Delete, and a confirmation. */}
        <button
          className="twisty nodrag"
          title="Bigger: working size, then the whole workspace"
          onClick={() => actions.cycleDocSize(card.id, 1)}
        >
          ⤢
        </button>
        <button
          className="twisty nodrag"
          title={
            editing
              ? 'Save and collapse to a pill'
              : card.size === 'normal'
                ? 'Collapse to a pill. The card keeps its place on the board.'
                : 'Step back down one size'
          }
          onClick={() => {
            /*
             * Minimizing goes straight to the pill, and saves on the way.
             *
             * Stepping down through a smaller window first is not what anyone means by minimize
             * on a document, and losing an unsaved edit because the card was tidied away would
             * be the worst kind of surprise on a board built around editing files in place.
             */
            if (editing && draft !== (raw ?? '')) save()
            setEditing(false)
            actions.setDocCollapsed(card.id, true)
          }}
        >
          –
        </button>
      </header>

      {!card.collapsed && (
        <>
          <div className="doc-path" title={card.relPath}>
            {card.relPath}
          </div>
          {isImage ? (
            // Double-click opens it full size in a new window, which is what you want with a
            // screenshot a reviewer looked at.
            <div
              className="doc-image nowheel nodrag"
              title="Double-click to open full size"
              onDoubleClick={(e) => { e.stopPropagation(); window.open(`http://127.0.0.1:${DEFAULT_PORT}/file/${card.id}`, '_blank') }}
            >
              <img src={`http://127.0.0.1:${DEFAULT_PORT}/file/${card.id}`} alt={card.title} />
            </div>
          ) : editing ? (
            <textarea
              ref={areaRef}
              className="doc-edit nowheel nodrag"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false)
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  save()
                }
              }}
            />
          ) : html === null ? (
            <div className="doc-body doc-body--empty">loading</div>
          ) : (
            <div
              className="doc-body nowheel nodrag"
              title="Double-click to open this file for editing"
              onDoubleClick={(e) => { e.stopPropagation(); openForEdit() }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </>
      )}
    </div>
    </>
  )
})
