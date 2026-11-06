import { useEffect, useState } from 'react'
import { canRedo, canUndo, onUndoChange, redo, undo } from '../undo'

/**
 * Ctrl+Z and Ctrl+Y for board edits, with a brief toast naming what was reversed.
 *
 * The toast matters more than it looks: an undo that silently changes something off screen is
 * worse than no undo, because you cannot tell whether it did anything.
 */
export function UndoBar() {
  const [, bump] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => onUndoChange(() => bump((n) => n + 1)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      // Never steal undo from a text field or a terminal; those have their own.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const key = e.key.toLowerCase()
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey)
      if (key !== 'z' && key !== 'y') return
      e.preventDefault()
      const label = isRedo ? redo() : undo()
      setToast(label ? `${isRedo ? 'Redid' : 'Undid'}: ${label}` : `Nothing to ${isRedo ? 'redo' : 'undo'}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(id)
  }, [toast])

  return (
    <div className="undobar">
      <button
        className="btn btn--ghost"
        disabled={!canUndo()}
        title="Undo the last board change (Ctrl+Z)"
        onClick={() => setToast(undo() ? 'Undone' : 'Nothing to undo')}
      >
        Undo
      </button>
      <button
        className="btn btn--ghost"
        disabled={!canRedo()}
        title="Redo (Ctrl+Y)"
        onClick={() => setToast(redo() ? 'Redone' : 'Nothing to redo')}
      >
        Redo
      </button>
      {toast && <span className="undobar-toast">{toast}</span>}
    </div>
  )
}
