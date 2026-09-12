/**
 * The project's to-do list, read out of `TODO.md` and written back to it.
 *
 * One file holds everything, and a card's personal list is the subset of it addressed to that card,
 * derived every time it is drawn rather than stored anywhere. That is what makes the owner's shape
 * true by construction: "i want a main to-do list for entire project and each card to have their
 * perosnalized delegated to-do list from main. so the to-do lists are different for each card and
 * all contributing to main to-do list from todo.md". Two lists that have to be kept in step is a
 * synchronisation problem, and a synchronisation problem eventually shows him two different answers
 * to the same question. Canon 26.
 */

export type TodoItem = {
  /** Zero-based line in the file, which is what a write-back edits. */
  line: number
  done: boolean
  /** The item without its checkbox and without the `@card` it was delegated with. */
  text: string
  /** The card it is addressed to, or null for an item that belongs to the project. */
  cardId: string | null
}

/** A markdown task line, which is what the file would have contained anyway. */
const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/

/**
 * Every task line in the file, with the card each one is addressed to.
 *
 * Names resolve against the cards actually on the board, longest title first, so `@History worker`
 * is one card rather than a card called `History` followed by a word. An `@` that matches no card is
 * left in the text: a typo that silently moved an item to nobody would be worse than one that
 * visibly did nothing.
 */
export function parseTodo(md: string, cards: { id: string; title: string }[]): TodoItem[] {
  const byLongest = [...cards].sort((a, b) => b.title.length - a.title.length)
  const out: TodoItem[] = []
  md.split('\n').forEach((raw, line) => {
    const m = TASK.exec(raw.replace(/\r$/, ''))
    if (!m) return
    let text = m[2].trim()
    let cardId: string | null = null
    for (const c of byLongest) {
      if (!c.title.trim()) continue
      const tag = `@${c.title}`
      const at = text.toLowerCase().lastIndexOf(tag.toLowerCase())
      if (at === -1) continue
      // The title has to end where the tag ends, or `@Worker` would claim `@Worker two`.
      const after = text.slice(at + tag.length)
      if (after && !/^[\s.,;:)\]]/.test(after)) continue
      cardId = c.id
      text = (text.slice(0, at) + after).replace(/\s+/g, ' ').trim()
      break
    }
    out.push({ line, done: m[1] !== ' ', text, cardId })
  })
  return out
}

/**
 * The same file with one item ticked or unticked, and everything else exactly as it was.
 *
 * By line rather than by text, and by editing that line in place rather than rebuilding the
 * document, because the file is the owner's: it holds headings, notes, blank lines and items this
 * parser does not recognise, and none of that is ours to reformat on a checkbox click.
 */
export function setDone(md: string, line: number, done: boolean): string {
  const lines = md.split('\n')
  const raw = lines[line]
  if (raw === undefined || !TASK.test(raw.replace(/\r$/, ''))) return md
  lines[line] = raw.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

/** How a card's own list reads in one line, for the bar above it. */
export function progressOf(items: TodoItem[]): { done: number; total: number; open: TodoItem[] } {
  return { done: items.filter((i) => i.done).length, total: items.length, open: items.filter((i) => !i.done) }
}

/**
 * What a card's loop says when it is pointed at that card's own list.
 *
 * The completion condition is in the prompt rather than anywhere in Garden, because the card is the
 * only thing that can tell when its list is empty, and it is the card that may switch its own loop
 * off. The owner: "each card should loop to their to-do list and set to off when completed".
 */
export function loopPromptFor(title: string): string {
  return (
    `Check your to-do list: the items in TODO.md ending @${title} are yours. Do the next one, tick it ` +
    `in that file, and stop. When none of yours are left, switch this loop off with ` +
    `garden-loop.mjs --off --card "${title}".`
  )
}
