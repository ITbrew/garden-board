import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useReactFlow, useStore, ViewportPortal } from '@xyflow/react'
import { defaultStep, parseGoal, type GoalState, type GoalStep } from '../goals'
import { actions, getGoalText, onDocChange, getLoops, onLoops } from '../state'
import './goal-ring.css'

/** Canon 26, "The goal ring". One per project tab, and a view of `TODO.md`. */
type Props = {
  projectId: string
  /** The list's text, or undefined when there is no list yet or it has not arrived. */
  text: string | undefined
  hasList: boolean
  cardTitles: string[]
}

type Placement = { x: number; y: number; size: number }

// The drawing is made at this size and scaled to the size the owner chose.
const WIDE = 300
const TALL = 300
const CX = WIDE / 2
const CY = TALL / 2
const FRAME = 146
const OUTER = 128
const INNER = 98
// A note's width on the board. It wraps at this and scrolls past its CSS height.
const NOTE_GAP = 14
const TOP = -Math.PI / 2
const FULL = 2 * Math.PI - 0.01
// About twice a default card (340 by 260).
const MINI = 520
const MINI_SMALLEST = 120
const MINI_LARGEST = 1400
// The ring shown when a tab has no goal to draw.
const EMPTY_RING = 240
const HEIGHT_PER_WIDTH = TALL / WIDE
// A square about this many pixels on screen at any zoom, so it can always be grabbed.
const GRIP_PX = 16
// About where the square at 10:00 sits, as fractions of the drawing. Dragging is measured along this line.
const GRIP_AT = { x: (CX - FRAME * Math.sin(Math.PI / 3)) / WIDE, y: (CY - FRAME * Math.cos(Math.PI / 3)) / TALL }
// The names the middle button lays out: their column's distance from the ring, width and spacing.
const NAME_REACH = 40
/** The height of a name, whose line meets it halfway up. */
const NAME_TALL = 24
/** Half a note title's line of text: how far its top stands above the line that meets it. */
const TITLE_MID = 10
/** How far a note stands from the ring, which is the flat run of its line. */
const NOTE_REACH = 56
/** The space between the end of a line and its text. */
const LINE_GAP = 8
/** How far outside the outer ring every line has gone before it turns flat. */
const CLEAR_RING = 26
const NAME_WIDE = 220
const NAME_STEP = 28
const READ_EVERY_MS = 3000
const PLACE_AFTER_MS = 1200

const pt = (cx: number, cy: number, r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)]

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = pt(cx, cy, r, a0)
  const [x1, y1] = pt(cx, cy, r, a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`
}

function span(i: number, n: number, r: number, gapPx: number): [number, number] {
  if (n <= 1) return [TOP, TOP + FULL]
  // There is no limit on how many steps a ring holds, so the gaps shrink before they can eat the arcs.
  const gap = Math.min(gapPx / r, ((2 * Math.PI) / n) * 0.3)
  return [TOP + (i / n) * 2 * Math.PI + gap / 2, TOP + ((i + 1) / n) * 2 * Math.PI - gap / 2]
}

const STATE_ORDER: Record<GoalState, number> = { done: 0, doing: 1, next: 2 }
const byProgress = <T extends { state: GoalState }>(items: T[]): T[] =>
  items.map((item, at) => ({ item, at })).sort((a, b) => STATE_ORDER[a.item.state] - STATE_ORDER[b.item.state] || a.at - b.at).map((x) => x.item)

/**
 * The rings read like a clock, so what is finished runs clockwise from 12 without gaps, then what is
 * under way, then what has not started, whatever order the file lists them in. Canon 26.
 */
function clockwise<G extends { steps: GoalStep[] }>(goal: G | null): G | null {
  if (!goal) return null
  return { ...goal, steps: byProgress(goal.steps).map((s) => ({ ...s, parts: byProgress(s.parts) })) }
}

/**
 * How far round its arc an outer step has come: the hour hand to the inner ring's minute hand. A full
 * inner ring is one whole outer arc. An under way step with nothing finished yet still shows a sliver.
 */
function reached(s: GoalStep): number {
  if (s.state === 'done') return 1
  if (s.state !== 'doing') return 0
  if (s.parts.length === 0) return 1
  return Math.max(0.08, s.parts.filter((p) => p.state === 'done').length / s.parts.length)
}

/** Where it sits on the board, in board coordinates, or null if it has not been placed yet. */
function readPlacement(projectId: string): Placement | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`garden.goalRing.board.${projectId}`) ?? 'null')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      return { x: saved.x, y: saved.y, size: typeof saved.size === 'number' ? saved.size : MINI }
    }
  } catch {
    // Blocked or cleared storage just means it gets placed again.
  }
  return null
}

/** The spot on the screen it held before it lived on the board, so placing it does not make it jump. */
function readScreenSpot(projectId: string): { x: number; y: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(`garden.goalRing.${projectId}`) ?? 'null')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return { x: saved.x, y: saved.y }
  } catch {
    // The default spot will do.
  }
  return { x: 20, y: 20 }
}

function savePlacement(projectId: string, p: Placement): void {
  try {
    localStorage.setItem(`garden.goalRing.board.${projectId}`, JSON.stringify(p))
  } catch {
    // The ring still works; it forgets its place on reload.
  }
}

/** A fault in the ring loses the ring. The board underneath it keeps running. */
class RingGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: Error) {
    console.error('[garden] the goal ring failed:', err.message)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** One ring per project, with its own state: switching tabs never carries one goal's view to another. */
export function GoalRingLayer({ projectId, cards }: { projectId: string; cards: { title: string }[] }) {
  const [, setTick] = useState(0)
  useEffect(() => onDocChange(() => setTick((n) => n + 1)), [])
  // Follows the file: a card edits it with its own tools and the ring shows that within seconds.
  useEffect(() => {
    actions.readGoal(projectId)
    const every = window.setInterval(() => {
      if (document.visibilityState === 'visible') actions.readGoal(projectId)
    }, READ_EVERY_MS)
    return () => window.clearInterval(every)
  }, [projectId])
  const text = getGoalText(projectId)
  const key = cards.map((c) => c.title).join('\n')
  const cardTitles = useMemo(() => cards.map((c) => c.title), [key])
  return (
    <RingGuard key={projectId}>
      <GoalRing projectId={projectId} text={text ?? undefined} hasList={typeof text === 'string'} cardTitles={cardTitles} />
    </RingGuard>
  )
}

function GoalRing({ projectId, text, hasList, cardTitles }: Props) {
  const flow = useReactFlow()
  const zoomNow = useStore((s) => s.transform[2])
  const boardBox = useStore((s) => s.domNode)
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<number | null>(null)
  const [part, setPart] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const [hover, setHover] = useState<{ kind: 'step' | 'part'; i: number } | null>(null)
  const [place, setPlace] = useState<Placement | null>(() => readPlacement(projectId))
  const dragged = useRef(false)

  const goal = useMemo(() => (text === undefined ? null : clockwise(parseGoal(text, cardTitles))), [text, cardTitles])
  const stepIndex = goal ? (chosen !== null && chosen < goal.steps.length ? chosen : defaultStep(goal)) : 0
  const step: GoalStep | null = goal ? goal.steps[stepIndex] : null
  const n = goal?.steps.length ?? 0

  useEffect(() => {
    if (!open && !all) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPart(null)
        setAll(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, all])

  /*
   * The first time this tab's ring is drawn, it takes the board position under the spot it held on the
   * screen. The wait lets the tab's camera settle first, because the same spot on the screen is a
   * different place on the board until it has.
   */
  useEffect(() => {
    if (place) return
    const wait = window.setTimeout(() => {
      const spot = readScreenSpot(projectId)
      const box = boardBox?.getBoundingClientRect()
      const at = flow.screenToFlowPosition({ x: (box?.left ?? 0) + spot.x, y: (box?.top ?? 0) + spot.y })
      const placed = { x: at.x, y: at.y, size: MINI }
      setPlace(placed)
      savePlacement(projectId, placed)
    }, PLACE_AFTER_MS)
    return () => window.clearTimeout(wait)
  }, [place, projectId, flow, boardBox])

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    dragged.current = false
    if (!place || e.button !== 0) return
    const zoom = flow.getZoom()
    const startX = e.clientX
    const startY = e.clientY
    const from = place
    let latest = from
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragged.current && Math.hypot(dx, dy) < 4) return
      dragged.current = true
      latest = { ...from, x: from.x + dx / zoom, y: from.y + dy / zoom }
      setPlace(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (dragged.current) savePlacement(projectId, latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /*
   * Dragging the square at 10:00 resizes the ring with its far corner held still. The size change is
   * the pointer's travel measured along the line from that corner to the square, so the square stays
   * under the pointer.
   */
  const startResize = (e: React.PointerEvent<HTMLElement>) => {
    if (!place || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const zoom = flow.getZoom()
    const startX = e.clientX
    const startY = e.clientY
    const from = place
    const lineX = GRIP_AT.x - 1
    const lineY = (GRIP_AT.y - 1) * HEIGHT_PER_WIDTH
    const length = lineX * lineX + lineY * lineY
    let latest = from
    const move = (ev: PointerEvent) => {
      const travel = (((ev.clientX - startX) * lineX + (ev.clientY - startY) * lineY) / length) / zoom
      const size = Math.max(MINI_SMALLEST, Math.min(MINI_LARGEST, from.size + travel))
      latest = { x: from.x + from.size - size, y: from.y + (from.size - size) * HEIGHT_PER_WIDTH, size }
      setPlace(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      savePlacement(projectId, latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The end of a drag is also a click, and it must not open whatever the pointer stopped on.
  const swallowDragClick = (e: React.MouseEvent) => {
    if (dragged.current) e.stopPropagation()
  }

  const closeNote = () => {
    setOpen(false)
    setPart(null)
  }

  // An outer arc's note. Pressing the arc whose note is showing closes it, and its sub-goal's with it.
  const pickStep = (i: number) => {
    if (open && i === stepIndex) return closeNote()
    setChosen(i)
    setPart(null)
    setOpen(true)
    setHover(null)
  }

  // An inner arc's note. A step with no sub-goals draws one inner arc, which stands for the step.
  const pickPart = (j: number) => {
    if (!step?.parts[j]) return pickStep(stepIndex)
    if (open && part === j) {
      setPart(null)
      return
    }
    setPart(j)
    setOpen(true)
    setHover(null)
  }

  const outerStates = goal?.steps.map((s) => s.state) ?? []
  const innerStates = step?.parts.map((p) => p.state) ?? (step ? [step.state] : [])
  const inner: GoalState[] = innerStates.length > 0 ? innerStates : step ? [step.state] : []

  /*
   * Where each open note's title stands, so its line can end there. Measured, because a note's height
   * depends on its text and a sub-goal's note can be stacked under its goal's.
   */
  const openBox = useRef<HTMLDivElement>(null)
  // The rings tutorial points at the ring, so it brings the ring on screen when it is panned away.
  useEffect(() => {
    const show = () => {
      if (place) flow.setCenter(place.x + place.size / 2, place.y + place.size / 2, { zoom: flow.getZoom(), duration: 300 })
    }
    window.addEventListener('garden:show-ring', show)
    return () => window.removeEventListener('garden:show-ring', show)
  }, [place, flow])
  // The ring's right-click menu (canon 25). On the page rather than in the board's scaled layer.
  const [menu, setMenu] = useState<MenuState | null>(null)
  const loops = useSyncExternalStore(onLoops, () => getLoops(projectId))
  const ringLoop = loops?.find((l) => l.followsRing)
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    window.dispatchEvent(new Event('garden:ring-menu'))
    const running = !!ringLoop?.enabled
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: running ? 'Loop running' : ringLoop?.stoppedBy === 'disabled' ? 'Loop disabled' : ringLoop?.stoppedBy === 'owner' ? 'Loop paused' : 'No loop running', disabled: true },
        { separator: true },
        { label: 'Start', disabled: running || !goal, hint: 'Run until the ring is full', onSelect: () => actions.ringControl(projectId, 'start') },
        { label: 'Pause', disabled: !running, hint: 'Hold it until you press Start', onSelect: () => actions.ringControl(projectId, 'pause') },
        { label: 'Disable', disabled: ringLoop?.stoppedBy === 'disabled', hint: 'Off for this tab. Cards still do mail', onSelect: () => actions.ringControl(projectId, 'disable') },
      ],
    })
  }
  const heldByHand = !!ringLoop && !ringLoop.enabled && (ringLoop.stoppedBy === 'owner' || ringLoop.stoppedBy === 'disabled' || ringLoop.stoppedBy === 'stuck')
  const [noteEnds, setNoteEnds] = useState<{ kind: 'step' | 'part'; i: number; x: number; y: number }[]>([])
  useLayoutEffect(() => {
    const box = openBox.current
    const ends = !box
      ? []
      : [...box.querySelectorAll<HTMLElement>('[data-arc]')].map((note) => {
          const [kind, i] = (note.dataset.arc as string).split(':')
          const origin = box.getBoundingClientRect()
          const heading = note.querySelector('h3') ?? note
          const title = heading.getBoundingClientRect()
          const onRight = title.left >= origin.left + origin.width / 2
          // The note is scaled, so its own measures are converted to the screen's.
          const toScreen = heading.offsetHeight > 0 ? title.height / heading.offsetHeight : 1
          const gap = LINE_GAP * toScreen
          const firstLine = (parseFloat(getComputedStyle(heading).lineHeight) || 21) * toScreen
          return {
            kind: kind as 'step' | 'part',
            i: Number(i),
            x: ((onRight ? title.left - gap : title.right + gap) - origin.left) / zoomNow,
            y: (title.top + firstLine / 2 - origin.top) / zoomNow,
          }
        })
    setNoteEnds((was) => (JSON.stringify(was) === JSON.stringify(ends) ? was : ends))
  })

  if (!place) return null

  const scale = place.size / WIDE
  // Text beside the ring grows with the ring, and is at least its normal size on screen at any zoom.
  const textScale = Math.max(place.size / MINI, 1 / zoomNow)
  const nameStep = NAME_STEP * textScale
  const nameReach = NAME_REACH * textScale
  // Just outside the outer ring at 10:00, whatever the size and zoom: its inner corner clears the arcs.
  const gripRadius = (OUTER + 6) * scale + ((GRIP_PX * 0.75 + 3) / zoomNow)
  const gripAt = {
    x: place.size / 2 - gripRadius * Math.sin(Math.PI / 3),
    y: place.size / 2 - gripRadius * Math.cos(Math.PI / 3),
  }
  const tall = place.size * HEIGHT_PER_WIDTH
  const progressOf = (s: GoalStep) => `${s.parts.filter((p) => p.state === 'done').length} of ${s.parts.length} sub-goals done`

  /*
   * Every arc's name in a column beside the ring, for the middle button. Each side is laid out from the
   * top and pushed down as needed, so a tab with many short arcs still reads as a list rather than a pile.
   */
  const arcPoint = (kind: 'step' | 'part', i: number, radius: number) => {
    const count = kind === 'step' ? n : Math.max(inner.length, 1)
    const angle = TOP + ((i + 0.5) / Math.max(count, 1)) * 2 * Math.PI
    const [x, y] = pt(CX, CY, radius, angle)
    return { x: x * scale, y: y * scale, right: Math.cos(angle) >= 0, below: Math.sin(angle) >= 0 }
  }
  /* The height where a line from an arc, going out at 45 degrees, has cleared the outside of the ring. */
  const flatAt = (at: ReturnType<typeof arcPoint>) => {
    const middle = place.size / 2
    const clear = (OUTER + CLEAR_RING) * scale
    const ax = at.x - middle
    const ay = at.y - middle
    const down = at.below ? 1 : -1
    const along = ax * (at.right ? 1 : -1) + ay * down
    return at.y + (down * (-along + Math.sqrt(along * along - 2 * (ax * ax + ay * ay - clear * clear)))) / 2
  }
  /* A line from an arc to where its text's flat line starts: out at an angle, then flat. */
  const elbow = (at: ReturnType<typeof arcPoint>, x: number, y: number) => {
    const out = x >= at.x ? 1 : -1
    const kneeX = at.x + out * Math.min(Math.abs(y - at.y), Math.abs(x - at.x))
    return `${at.x.toFixed(1)},${at.y.toFixed(1)} ${kneeX.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`
  }
  const nameTall = NAME_TALL * textScale
  // One pixel on screen, however far the board is zoomed out.
  const lineWidth = textScale
  const names = !all || !goal || !step
    ? []
    : (['right', 'left'] as const).flatMap((side) => {
        const arcs = [
          ...goal.steps.map((s, i) => ({ kind: 'step' as const, i, label: s.label, state: s.state, at: arcPoint('step', i, OUTER) })),
          ...step.parts.map((p, i) => ({ kind: 'part' as const, i, label: p.label, state: p.state, at: arcPoint('part', i, INNER) })),
        ]
          .filter((a) => a.at.right === (side === 'right'))
          .sort((a, b) => flatAt(a.at) - flatAt(b.at))
        let last = -Infinity
        return arcs.map((a) => {
          last = Math.max(flatAt(a.at) - nameTall / 2, last + nameStep)
          return { ...a, side, top: last }
        })
      })

  /*
   * A note stands outside the ring so the circle is never covered: beside its name when the names are
   * out, and otherwise in a column beside the ring, level with its arc. It sits on the board
   * rather than in the drawing, so its text stays readable however small the circle has been made.
   */
  const noteAt = (kind: 'step' | 'part', i: number): React.CSSProperties => {
    const named = names.find((a) => a.kind === kind && a.i === i)
    if (named) {
      const reach = nameReach + (NAME_WIDE + NOTE_GAP) * textScale
      return {
        ...(named.side === 'right' ? { left: place.size + reach } : { right: place.size + reach }),
        top: named.top + (NAME_TALL / 2 - TITLE_MID) * textScale,
        textAlign: named.side === 'right' ? 'left' : 'right',
        transform: `scale(${textScale})`,
        transformOrigin: named.side === 'right' ? 'left top' : 'right top',
      }
    }
    const at = arcPoint(kind, i, kind === 'step' ? OUTER : INNER)
    const { right } = at
    return {
      ...(right ? { left: place.size + NOTE_REACH * textScale } : { right: place.size + NOTE_REACH * textScale }),
      top: flatAt(at) - TITLE_MID * textScale,
      textAlign: right ? 'left' : 'right',
      transform: `scale(${textScale})`,
      transformOrigin: `${right ? 'left' : 'right'} top`,
    }
  }

  // The hover hint, unless that arc's own note is already showing.
  const hintFor = () => {
    if (!hover || !goal || !step) return null
    if (hover.kind === 'step') {
      const s = goal.steps[hover.i]
      if (!s || (open && hover.i === stepIndex)) return null
      return { kind: hover.kind, i: hover.i, state: s.state, title: s.label, lines: [s.owner, s.parts.length > 0 ? progressOf(s) : ''].filter(Boolean) as string[] }
    }
    const p = step.parts[hover.i]
    if (open && part === hover.i) return null
    if (!p) return { kind: hover.kind, i: hover.i, state: step.state, title: step.label, lines: step.doneWhen ? [`Done when: ${step.doneWhen}`] : [] }
    return { kind: hover.kind, i: hover.i, state: p.state, parent: step.label, title: p.label, lines: [p.description, p.doneWhen ? `Done when: ${p.doneWhen}` : 'No exit written yet.'].filter(Boolean) as string[] }
  }
  // With no background a hint would print over an open note, so it does not open on that note's side.
  const hintAsked = hintFor()
  const hint = hintAsked && open && arcPoint(hintAsked.kind, hintAsked.i, FRAME).right === arcPoint('step', stepIndex, FRAME).right ? null : hintAsked

  // A sub-goal's note, which opens with its goal's: one stack on one side, or one on each.
  const openPart = open && step && part !== null ? step.parts[part] : undefined
  const partBesideGoal = part !== null && arcPoint('part', part, FRAME).right === arcPoint('step', stepIndex, FRAME).right
  const partNote = openPart && (
    <div className="goal-ring__note nowheel" data-arc={`part:${part}`}>
      <p className="goal-ring__parent">{step?.label}</p>
      <h3 className={`is-${openPart.state}`}>{openPart.label}</h3>
      {openPart.description && <p>{openPart.description}</p>}
      <p className="goal-ring__done-when">{openPart.doneWhen ? `Done when: ${openPart.doneWhen}` : 'No exit written yet.'}</p>
    </div>
  )

  return (
    <ViewportPortal>
    <div className="goal-ring">
      {!goal && (
        <div className={`goal-ring__blip-wrap nopan ${heldByHand ? 'is-held' : ''}`} onContextMenu={openMenu} style={{ left: place.x, top: place.y, width: EMPTY_RING, height: EMPTY_RING }}>
          <button
            className="goal-ring__blip"
            aria-label="Goal: none yet"
            title="No goal yet"
            onPointerDown={startDrag}
            onClick={() => {
              if (!dragged.current) setOpen(!open)
            }}
          >
            <svg width={EMPTY_RING} height={EMPTY_RING} viewBox="0 0 190 190" aria-hidden="true">
              <circle className="goal-ring__frame" cx="95" cy="95" r="94" />
              <circle className="goal-ring__mini-empty" cx="95" cy="95" r="82" />
            </svg>
            <span className="goal-ring__blip-count" style={{ fontSize: EMPTY_RING * 0.154 }}>+</span>
          </button>
        </div>
      )}

      {open && !goal && (
        <section className="goal-ring__panel goal-ring__panel--empty nopan" style={{ left: place.x + EMPTY_RING + 8, top: place.y }} onPointerDown={startDrag} onClickCapture={swallowDragClick}>
          <h2>No goal yet</h2>
          {hasList ? (
            <p>This tab's TODO.md has no goals yet. Its orchestrator writes them.</p>
          ) : (
            <button className="goal-ring__create" onClick={() => { actions.createGoal(projectId); setOpen(false) }}>
              Create TODO.md
            </button>
          )}
          <button className="goal-ring__close-text" onClick={() => setOpen(false)}>
            Close
          </button>
        </section>
      )}

      {goal && step && (
        <div ref={openBox} className={`goal-ring__open nopan ${heldByHand ? 'is-held' : ''}`} style={{ left: place.x, top: place.y, width: place.size, height: place.size * HEIGHT_PER_WIDTH }}>
          {!open && (
            <span
              className="goal-ring__grip"
              role="separator"
              aria-label="Resize"
              title="Drag to resize"
              style={{
                width: GRIP_PX / zoomNow,
                height: GRIP_PX / zoomNow,
                left: gripAt.x - GRIP_PX / zoomNow / 2,
                top: gripAt.y - GRIP_PX / zoomNow / 2,
              }}
              onPointerDown={startResize}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 12V6a2 2 0 0 1 2-2h6" />
              </svg>
            </span>
          )}
          <div
            className="goal-ring__disc"
            style={{ width: place.size, height: place.size * HEIGHT_PER_WIDTH }}
            onPointerDown={startDrag}
            onClickCapture={swallowDragClick}
            onContextMenu={openMenu}
          >
          <div className="goal-ring__drawing" style={{ width: WIDE, height: TALL, transform: `scale(${place.size / WIDE})` }}>
            <svg width={WIDE} height={TALL} viewBox={`0 0 ${WIDE} ${TALL}`} role="img" aria-label={`${goal.title}: ${goal.done} of ${n} goals done`}>
              <circle className="goal-ring__frame" cx={CX} cy={CY} r={FRAME} />
              {inner.map((s, i) => {
                const [a0, a1] = span(i, inner.length, INNER, 10)
                const d = arc(CX, CY, INNER, a0, a1)
                return (
                  <g
                    key={`p${i}`}
                    className="goal-ring__seg"
                    role="button"
                    tabIndex={0}
                    aria-label={`${step.parts[i]?.label ?? step.label}: open its note`}
                    onClick={() => pickPart(i)}
                    onMouseEnter={() => setHover({ kind: 'part', i })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ kind: 'part', i })}
                    onBlur={() => setHover(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pickPart(i)
                      }
                    }}
                  >
                    <path className="goal-ring__hit" d={arc(CX, CY, INNER, ...span(i, inner.length, INNER, 2))} strokeWidth={24} />
                    <path className={`goal-ring__bar is-${s}`} d={d} strokeWidth={part === i ? 6 : 4} />
                  </g>
                )
              })}

              {goal.steps.map((s, i) => {
                const [a0, a1] = span(i, n, OUTER, 11)
                const d = arc(CX, CY, OUTER, a0, a1)
                const isActive = i === stepIndex
                const partly = s.state === 'doing' && reached(s) < 1
                return (
                  <g
                    key={s.line}
                    className="goal-ring__seg"
                    data-ring="goal"
                    role="button"
                    tabIndex={0}
                    aria-label={`${s.label}: open its note`}
                    onClick={() => pickStep(i)}
                    onMouseEnter={() => setHover({ kind: 'step', i })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ kind: 'step', i })}
                    onBlur={() => setHover(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pickStep(i)
                      }
                    }}
                  >
                    <path className="goal-ring__hit" d={arc(CX, CY, OUTER, ...span(i, n, OUTER, 2))} strokeWidth={24} />
                    <path className={`goal-ring__bar is-${partly ? 'next' : s.state} ${isActive ? 'is-active' : ''}`} d={d} strokeWidth={isActive ? 7 : 5} />
                    {partly && <path className={`goal-ring__fill goal-ring__bar is-doing`} d={arc(CX, CY, OUTER, a0, a0 + (a1 - a0) * reached(s))} strokeWidth={isActive ? 7 : 5} />}
                  </g>
                )
              })}
            </svg>
            <button
              className="goal-ring__center"
              aria-label={all ? 'Hide every goal' : 'Show every goal'}
              aria-expanded={all}
              title={all ? 'Hide every goal' : 'Show every goal'}
              onClick={() => {
                if (all) closeNote()
                setAll(!all)
              }}
            >
              <span className="goal-ring__count">{goal.done}/{n}</span>
            </button>
          </div>
          </div>

          {(names.length > 0 || noteEnds.length > 0) && (
            <svg className="goal-ring__leaders" width={place.size} height={tall} aria-hidden="true">
              {names.length === 0 &&
                noteEnds.map((e) => {
                  const from = arcPoint(e.kind, e.i, e.kind === 'step' ? OUTER : INNER)
                  return <polyline key={`note-${e.kind}${e.i}`} className="goal-ring__lead" strokeWidth={lineWidth} points={elbow(from, e.x, e.y)} />
                })}
              {names.map((a) => (
                <polyline
                  key={`${a.kind}${a.i}`}
                  className={`goal-ring__lead is-${a.state}`}
                  strokeWidth={lineWidth}
                  points={elbow(a.at, a.side === 'right' ? place.size + nameReach - LINE_GAP * textScale : -nameReach + LINE_GAP * textScale, a.top + nameTall / 2)}
                />
              ))}
            </svg>
          )}
          {names.map((a) => {
            const picked = open && (a.kind === 'part' ? part === a.i : a.i === stepIndex)
            return (
              <button
                key={`${a.kind}${a.i}`}
                className={`goal-ring__name is-${a.kind} ${picked ? 'is-picked' : ''}`}
                style={{
                  width: NAME_WIDE,
                  height: NAME_TALL,
                  top: a.top,
                  transform: `scale(${textScale})`,
                  transformOrigin: a.side === 'right' ? 'left top' : 'right top',
                  justifyContent: a.side === 'right' ? 'flex-start' : 'flex-end',
                  ...(a.side === 'right' ? { left: place.size + nameReach } : { right: place.size + nameReach }),
                }}
                onClick={() => (a.kind === 'step' ? pickStep(a.i) : pickPart(a.i))}
              >
                <span className={`goal-ring__row-label is-${a.state}`}>{a.label}</span>
              </button>
            )
          })}

          {open && (
            <>
              <div className="goal-ring__notes" style={noteAt('step', stepIndex)}>
                <div className="goal-ring__note nowheel" data-arc={`step:${stepIndex}`}>
                  <h3 className={`is-${step.state}`}>{step.label}</h3>
                  {step.owner && <p className="goal-ring__section-owner">{step.owner}</p>}
                  {step.description && <p>{step.description}</p>}
                  {step.doneWhen && <p className="goal-ring__done-when">Done when: {step.doneWhen}</p>}
                  {!step.description && !step.doneWhen && step.parts.length === 0 && <p className="goal-ring__done-when">No definition written yet.</p>}
                  {step.parts.length > 0 && <p className="goal-ring__done-when">{progressOf(step)}</p>}
                </div>
                {openPart && partBesideGoal && partNote}
              </div>
              {openPart && !partBesideGoal && (
                <div className="goal-ring__notes" style={noteAt('part', part as number)}>
                  {partNote}
                </div>
              )}
            </>
          )}

          {hint && (
            <div className="goal-ring__note goal-ring__note--hint" data-arc={`${hint.kind}:${hint.i}`} style={noteAt(hint.kind, hint.i)}>
              {'parent' in hint && hint.parent && <p className="goal-ring__parent">{hint.parent}</p>}
              <h3 className={`is-${hint.state}`}>{hint.title}</h3>
              {hint.lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    {createPortal(<ContextMenu state={menu} onClose={() => setMenu(null)} />, document.body)}
    </ViewportPortal>
  )
}
