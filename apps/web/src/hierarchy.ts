import type { TerminalSession, Wire } from '@garden/shared'

/**
 * Who made whom, read off the board.
 *
 * There is one definition of this and it lives here, because three things need to agree on it and
 * they used to each have their own idea. The arrangements rank cards by it, a card's own dots take
 * their meaning from it, and a wire is routed by it. Two of those disagreeing is a board where a
 * line leaves a dot labelled the opposite of what it does.
 *
 * The wires are the record. A line drawn between two cards already says who answers to whom, which
 * is why the card stopped carrying a field for it: a second place to state a fact is a second place
 * for it to be wrong. Context and history wires are skipped because they point at files rather
 * than at anyone.
 *
 * A card pointed at by more than one wire keeps the first. A layout can only put a card under one
 * maker, and silently taking the last would rearrange a board for no visible reason.
 */
export function parentsFromWires(sessions: TerminalSession[], wires: Wire[]): Map<string, string> {
  const ids = new Set(sessions.map((s) => s.id))
  const parents = new Map<string, string>()
  for (const w of wires) {
    if (w.kind === 'context' || w.kind === 'history' || w.kind === 'evidence') continue
    if (!ids.has(w.sourceId) || !ids.has(w.targetId)) continue
    if (!parents.has(w.targetId)) parents.set(w.targetId, w.sourceId)
  }
  return parents
}

/**
 * The maker of a card, falling back to the dispatch Garden watched.
 *
 * A wire the owner drew wins, because he drew it. A card nothing points at falls back to its
 * spawn parent, which is a real relationship nobody had to draw.
 */
export function makerOf(
  session: TerminalSession,
  parents: Map<string, string>,
): string | null {
  return parents.get(session.id) ?? session.parentId ?? null
}
