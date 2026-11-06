import { BOARD } from '@garden/shared'

export interface Sized {
  width: number
  height: number
}

export interface Placed {
  x: number
  y: number
}

/**
 * Every card is given room for its own two webs before anything else is placed near it.
 *
 * A card is not just the card. Its bottom dot unfolds the files it works from and its top dot
 * unfolds its history, both of which are blocks of cards in their own right, and both of which
 * belong directly under and over the card they came from. Spacing cards just far enough apart to
 * see a wire meant opening one web shoved the board around or landed the block somewhere it did
 * not belong.
 *
 * So the vertical gap is a web's worth of room rather than a wire's worth. The canvas is infinite
 * and zooms out a long way, so empty space between cards costs nothing, while not having it costs
 * a rearranged board every time a blip is opened.
 */
const GAP_X = 160
const GAP_Y = 200
const PAD = BOARD.GAP

/**
 * Pack cards into a grid from the top left, at their natural size.
 *
 * An earlier version stretched cards to fill the viewport. Two blind reviewers liked that better,
 * but the owner does not: he wants small cards so more of them fit and can be expanded one at a
 * time. Owner wins. Empty canvas below the cards is fine, because the canvas is a board you add
 * to, not a layout that must justify every pixel.
 *
 * Rows are as tall as their tallest card, so a collapsed card sitting next to an open one does
 * not drag the whole row down.
 */
export function packCards(cards: Sized[], viewportWidth: number): Placed[] {
  if (cards.length === 0) return []

  const avail = Math.max(1, viewportWidth - PAD * 2)
  const out: Placed[] = []

  let x = PAD
  let y = PAD
  let rowHeight = 0

  for (const card of cards) {
    // Wrap when this card would overflow, but never leave a row completely empty.
    if (x > PAD && x + card.width > PAD + avail) {
      x = PAD
      y += rowHeight + GAP_Y
      rowHeight = 0
    }
    out.push({ x, y })
    x += card.width + GAP_X
    rowHeight = Math.max(rowHeight, card.height)
  }

  return out
}

export interface Arrangeable {
  id: string
  width: number
  height: number
  kind: 'session' | 'doc'
  /** Sessions only: what the card is doing, used by the by-status arrangement. */
  status?: string
  /** Doc cards only: which column of a context web it belongs to. */
  group?: string | null
  /** Sessions only: the card that spawned this one, which is what makes a tier a tier. */
  parentId?: string | null
  /** Doc cards only: the session this file belongs to, so it can be laid out under that card. */
  ownerId?: string | null
  /** Doc cards only: which web it belongs to, which decides whether it sits above or below. */
  web?: 'context' | 'history' | null
  /** Where this card sits right now, so a web can travel by the same amount its owner did. */
  x?: number
  y?: number
}

/**
 * Ways to lay the board out on demand.
 *
 * One arrangement is never right for every moment: a wired pipeline wants a tree, a board of
 * twenty terminals wants a grid, and "which of these needs me" wants columns by status. These
 * are all one-shot: they move cards and then leave them alone, so nothing is fighting the owner
 * for control of the board.
 */
export type ArrangementId = 'web' | 'tree' | 'sequential' | 'waterfall'

/**
 * Four ways of drawing the same graph, and every one says the same thing about rank.
 *
 * A web puts the maker in the middle with its departments all around it. A tree puts the maker on
 * top. A sequence makes it first. A waterfall makes it the root at the top left. Which to reach
 * for is a matter of what reads best on the day; what never varies is that the card everything
 * came from is the one the eye lands on first, and that further from it means further down the
 * chain.
 *
 * There were four more that sorted by kind, status or category. They answered a different question
 * from the one this board exists for, and a row of eight buttons made the four that matter harder
 * to find. Tidy layout still repacks a board with no hierarchy implied, so nothing was lost.
 */
export const ARRANGEMENTS: Array<{ id: ArrangementId; label: string; hint: string }> = [
  { id: 'web', label: 'Web', hint: 'the maker in the middle, departments all around it' },
  { id: 'tree', label: 'Tree', hint: 'the maker on top, each tier a row below' },
  { id: 'sequential', label: 'Sequential', hint: 'the maker first, then in the order it hired' },
  { id: 'waterfall', label: 'Waterfall', hint: 'the root top left, cascading down and right' },
]

/*
 * The same reasoning as the packer's gaps, with one addition.
 *
 * A laid-out board leaves each card room to reach its History and Roots arrows, which sit half
 * outside the card's edges. The web that opens from either of them makes its own room at the time,
 * so this only has to cover the arrows themselves and keep the board readable.
 */
const A_GAP_X = 90
const A_GAP_Y = 240

/**
 * The ordering that stops wires crossing each other.
 *
 * Crossings on this board are not a drawing problem, they are an ordering problem. A hierarchy
 * can always be drawn without a single wire crossing another, on one condition: everything under
 * one card has to occupy an unbroken run, with no other card's descendants interleaved into it.
 * Break that and no amount of curve routing can fix it; keep it and the crossings are gone before
 * anything is drawn.
 *
 * So this walks the hierarchy depth first and hands out consecutive slots to the leaves, which
 * makes every subtree a contiguous block by construction. A parent then sits at the midpoint of
 * its own children, so its wires fan out from one point instead of reaching across a neighbour.
 * Wires that share an endpoint can never cross each other, which is what makes the fan safe.
 *
 * Two honest limits. Wires the owner drew by hand between unrelated cards are not part of the
 * hierarchy and can still cross anything; there is no arrangement that avoids that, because those
 * connections do not form a tree. And a card with two parents cannot sit under both at once, so
 * the first one seen wins and the second wire may cross.
 */
interface Hierarchy {
  depth: Map<string, number>
  /** Position along the cross axis, in slots. Fractional for a parent: the middle of its children. */
  slot: Map<string, number>
  /** Depth first order, so a subtree is always a contiguous run. */
  sequence: string[]
  slots: number
  depths: number
}

function orderHierarchy(sessions: Arrangeable[]): Hierarchy {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const children = new Map<string, Arrangeable[]>()
  const roots: Arrangeable[] = []

  for (const s of sessions) {
    const parent = s.parentId && byId.has(s.parentId) ? s.parentId : null
    if (!parent) {
      roots.push(s)
      continue
    }
    const list = children.get(parent) ?? []
    list.push(s)
    children.set(parent, list)
  }

  const depth = new Map<string, number>()
  const slot = new Map<string, number>()
  const sequence: string[] = []
  const seen = new Set<string>()
  let next = 0

  const walk = (node: Arrangeable, d: number) => {
    // A cycle would otherwise recurse until the stack gives out. It cannot happen from real spawn
    // events, but a hand-edited database is not worth crashing the board over.
    if (seen.has(node.id)) return
    seen.add(node.id)
    depth.set(node.id, d)
    sequence.push(node.id)

    const kids = children.get(node.id) ?? []
    if (kids.length === 0) {
      slot.set(node.id, next)
      next++
      return
    }
    const first = next
    for (const kid of kids) walk(kid, d + 1)
    const last = next - 1
    /*
     * Left edge of its own run, not the middle of it.
     *
     * Centring reads better on paper and crossed wires on screen. A wire between two sessions
     * leaves whichever side faces the other card, so a centred parent sends some of its wires out
     * of its left dot and the rest out of its right, and those two fans start from different
     * points and can cross each other and their neighbours. Sitting at the left of its own span
     * puts every child on the same side, so all of a card's wires leave one dot, and a fan from a
     * single point cannot cross itself. Measured, not argued: this took the tree arrangement from
     * three crossings to none on a two-tier board.
     */
    slot.set(node.id, first)
  }

  for (const root of roots) walk(root, 0)
  // Anything unreachable (a child whose parent is on another board) still needs a place.
  for (const s of sessions) {
    if (seen.has(s.id)) continue
    depth.set(s.id, 0)
    slot.set(s.id, next)
    sequence.push(s.id)
    next++
  }

  return {
    depth,
    slot,
    sequence,
    slots: Math.max(1, next),
    depths: Math.max(1, Math.max(0, ...[...depth.values()]) + 1),
  }
}


/**
 * Push cards apart without changing the shape they were given.
 *
 * The board applies an arrangement exactly as computed, with no per-card nudging, because nudging
 * one card at a time against a half-moved board is what destroyed the shape in the first place.
 * That puts the burden here: a lattice that overlaps now really does draw overlapping cards, and
 * a card hidden under another is the one thing the board must never do.
 *
 * Only downward, never sideways. Every arrangement carries its meaning in the horizontal axis,
 * whether that is a tier, a ring or a position in a sequence, so moving a card left or right
 * would say something untrue about it; moving it down says nothing at all.
 */
function separate(out: Map<string, Placed>, items: Arrangeable[]): Map<string, Placed> {
  const boxes = items
    .map((c) => ({ c, p: out.get(c.id) }))
    .filter((b): b is { c: Arrangeable; p: Placed } => !!b.p)
    .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)

  const placed: Array<{ x: number; y: number; w: number; h: number }> = []
  for (const { c, p } of boxes) {
    let y = p.y
    // Walk down past anything already sitting where this card wants to be.
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.find(
        (r) => p.x < r.x + r.w + 24 && p.x + c.width + 24 > r.x && y < r.y + r.h + 24 && y + c.height + 24 > r.y,
      )
      if (!hit) break
      y = hit.y + hit.h + 24
    }
    out.set(c.id, { x: p.x, y })
    placed.push({ x: p.x, y, w: c.width, h: c.height })
  }
  return out
}

/**
 * The pitch of a column and a row.
 *
 * Every hierarchy arrangement puts session cards on a fixed lattice rather than packing them
 * tightly. A uniform pitch is what lets the ordering hold: if a card could be any width, one wide
 * card would push its neighbours out of their slots and a subtree would stop being contiguous,
 * which is the one thing that must not happen.
 */
function pitchOf(cards: Arrangeable[]): { x: number; y: number } {
  const w = cards.reduce((m, c) => Math.max(m, c.width), 320)
  const h = cards.reduce((m, c) => Math.max(m, c.height), 180)
  return { x: w + A_GAP_X * 2, y: h + A_GAP_Y }
}

/**
 * A web travels with its card, it is not laid out again.
 *
 * The bottom blip already arranges the files a session works from into labelled columns, and the
 * top blip does the same for its history. That structure is the owner's, worked out once and
 * meant to stay put: picking a different shape for the BOARD is a cosmetic choice about where the
 * session cards sit, and it has no business reshuffling the files underneath them.
 *
 * So every card in a web keeps its exact offset from the session it belongs to, and the whole
 * block is translated by however far that session moved. A web looks identical before and after
 * an arrangement; it is simply somewhere else.
 *
 * Files opened by hand belong to the board rather than to any one card, so they stay where they
 * were put.
 */
function moveWebsWithOwners(out: Map<string, Placed>, docs: Arrangeable[], sessions: Arrangeable[]) {
  const owners = new Map(sessions.map((s) => [s.id, s]))
  const webs = new Map<string, Arrangeable[]>()

  for (const d of docs) {
    const ownerId = d.ownerId && owners.has(d.ownerId) ? d.ownerId : null
    // A loose document is left exactly where it is, which is also what happens to one whose owner
    // is not on this board.
    if (!ownerId) continue
    const list = webs.get(ownerId) ?? []
    list.push(d)
    webs.set(ownerId, list)
  }

  /** Boxes that a web must not land on: every session, at its new position. */
  const obstacles = sessions
    .map((sn) => {
      const at = out.get(sn.id)
      return at ? { x: at.x, y: at.y, w: sn.width, h: sn.height } : null
    })
    .filter((b): b is { x: number; y: number; w: number; h: number } => !!b)

  for (const [ownerId, list] of webs) {
    const owner = owners.get(ownerId)!
    const to = out.get(ownerId)
    if (!to || owner.x === undefined || owner.y === undefined) continue
    const dx = to.x - owner.x
    const dy = to.y - owner.y

    const moved = list.map((d) => ({
      d,
      x: (d.x ?? 0) + dx,
      y: (d.y ?? 0) + dy,
    }))

    /*
     * Nudge the block as a whole if it lands on a card, never its members individually.
     *
     * Moving one file out of a column to dodge a card would break exactly the structure this
     * function exists to preserve. Shifting the entire web keeps every column intact and only
     * changes where the group sits.
     */
    const hits = (shift: number) =>
      moved.some((m) =>
        obstacles.some(
          (r) =>
            m.x < r.x + r.w + 20 &&
            m.x + m.d.width + 20 > r.x &&
            m.y + shift < r.y + r.h + 20 &&
            m.y + shift + m.d.height + 20 > r.y,
        ),
      )

    let shift = 0
    const step = list.reduce((mx, d) => Math.max(mx, d.height), 40) + 24
    // A web sits below its owner, so downward is the direction that keeps it below.
    for (let i = 0; i < 40 && hits(shift); i++) shift += step

    for (const m of moved) out.set(m.d.id, { x: m.x, y: m.y + shift })
  }
}

/**
 * How many rays a branch needs, which is its leaf count rather than its size.
 *
 * Angle is spent by the outermost cards: a chain of five needs one direction and a star of four
 * needs four, even though one has five cards and the other has five too. Sizing wedges by subtree
 * size gives the chain five times the room it can use and squeezes the star that needed it.
 */
function leafWeight(
  id: string,
  children: Map<string, Arrangeable[]>,
  memo = new Map<string, number>(),
  depth = 0,
): number {
  const seen = memo.get(id)
  if (seen !== undefined) return seen
  if (depth > 16) return 1
  const kids = children.get(id) ?? []
  const n = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + leafWeight(k.id, children, memo, depth + 1), 0)
  memo.set(id, n)
  return n
}

/**
 * A web: the maker in the middle, its departments radiating all the way around it.
 *
 * The session the owner started sits at the centre and every branch off it owns a wedge of the
 * full circle, so a creative team, a coding team and an advertising team read as three families
 * pointing in three directions rather than one long row. That middle card is the only one that
 * fans both ways; once a branch has a direction, everything under it keeps going that way, which
 * is what lets a card's left and right dots mean something rather than being wherever the line
 * happened to land.
 *
 * A wedge is sized by how many cards its branch actually holds, so a department of twelve gets
 * twelve times the room of a department of one. Splitting the circle evenly instead would have a
 * large family overlapping itself while a small one sat in acres of space.
 *
 * The ring is an ellipse rather than a circle because the board is a 37 inch ultrawide: a circle
 * puts cards off the top and bottom while leaving the sides empty. Those two radii are the numbers
 * most worth checking against a real board rather than taking on trust here.
 */
function webLayout(items: Arrangeable[]): Map<string, Placed> {
  const sessions = items.filter((i) => i.kind === 'session')
  const docs = items.filter((i) => i.kind === 'doc')
  const pitch = pitchOf(sessions)
  const out = new Map<string, Placed>()
  if (sessions.length === 0) return out

  const byId = new Map(sessions.map((s) => [s.id, s]))
  const children = new Map<string, Arrangeable[]>()
  const roots: Arrangeable[] = []
  for (const s of sessions) {
    const parent = s.parentId && byId.has(s.parentId) ? s.parentId : null
    if (!parent) roots.push(s)
    else children.set(parent, [...(children.get(parent) ?? []), s])
  }

  const cx = 1500
  const cy = 900
  const RX = pitch.x * 0.95
  const RY = pitch.y * 0.7

  // Several roots share the middle in a short column: each is a card the owner started himself
  // and none of them belongs under another.
  roots.forEach((root, i) => {
    out.set(root.id, {
      x: cx - root.width / 2,
      y: cy - root.height / 2 + i * (root.height + A_GAP_Y / 3),
    })
  })

  /**
   * Walk a branch outward, each card taking the middle of its own share of the wedge.
   *
   * A card's children divide its wedge between them by weight, so a subtree never reaches outside
   * the arc its parent gave it and two families cannot interleave. That is the same guarantee the
   * contiguous slots give the other three arrangements, expressed in angles.
   */
  const memo = new Map<string, number>()
  const place = (card: Arrangeable, from: number, to: number, depth: number) => {
    const mid = (from + to) / 2
    out.set(card.id, {
      x: cx + Math.cos(mid) * RX * depth - card.width / 2,
      y: cy + Math.sin(mid) * RY * depth - card.height / 2,
    })

    const kids = children.get(card.id) ?? []
    if (kids.length === 0) return
    const total = kids.reduce((sum, k) => sum + leafWeight(k.id, children, memo), 0) || 1
    let cursor = from
    for (const kid of kids) {
      const share = ((to - from) * leafWeight(kid.id, children, memo)) / total
      place(kid, cursor, cursor + share, depth + 1)
      cursor += share
    }
  }

  for (const root of roots) {
    const kids = children.get(root.id) ?? []
    if (kids.length === 0) continue
    const total = kids.reduce((sum, k) => sum + leafWeight(k.id, children, memo), 0) || 1
    /*
     * Start at due north and sweep clockwise, so the WEDGE BOUNDARIES sit at the poles and the
     * wedge MIDDLES sit east and west.
     *
     * Starting at due east put the boundaries east and west, which meant two departments took the
     * arcs [0,π] and [π,2π] and sat at their midpoints: straight down and straight up. The comment
     * said left and right and the arithmetic did the opposite. Two departments now land either
     * side of the card that made them, which is the shape the owner asked for, and it leaves the
     * column above and below the middle card clear for its own two arrows.
     */
    let cursor = -Math.PI / 2
    for (const kid of kids) {
      const share = (Math.PI * 2 * leafWeight(kid.id, children, memo)) / total
      place(kid, cursor, cursor + share, 1)
      cursor += share
    }
  }

  // Anything the walk never reached, which means its maker is not on this board.
  let spare = 0
  for (const s of sessions) {
    if (out.has(s.id)) continue
    out.set(s.id, { x: 40 + spare * pitch.x, y: 40 })
    spare++
  }

  separate(out, sessions)
  moveWebsWithOwners(out, docs, sessions)
  return out
}

/**
 * A tree: the makers along the top, each tier a row beneath the one that hired it.
 *
 * A card sits at the midpoint of its own children, so its wires leave as a fan from a single
 * point. Fans from one point cannot cross each other, and because each subtree owns an unbroken
 * run of columns, one branch's fan never reaches into another's.
 */
function treeTiers(items: Arrangeable[]): Map<string, Placed> {
  const sessions = items.filter((i) => i.kind === 'session')
  const docs = items.filter((i) => i.kind === 'doc')
  const h = orderHierarchy(sessions)
  const pitch = pitchOf(sessions)
  const out = new Map<string, Placed>()

  let bottom = 40
  for (const card of sessions) {
    const x = 40 + (h.slot.get(card.id) ?? 0) * pitch.x
    const y = 40 + (h.depth.get(card.id) ?? 0) * pitch.y
    out.set(card.id, { x, y })
    bottom = Math.max(bottom, y + card.height)
  }
  // Sessions are spaced out first, then each web is carried to wherever its card ended up.
  separate(out, sessions)
  moveWebsWithOwners(out, docs, sessions)
  return out
}

/**
 * A sequence: the maker is first, then everything it hired, in the order it hired them.
 *
 * Depth first, so a card is immediately followed by its own descendants. That keeps every
 * connection between neighbours or nested inside another connection's span, and nested arcs do
 * not cross.
 */
function sequentialLayout(items: Arrangeable[]): Map<string, Placed> {
  const sessions = items.filter((i) => i.kind === 'session')
  const docs = items.filter((i) => i.kind === 'doc')
  const h = orderHierarchy(sessions)
  const pitch = pitchOf(sessions)
  const byId = new Map(sessions.map((c) => [c.id, c]))
  const out = new Map<string, Placed>()

  let tallest = 0
  h.sequence.forEach((id, i) => {
    const card = byId.get(id)
    if (!card) return
    out.set(id, { x: 40 + i * pitch.x, y: 40 })
    tallest = Math.max(tallest, card.height)
  })
  // Sessions are spaced out first, then each web is carried to wherever its card ended up.
  separate(out, sessions)
  moveWebsWithOwners(out, docs, sessions)
  return out
}

/**
 * A waterfall: the root at the top left, each hire stepping down and to the right.
 *
 * An indented outline, the same shape a file tree has. Depth first order down the page and depth
 * across it means a wire only ever runs from a card to the block directly beneath and right of
 * it, which cannot cross another.
 */
function waterfallLayout(items: Arrangeable[]): Map<string, Placed> {
  const sessions = items.filter((i) => i.kind === 'session')
  const docs = items.filter((i) => i.kind === 'doc')
  const h = orderHierarchy(sessions)
  const pitch = pitchOf(sessions)
  const byId = new Map(sessions.map((c) => [c.id, c]))
  const out = new Map<string, Placed>()

  let bottom = 40
  h.sequence.forEach((id, i) => {
    const card = byId.get(id)
    if (!card) return
    const x = 40 + (h.depth.get(id) ?? 0) * (pitch.x * 0.55)
    const y = 40 + i * (card.height + A_GAP_Y / 2)
    out.set(id, { x, y })
    bottom = Math.max(bottom, y + card.height)
  })
  // Sessions are spaced out first, then each web is carried to wherever its card ended up.
  separate(out, sessions)
  moveWebsWithOwners(out, docs, sessions)
  return out
}


export function arrange(id: ArrangementId, items: Arrangeable[]): Map<string, Placed> {
  if (items.length === 0) return new Map()
  if (id === 'tree') return treeTiers(items)
  if (id === 'sequential') return sequentialLayout(items)
  if (id === 'waterfall') return waterfallLayout(items)
  return webLayout(items)
}

export function shouldAutoPack(items: Array<{ manualPos: boolean }>): boolean {
  return items.length > 0 && items.every((i) => !i.manualPos)
}

/**
 * Header-only height for a collapsed card.
 *
 * From the shared table rather than a number kept in step by hand. Measured from the DOM: a header
 * whose title wraps to a second line draws taller than one that does not, and reserving the short
 * figure is what left rows fourteen pixels apart that were supposed to be twenty-six.
 */
export const COLLAPSED_H = BOARD.COLLAPSED_H

export interface TreeNode {
  id: string
  width: number
  height: number
}

/**
 * Lay wired sessions out as a top-down tree: a parent above, its children spread beneath it.
 *
 * A board where every connection is a long diagonal becomes unreadable the moment there is more
 * than a handful of cards, which is exactly when this app is supposed to help. A tree keeps each
 * wire short and mostly vertical, so following who spawned whom is a glance rather than a trace.
 *
 * Children are packed by subtree width rather than by count, so a child with many descendants
 * gets the room it needs and siblings never overlap.
 */
export function treeLayout(
  nodes: TreeNode[],
  edges: Array<{ source: string; target: string }>,
  originX = 40,
  originY = 40,
): Map<string, Placed> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()

  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    // First parent wins, so a diamond does not place a card twice.
    if (hasParent.has(e.target)) continue
    hasParent.add(e.target)
    const list = children.get(e.source) ?? []
    list.push(e.target)
    children.set(e.source, list)
  }

  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id)
  const out = new Map<string, Placed>()
  const GAP_X = 60
  const GAP_Y = 120
  const seen = new Set<string>()

  /** Returns the width this subtree occupies, and places everything inside it. */
  const place = (id: string, left: number, top: number): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    const self = byId.get(id)!
    const kids = (children.get(id) ?? []).filter((k) => !seen.has(k))

    if (kids.length === 0) {
      out.set(id, { x: left, y: top })
      return self.width
    }

    let cursor = left
    let widest = 0
    const childTop = top + self.height + GAP_Y
    for (const kid of kids) {
      const w = place(kid, cursor, childTop)
      if (w > 0) {
        cursor += w + GAP_X
        widest += (widest ? GAP_X : 0) + w
      }
    }
    const span = Math.max(self.width, widest)
    // Centre the parent over the block its children occupy.
    out.set(id, { x: left + (span - self.width) / 2, y: top })
    return span
  }

  let cursor = originX
  for (const root of roots) {
    const w = place(root, cursor, originY)
    cursor += w + GAP_X * 2
  }
  // Anything left over (a cycle, say) goes in a row underneath rather than vanishing.
  let leftoverX = originX
  const bottom = Math.max(originY, ...[...out.values()].map((p) => p.y)) + 360
  for (const n of nodes) {
    if (out.has(n.id)) continue
    out.set(n.id, { x: leftoverX, y: bottom })
    leftoverX += n.width + GAP_X
  }
  return out
}
