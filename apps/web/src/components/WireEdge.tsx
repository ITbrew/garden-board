import { BaseEdge, EdgeLabelRenderer, useNodes, type EdgeProps, type Node } from '@xyflow/react'
import { memo, useMemo, useSyncExternalStore } from 'react'
import { isWirePulsing, onWirePulse } from '../state'

/**
 * A wire that bows around cards instead of crossing them.
 *
 * React Flow's stock bezier draws straight through anything in the way, which makes a board of
 * twenty cards unreadable. This edge samples the cards between its endpoints and, if any sit on
 * the line, bends past the nearest free side. It is deliberately a bow rather than true
 * pathfinding: a smooth curve that clears the obstacle reads better than a maze route, and it
 * stays cheap enough to run on every render.
 */

const CLEARANCE = 34
const MAX_BOW = 420

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * The cards a wire has to get around, computed once per board change and shared by every wire.
 *
 * Each edge used to call `useNodes()` and build this list for itself, inside the same memo that
 * does the routing. `useNodes()` hands back a new array on any store change at all, so the memo was
 * invalidated by a card's status flipping, by the once-a-second token broadcast, and by every
 * pointermove of a drag.
 *
 * Two things change here. The work is done once for the whole board rather than once per wire,
 * keyed on the array React Flow just handed every edge in the same render pass. And when the
 * geometry has not actually moved, the previously built array is returned by identity, so a card
 * going from idle to busy no longer re-routes a single wire.
 *
 * Worth saying plainly: this was written expecting to find the drag freeze here, and the
 * measurement did not find it. Forty cards and thirty-nine wires, dragged through a hundred and
 * fifty pointer moves, blocked the main thread for zero milliseconds across zero long tasks on the
 * OLD code. The arithmetic that made it look expensive is real and the saving is real, but nothing
 * observed says the owner ever felt it, so this is a reduction in work and not a fix for anything.
 * An earlier draft of this file also held the last bow while a drag was in flight; that changed
 * what got drawn, bought nothing measurable, and was taken back out.
 */
let lastNodesRef: unknown = null
let lastSignature = ''
let lastRects: Rect[] = []

function obstaclesFor(nodes: readonly Node[]): Rect[] {
  if (lastNodesRef === nodes) return lastRects
  lastNodesRef = nodes

  const rects: Rect[] = []
  let signature = ''
  for (const n of nodes) {
    const w = n.measured?.width ?? (n.width as number | undefined) ?? 0
    const h = n.measured?.height ?? (n.height as number | undefined) ?? 0
    if (!w || !h) continue
    rects.push({ id: n.id, x: n.position.x, y: n.position.y, w, h })
    signature += `${n.id}:${n.position.x}:${n.position.y}:${w}:${h}|`
  }

  // Same geometry, different array. Handing back the old one keeps every routing memo cold.
  if (signature === lastSignature) return lastRects
  lastSignature = signature
  lastRects = rects
  return rects
}

/** Does the segment from a to b pass through this rectangle? Slab method, no allocations. */
function segmentHitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
  pad: number,
): boolean {
  const minX = r.x - pad
  const maxX = r.x + r.w + pad
  const minY = r.y - pad
  const maxY = r.y + r.h + pad

  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay

  for (const [p, q] of [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t0 <= t1
}

/**
 * Whether this wire has an active `wire.pulse` right now. A plain external store rather than
 * AppState, because a pulse is per-wire and re-rendering the whole board for one travelling dash
 * would be wasteful on a board with many wires.
 */
function usePulsing(wireId: string): boolean {
  return useSyncExternalStore(
    (onChange) =>
      onWirePulse((pulsedId) => {
        if (pulsedId === wireId) onChange()
      }),
    () => isWirePulsing(wireId),
    () => false,
  )
}

function WireEdgeInner(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, source, target, label, style, markerEnd, markerStart } = props
  const nodes = useNodes()
  const pulsing = usePulsing(id)

  const { path, labelX, labelY } = useMemo(() => {
    const obstacles = obstaclesFor(nodes).filter((r) => r.id !== source && r.id !== target)

    const midX = (sourceX + targetX) / 2
    const midY = (sourceY + targetY) / 2

    // A cubic with both control points pushed sideways gives the horizontal lead-out that makes
    // a connection read as leaving one card and arriving at the other, plus the vertical bow.
    const dx = Math.abs(targetX - sourceX)
    const lead = Math.max(60, Math.min(220, dx * 0.45))
    const c1x = sourceX + lead
    const c2x = targetX - lead

    /*
     * Check the curve that is actually drawn, not the straight line it was planned from.
     *
     * The bow is chosen against a straight source-to-target segment, but the path drawn has a
     * long horizontal lead-out at each end, so it can cross a card the straight line missed
     * entirely. Sampling the real curve and pushing the bow further until it is clear costs a few
     * dozen point tests and removes the whole class of wire that appears to pass behind a card.
     */
    const hits = (b: number) => {
      const c1y = sourceY + b
      const c2y = targetY + b
      for (let i = 1; i < 24; i++) {
        const t = i / 24
        const u = 1 - t
        const px = u * u * u * sourceX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * targetX
        const py = u * u * u * sourceY + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * targetY
        for (const r of obstacles) {
          if (px > r.x - 6 && px < r.x + r.w + 6 && py > r.y - 6 && py < r.y + r.h + 6) return true
        }
      }
      return false
    }

    // Find every card actually in the way, then bow past the whole group in one direction.
    const blocking = obstacles.filter((r) => segmentHitsRect(sourceX, sourceY, targetX, targetY, r, 8))

    let bow = 0
    if (blocking.length > 0) {
      let top = Infinity
      let bottom = -Infinity
      for (const r of blocking) {
        if (r.y < top) top = r.y
        if (r.y + r.h > bottom) bottom = r.y + r.h
      }
      // Go over or under, whichever is the shorter detour from the line's midpoint.
      const upDist = midY - top + CLEARANCE
      const downDist = bottom - midY + CLEARANCE
      bow = upDist <= downDist ? -upDist : downDist
      /*
       * A cubic does not pass through its control points. With both of them offset by the same
       * amount the curve only reaches three quarters of that offset at its midpoint, so a bow
       * calculated as the exact distance needed cleared the card on paper and cut through it on
       * screen. A blind reviewer described these wires as tunnelling behind two cards and
       * re-emerging at their corners, which is precisely that quarter going missing.
       */
      bow *= 4 / 3
      bow = Math.max(-MAX_BOW, Math.min(MAX_BOW, bow))
    }

    if (hits(bow)) {
      const direction = bow >= 0 ? 1 : -1
      for (let step = 1; step <= 4; step++) {
        const candidate = Math.max(-MAX_BOW, Math.min(MAX_BOW, bow + direction * step * 70))
        if (!hits(candidate)) {
          bow = candidate
          break
        }
        // Nothing clear in that direction: the other way round is usually shorter anyway.
        const mirrored = Math.max(-MAX_BOW, Math.min(MAX_BOW, -(Math.abs(bow) + step * 70) * direction))
        if (!hits(mirrored)) {
          bow = mirrored
          break
        }
      }
    }

    const c1y = sourceY + bow
    const c2y = targetY + bow

    const d = `M ${sourceX},${sourceY} C ${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`

    // Label sits at the curve's midpoint, which for this cubic is close enough to evaluate at t=0.5.
    const lx = 0.125 * sourceX + 0.375 * c1x + 0.375 * c2x + 0.125 * targetX
    const ly = 0.125 * sourceY + 0.375 * c1y + 0.375 * c2y + 0.125 * targetY

    return { path: d, labelX: lx, labelY: ly }
  }, [nodes, source, target, sourceX, sourceY, targetX, targetY])

  // A wire only carries the pulse look while a real event just fired on it. At rest it keeps
  // whatever dim style its kind already draws, so an idle wire is never mistaken for a live one.
  //
  // Every wire kind already draws some dash pattern (blind, derived, context wires are all
  // dashed by default), so widening the dash alone was indistinguishable from an ordinary wire in
  // a still screenshot. Pulsing now overrides the colour outright to a fixed bright cyan that no
  // kind uses at rest, on top of a heavier stroke and an explicit matching glow (not
  // `currentColor`, which does not track an SVG `stroke`). The travelling dash on top of that is
  // the only part that needs a live page to actually be seen moving.
  const PULSE_COLOR = '#67e8f9'
  const pulseStyle = pulsing
    ? {
        ...style,
        stroke: PULSE_COLOR,
        strokeWidth: (Number(style?.strokeWidth) || 2) + 3,
        strokeDasharray: '9 6',
        /*
         * Two shadows rather than one. The tight one makes the stroke itself read as lit; the wide
         * faint one is what carries across a room, because a 7px glow on a 5px line is invisible
         * from any distance and the owner said this was too subtle. Idle wires get neither.
         */
        filter: `drop-shadow(0 0 14px ${PULSE_COLOR}) drop-shadow(0 0 26px rgba(103, 232, 249, 0.45))`,
      }
    : style

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={pulseStyle}
        markerEnd={markerEnd}
        markerStart={markerStart}
        className={pulsing ? 'wire-pulse' : undefined}
      />
      {/*
        A bright dot that actually travels the wire, from the sender to the recipient.

        The travelling dash says something is happening; it does not say which way, and on a
        two-headed wire that is the whole question, because one wire carries both the dispatch and
        the answer coming home. The dot runs along the same `path` string the edge is drawn from, so
        it cannot drift off the curve when the routing bows around a card, and it starts at the
        source end because that is the end the event fired from.

        `animateMotion` rather than an offset-path on an HTML layer: this is already inside React
        Flow's SVG, the browser animates it off the main thread, and nothing about it causes a
        re-layout of the edge. It restarts if the path changes, which is what should happen when a
        card moves mid-pulse.
      */}
      {pulsing && (
        <circle r={5} fill={PULSE_COLOR} style={{ filter: `drop-shadow(0 0 8px ${PULSE_COLOR})` }}>
          <animateMotion dur="1s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="wire-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/**
 * Memoized, because React Flow re-renders every edge whenever anything in its store changes, and
 * an edge whose endpoints and label have not moved has nothing new to draw. Without this the
 * once-a-second card broadcast re-ran the routing for every wire on the board.
 */
export const WireEdge = memo(WireEdgeInner)
