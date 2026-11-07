/**
 * The goal ring's reading of `TODO.md`. Canon 26, "The goal ring".
 *
 * A view: worked out from the file each time and never stored. The states
 * are `[x]` and one tag on ordinary unticked lines, so anything else reading the file still counts
 * those lines as open. It tracks progress and asks nothing of the owner.
 */
export type GoalState = 'done' | 'doing' | 'next'

export type GoalPart = {
  line: number
  label: string
  state: GoalState
  owner: string | null
  description: string
  /** The exit: what is true when this is done. */
  doneWhen: string
}

export type GoalStep = GoalPart & {
  parts: GoalPart[]
}

export type Goal = {
  title: string
  description: string
  steps: GoalStep[]
  done: number
}

const TASK = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/
const BULLET = /^(\s*)[-*]\s+(?!\[[ xX]\])(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const FIELD = /^(why|description|start|end|done when)\s*:\s*(.*)$/i

/** The words Garden reads as state, which are not part of what an item is called. */
export function stripMarks(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/(^|\s)#(doing|needs-you)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The item's text and the card it names, resolved the way the to-do bars resolve it. */
function readLabel(raw: string, titles: string[]): { label: string; owner: string | null } {
  let text = raw
  let owner: string | null = null
  for (const title of titles) {
    if (!title.trim()) continue
    const tag = `@${title}`
    const at = text.toLowerCase().lastIndexOf(tag.toLowerCase())
    if (at === -1) continue
    const after = text.slice(at + tag.length)
    if (after && !/^[\s.,;:)\]]/.test(after)) continue
    owner = title
    text = text.slice(0, at) + after
    break
  }
  return { label: stripMarks(text), owner }
}

function tagged(raw: string, ticked: boolean): GoalState {
  if (ticked) return 'done'
  if (/(^|\s)#doing(\s|$)/i.test(raw)) return 'doing'
  return 'next'
}

/** Where the goal starts: a `Now` heading, or the first heading with items under it. */
function findHeading(lines: string[]): { at: number; level: number; title: string } | null {
  const headings: { at: number; level: number; title: string }[] = []
  lines.forEach((raw, at) => {
    const m = HEADING.exec(raw)
    if (m) headings.push({ at, level: m[1].length, title: m[2] })
  })
  const now = headings.find((h) => /^now\b/i.test(h.title))
  if (now) return { ...now, title: now.title.replace(/^now\b\s*[:\-]?\s*/i, '') || now.title }
  for (let i = 0; i < headings.length; i++) {
    const end = headings[i + 1]?.at ?? lines.length
    if (lines.slice(headings[i].at + 1, end).some((l) => TASK.test(l))) return headings[i]
  }
  return null
}

/**
 * An old-style list: no `Now` heading, and items under several headings of one level. Each heading is a
 * goal and its items are sub-goals, so the file draws both rings without being rewritten. Canon 26.
 */
function parseSections(lines: string[], cardTitles: string[]): Goal | null {
  const headings: { at: number; level: number; title: string }[] = []
  lines.forEach((raw, at) => {
    const m = HEADING.exec(raw)
    if (m) headings.push({ at, level: m[1].length, title: m[2] })
  })
  if (headings.some((h) => /^now\b/i.test(h.title))) return null
  const ends = headings.map((_, i) => headings[i + 1]?.at ?? lines.length)
  const tasked = headings.flatMap((h, i) =>
    lines.slice(h.at + 1, ends[i]).some((l) => TASK.test(l)) ? [{ ...h, end: ends[i] }] : [],
  )
  if (tasked.length < 2 || tasked.some((h) => h.level !== tasked[0].level)) return null

  const steps: GoalStep[] = []
  for (const h of tasked) {
    const section = parseGoal(lines.slice(h.at, h.end).join('\n'), cardTitles)
    if (!section) continue
    const parts = section.steps.map(({ parts: _parts, ...p }) => ({ ...p, line: p.line + h.at }))
    const all = parts.every((p) => p.state === 'done')
    const some = parts.some((p) => p.state !== 'next')
    steps.push({
      line: h.at,
      label: section.title,
      owner: null,
      state: all ? 'done' : some ? 'doing' : 'next',
      description: section.description,
      doneWhen: '',
      parts,
    })
  }
  const first = headings.find((h) => h.level < tasked[0].level)
  return {
    title: stripMarks(first?.title ?? 'To do'),
    description: '',
    steps,
    done: steps.filter((s) => s.state === 'done').length,
  }
}

/** The tab's one goal, or null when the file holds no items to track. */
export function parseGoal(md: string, cardTitles: string[]): Goal | null {
  const lines = md.split('\n').map((l) => l.replace(/\r$/, ''))
  const sections = parseSections(lines, cardTitles)
  if (sections) return sections
  const titles = [...cardTitles].sort((a, b) => b.length - a.length)
  const heading = findHeading(lines)
  let from = 0
  let to = lines.length
  if (heading) {
    from = heading.at + 1
    for (let i = from; i < lines.length; i++) {
      const m = HEADING.exec(lines[i])
      if (m && m[1].length <= heading.level) {
        to = i
        break
      }
    }
  }

  const steps: GoalStep[] = []
  const about: string[] = []
  let base = -1
  let step: GoalStep | null = null
  let part: GoalPart | null = null
  let partIndent = -1
  for (let i = from; i < to; i++) {
    const raw = lines[i]
    const task = TASK.exec(raw)
    if (task) {
      const indent = task[1].length
      if (base === -1) base = indent
      const { label, owner } = readLabel(task[3], titles)
      const state = tagged(task[3], task[2] !== ' ')
      if (indent <= base || !step) {
        step = { line: i, label, owner, state, description: '', doneWhen: '', parts: [] }
        part = null
        steps.push(step)
      } else {
        part = { line: i, label, owner, state, description: '', doneWhen: '' }
        partIndent = indent
        step.parts.push(part)
      }
      continue
    }
    const bullet = BULLET.exec(raw)
    if (bullet && step) {
      const field = FIELD.exec(stripMarks(bullet[2]))
      if (!field) continue
      const name = field[1].toLowerCase()
      const value = field[2]
      if (part && bullet[1].length > partIndent) {
        if (name === 'end' || name === 'done when') part.doneWhen = value
        else if (!part.description || name === 'why' || name === 'description') part.description = value
      } else if (name === 'end' || name === 'done when') {
        step.doneWhen = value
      } else if (name === 'why' || name === 'description' || !step.description) {
        step.description = value
      }
      continue
    }
    const plain = raw.trim()
    if (!step && plain && !HEADING.test(raw)) about.push(stripMarks(plain))
  }
  if (steps.length === 0) return null

  // A step with no word of its own takes its state from its parts.
  for (const s of steps) {
    if (s.state !== 'next') continue
    if (s.parts.length > 0 && s.parts.every((p) => p.state === 'done')) s.state = 'done'
    else if (s.parts.some((p) => p.state === 'doing' || p.state === 'done')) s.state = 'doing'
  }

  return {
    title: stripMarks(heading?.title ?? 'To do').replace(/\s*\(\s*\d+\s+of\s+\d+\s*\)\s*$/i, ''),
    description: about.join(' '),
    steps,
    done: steps.filter((s) => s.state === 'done').length,
  }
}

/** Which step opens first: the one under way, then the next. */
export function defaultStep(goal: Goal): number {
  for (const state of ['doing', 'next'] as GoalState[]) {
    const i = goal.steps.findIndex((s) => s.state === state)
    if (i >= 0) return i
  }
  return 0
}
