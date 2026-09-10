import { useEffect, useRef, useState } from 'react'
import { actions } from '../state'

/**
 * Where a new document card is going, and what kind of file it is.
 *
 * "New markdown file" and "New text file" in the pane menu share this one form rather than each
 * carrying its own dialog; the extension is the only thing that ever differed between them.
 */
export interface NewDocRequest {
  projectId: string
  kind: 'md' | 'txt'
  /** Where the card should land, in board coordinates, from wherever he right-clicked. */
  x: number
  y: number
}

const DEFAULT_PATH: Record<NewDocRequest['kind'], string> = {
  md: 'notes/new-note.md',
  txt: 'notes/new-note.txt',
}

/**
 * A relative path, typed once, in place of the native `prompt()` this used to be.
 *
 * `prompt()` blocks the whole tab, offers no styling, no cancel but the one button, and says
 * nothing about which project it is asking into. This is the same modal shape `NewCardForm` uses,
 * so making a document reads as the same kind of action as making a session rather than a
 * leftover browser dialog nobody re-skinned.
 */
export function NewDocForm({
  request,
  onClose,
  onCreate,
}: {
  request: NewDocRequest | null
  onClose: () => void
  /**
   * Told the project id the instant a card is actually asked for, not when the form opens, so
   * whatever is watching for the new card to arrive is not left waiting on one that Cancel threw
   * away.
   */
  onCreate: (projectId: string) => void
}) {
  const [relPath, setRelPath] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!request) return
    setRelPath(DEFAULT_PATH[request.kind])
    // Selected rather than just focused, so typing a real name replaces the placeholder path in
    // one motion instead of the owner having to clear it first.
    setTimeout(() => inputRef.current?.select(), 30)
  }, [request])

  if (!request) return null

  const submit = () => {
    const path = relPath.trim()
    if (!path) return
    actions.createDoc(request.projectId, path, request.x, request.y)
    onCreate(request.projectId)
    onClose()
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="newcard"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter') submit()
        }}
      >
        <div className="newcard__head">
          <span className="newcard__title">New {request.kind === 'md' ? 'markdown' : 'text'} file</span>
          <button className="newcard__x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <label className="newcard__row">
          <span>Path</span>
          <input
            ref={inputRef}
            value={relPath}
            spellCheck={false}
            onChange={(e) => setRelPath(e.target.value)}
          />
        </label>

        <div className="newcard__foot">
          <button className="newcard__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="newcard__make" onClick={submit}>
            Make the card
          </button>
        </div>
      </div>
    </div>
  )
}
