/**
 * Undo and redo for board edits.
 *
 * Deliberately narrow. Anything reversible by sending an opposite command is here: moving a card,
 * compacting or expanding it, drawing or deleting a wire, labelling a wire, closing a document.
 *
 * Deleting a session is NOT undoable and never will be. That command ends a real process and
 * removes its history, which cannot be recreated by replaying a message, so pretending it can be
 * undone would be a lie at exactly the moment it matters most. It stays behind its confirmation
 * instead.
 */

export interface UndoStep {
  /** Shown in the toast, so an undo says what it just reversed. */
  label: string
  undo: () => void
  redo: () => void
}

const LIMIT = 100

const past: UndoStep[] = []
const future: UndoStep[] = []
const subs = new Set<() => void>()

function notify() {
  for (const fn of subs) fn()
}

export function onUndoChange(fn: () => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** Record a step that has already been performed. */
export function record(step: UndoStep) {
  past.push(step)
  if (past.length > LIMIT) past.shift()
  // Any new edit invalidates the redo branch, the same as every editor.
  future.length = 0
  notify()
}

export function undo(): string | null {
  const step = past.pop()
  if (!step) return null
  step.undo()
  future.push(step)
  notify()
  return step.label
}

export function redo(): string | null {
  const step = future.pop()
  if (!step) return null
  step.redo()
  past.push(step)
  notify()
  return step.label
}

export function canUndo() {
  return past.length > 0
}

export function canRedo() {
  return future.length > 0
}
