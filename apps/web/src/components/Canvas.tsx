import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeChange,
  type Edge,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  actions,
  contextColumnsOpen,
  getDocContent,
  getLoops,
  onDocChange,
  onLoops,
  getContextList,
  getHistoryGroups,
  getPipelineAt,
  onContextList,
  onHistoryGroups,
  useApp,
} from '../state'
import { SessionNode, type SessionNodeData } from './SessionNode'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { DocNode, type DocNodeData } from './DocNode'
import { ChannelNode, type ChannelNodeData } from './ChannelNode'
import { ColumnHeader, type ColumnHeaderData } from './ColumnHeader'
import { WireEdge } from './WireEdge'
import { WebFrame, type WebFrameData } from './WebFrame'
import { PipelineNode, type PipelineNodeData } from './PipelineNode'
import { TodoBar, type TodoBarData } from './TodoBar'
import { loopPromptFor, parseTodo, progressOf, setDone, type TodoItem } from '../todo'
import { RefusalPill, type RefusalPillData } from './RefusalPill'
import { onTasks, refusalsForCard } from '../tasks'
import { NewCardForm, type NewCardRequest } from './NewCardForm'
import { NewDocForm, type NewDocRequest } from './NewDocForm'
import { COLLAPSED_H, packCards, shouldAutoPack } from '../layout'
import { BOARD, FRAME_HEADROOM, cardIsOff, drawnOnBoard } from '@garden/shared'
import { FirstRun } from './FirstRun'
import { markFirstRun } from '../firstrun'


/**
 * Which dot a wire leaves from and arrives at. One meaning per side, always.
 *
 * Bottom is the files a session runs from. Top is its history. Left and right are connections to
 * other sessions and agents, and nothing else may use them.
 *
 * A file never uses the sides, whatever kind of wire reaches it. A document is not a peer of a
 * session and cannot talk to one: it either hangs below the card that runs from it or above the
 * card that just produced it, so any wire touching a document is routed to a belongs-to dot even
 * if it was drawn by hand. That keeps file traffic out of the lane the agents talk in.
 *
 * Between two sessions the wire takes whichever side faces the other card. Both sides mean the
 * same thing, so this changes nothing about what a wire says; it stops a wire leaving the right
 * edge and doubling back around its own card to reach something on the left, which was a large
 * share of the crossings on a laid-out board.
 */
function handlesFor(
  w: { kind: string; sourceId: string; targetId: string },
  isDoc: (id: string) => boolean,
  geo: Map<string, { x: number; y: number; w: number; h: number }>,
): { sourceHandle: string; targetHandle: string } {
  // A turn's evidence hangs off its right, which is the one side a document card ever uses.
  if (w.kind === 'evidence') return { sourceHandle: 'evidence', targetHandle: 'evidenceIn' }
  if (w.kind === 'history') return { sourceHandle: 'history', targetHandle: 'ownerBelow' }
  if (w.kind === 'context' || isDoc(w.targetId)) {
    return { sourceHandle: 'context', targetHandle: 'owner' }
  }
  // A document as the SOURCE is the same relationship read backwards, so it lands the same way.
  if (isDoc(w.sourceId)) return { sourceHandle: 'context', targetHandle: 'owner' }

  /*
   * The side facing the other card, which is how the meaning stays put while the geometry moves.
   *
   * Left means "made by" and right means "its agents" only while a family grows rightward. The web
   * arrangement grows departments in every direction, so a card can sit to the left of its maker,
   * and there the two dots swap: the side pointing back at the maker is the maker's side wherever
   * that happens to be. The card's own labels swap with it, so a dot and the label beside it can
   * never claim opposite things.
   *
   * Two cards stacked nearly vertically fall back to the default rather than flipping on a pixel,
   * because a wire that changes sides while a card is nudged reads as a fault.
   */
  const a = geo.get(w.sourceId)
  const b = geo.get(w.targetId)
  if (a && b) {
    const gap = b.x + b.w / 2 - (a.x + a.w / 2)
    if (gap < -Math.max(a.w, b.w) / 2) return { sourceHandle: 'outLeft', targetHandle: 'inRight' }
  }
  return { sourceHandle: 'out', targetHandle: 'in' }
}

/**
 * The board's grid pitch, in canvas units.
 *
 * One number doing two jobs: the dots are drawn at it and cards snap to it. It was 22 as a purely
 * visual choice and stays 22, so nothing already placed jumps when this ships.
 */
const GRID = 22

const nodeTypes = {
  session: SessionNode,
  doc: DocNode,
  channel: ChannelNode,
  columnHeader: ColumnHeader,
  todoBar: TodoBar,
  webFrame: WebFrame,
  pipeline: PipelineNode,
  refusalPill: RefusalPill,
}

/** A pipeline panel is one fixed-size surface about one card, so its box is a constant. */
const PIPE_W = 1000
const PIPE_H = 620
/** Prefix on the panel's node id, so the canvas can tell one from a real card in every handler. */
const PIPE_ID = 'pipe:'
// One edge type: a wire that bows around cards rather than crossing them.
const edgeTypes = { wire: WireEdge }
/** How long a just-requested card is watched for before giving up on panning to it. */
const PENDING_CREATE_MS = 6000

function CanvasInner() {
  const sessions = useApp((s) => s.sessions)
  const docs = useApp((s) => s.docs)
  const channels = useApp((s) => s.channels)
  const projects = useApp((s) => s.projects)
  const wires = useApp((s) => s.wires)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const focused = useApp((s) => s.focused)
  const pipelineOpen = useApp((s) => s.pipelineOpen)
  const profiles = useApp((s) => s.profiles)
  const defaultAccount = useApp((s) => s.defaultAccount)
  const { fitView, setViewport, screenToFlowPosition, setCenter, getZoom } = useReactFlow()

  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /*
   * What the board draws, which is `drawnOnBoard` in @garden/shared and nothing written here.
   *
   * Closed cards are off the board and in the sidebar's closed list instead. Filtered here rather
   * than left out of the snapshot, because the sidebar needs the same rows in order to list them
   * and to offer to bring one back.
   *
   * A dispatched agent is a row in its parent's Subagents / Tools list and nowhere else. The card
   * still exists, is still created on SubagentStart, still holds its transcript path, and is still
   * reachable by every server route that reads one. Only the canvas stops drawing it. The owner's
   * words for what was wrong: "i just dont want the subagent mini cards spawned everytime u use a
   * throwaway, id rather see those stored in Subagents / Tools collapsible ui so its less messy". A
   * day's work had left fifteen cards he could not tell apart, each a record of something that had
   * already finished.
   *
   * Deliberately not done in `ingest.ts` by ceasing to create the card. That version was surveyed
   * and held: five routes to a dispatch's conversation go through the card, three of them in the
   * server, and removing the card makes every transcript after it unopenable while the bytes sit on
   * disk. Keeping the card and not drawing it is the whole of what was asked for and costs none of
   * that.
   *
   * A teammate is not filtered. It is a peer session the owner can talk to, not a throwaway, and it
   * belongs on the board.
   */
  const visSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          /*
           * The same predicate the server lays cards out with, imported rather than written twice.
           *
           * It used to be written here as `closedAt === null && kind !== 'subagent'` and separately
           * not written at all in the server's `occupiedRects`, which took every row on the project.
           * So the board drew three cards, the layout avoided 24 rectangles, and a card dragged into
           * space he could see was empty was pushed away by spent agents and parked cards. One
           * definition, in `@garden/shared`, is what stops that returning.
           */
          drawnOnBoard(s) && (!activeProjectId || s.projectId === activeProjectId),
      ),
    [sessions, activeProjectId],
  )
  const visDocs = useMemo(
    () => docs.filter((d) => !activeProjectId || d.projectId === activeProjectId),
    [docs, activeProjectId],
  )

  // Sessions first, then documents, so a card never jumps kind-order as things open.
  const all = useMemo(
    () => [
      ...visSessions.map((s) => ({ kind: 'session' as const, item: s })),
      ...visDocs.map((d) => ({ kind: 'doc' as const, item: d })),
    ],
    [visSessions, visDocs],
  )

  /*
   * Cards whose roots are unfolded as columns, and the scan behind each one.
   *
   * `onContextList` fires both when a list arrives and when a card is put into or taken out of
   * columns mode, so one subscription covers both and the columns appear as soon as the answer
   * does.
   */
  const [contextTick, setContextTick] = useState(0)
  useEffect(() => onContextList(() => setContextTick((n) => n + 1)), [])
  const sessionsWithColumns = useMemo(
    () => visSessions.filter((s) => contextColumnsOpen(s.id)).map((s) => s.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visSessions, contextTick],
  )
  const contextByCard = useMemo(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof getContextList>>>()
    for (const id of sessionsWithColumns) {
      const l = getContextList(id)
      if (l) m.set(id, l)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsWithColumns, contextTick])

  /*
   * The days each card has a history for, kept the same way its roots columns are.
   *
   * A card is in this map once its arrow has been pressed and the server has answered, and it stays
   * until the whole web is folded away. Which days are actually on the board comes from the same
   * answer rather than from counting cards, so a day whose turns are open shows its real header
   * instead of a pill and never both.
   */
  const [historyTick, setHistoryTick] = useState(0)
  useEffect(() => onHistoryGroups(() => setHistoryTick((n) => n + 1)), [])
  const historyByCard = useMemo(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof getHistoryGroups>>>()
    for (const s of visSessions) {
      const g = getHistoryGroups(s.id)
      if (g) m.set(s.id, g)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visSessions, historyTick])

  /*
   * What ownership refused, or would have refused, per card.
   *
   * A counter and a `useMemo` rather than a subscription per card, for the reason spelled out on
   * `onTasks`: `refusalsForCard` builds an array when it has something to return, and a fresh array
   * as a `useSyncExternalStore` snapshot re-renders for ever. This is the same shape `historyTick`
   * above already uses, and the map is built once per change rather than once per card per render.
   */
  const [refusalTick, setRefusalTick] = useState(0)
  useEffect(() => onTasks(() => setRefusalTick((n) => n + 1)), [])
  const refusalsByCard = useMemo(() => {
    const m = new Map<string, ReturnType<typeof refusalsForCard>>()
    for (const s of visSessions) {
      const rows = refusalsForCard(s.id)
      if (rows.length) m.set(s.id, rows)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visSessions, refusalTick])

  /*
   * Which sessions already have their roots unfolded, so the dot can offer to fold them.
   *
   * Either state counts: columns showing with no files opened yet, or files on the board. Both are
   * "unfolded" as far as the owner is concerned, and a dot that offered to open again while columns
   * were already on screen would do nothing visible.
   */
  const contextOwners = useMemo(
    () =>
      new Set([
        ...visDocs.filter((d) => d.web === 'context' && d.ownerId).map((d) => d.ownerId!),
        ...sessionsWithColumns,
      ]),
    [visDocs, sessionsWithColumns],
  )

  /**
   * And the same for history, so its arrow can fold as well as unfold.
   *
   * Both states count, exactly as they do for roots above: turn cards on the board, or a row of day
   * pills with no day opened yet. Counting only the cards was why history could not be folded away.
   * The first press asks for the days and draws pills rather than cards, so this set stayed empty,
   * the arrow went on reading "History", and the second press asked for the days again instead of
   * folding. From the owner's side the control simply did not close anything.
   */
  const historyOwners = useMemo(
    () =>
      new Set([
        ...visDocs.filter((d) => d.web === 'history' && d.ownerId).map((d) => d.ownerId!),
        ...historyByCard.keys(),
      ]),
    [visDocs, historyByCard],
  )

  const auto = shouldAutoPack(all.map((c) => c.item))

  /**
   * Three sizes: the card's own, a working size big enough to read a terminal in, and the whole
   * workspace. Full is measured from the actual viewport rather than a guessed constant, so it
   * really does fill the space on any window.
   */
  const sizeOf = (s: { size?: 'normal' | 'large' | 'full'; width: number; height: number }) => {
    /*
     * Both presets now come off the stored row, because the server places a card's webs from that
     * row and a card drawn at a size the server never heard about has its roots placed against an
     * edge it does not have. Full is worked out here when the button is pressed and sent, so by the
     * time it is drawn the stored box is the right one.
     */
    if (s.size === 'large') return { width: BOARD.LARGE_W, height: BOARD.LARGE_H }
    return { width: s.width, height: s.height }
  }

  const packed = useMemo(() => {
    if (!auto) return []
    return packCards(
      all.map((c) => {
        if (c.item.collapsed) return { width: c.item.width, height: COLLAPSED_H }
        const d = sizeOf(c.item)
        return { width: d.width, height: d.height }
      }),
      box.w,
    )
  }, [auto, all, box.w, box.h])

  /*
   * There used to be a set of "mirrored" cards here: the ones whose maker sits to their right,
   * which made a card's two side labels swap so that the left one always read "Made by".
   *
   * Both sides are spawn points now and they say the same thing, so there is nothing left to swap.
   * The direction of a relationship is carried by the wire's own arrowheads and label, which is
   * where it is actually known; a side of a card was never able to carry it, because a card that
   * hired this one and a card this one hired can sit on the same side.
   */

  const computed: Node[] = useMemo(
    () =>
      all.map((c, i) => {
        const p = packed[i]
        const position = p ? { x: p.x, y: p.y } : { x: c.item.x, y: c.item.y }
        if (c.kind === 'session') {
          const dim = sizeOf(c.item)
          return {
            id: c.item.id,
            type: 'session',
            position,
            data: {
              session: c.item,
              project: projects.find((p) => p.id === c.item.projectId),
              account:
                profiles.find((p) => p.id === c.item.profileId)?.accountEmail ??
                (c.item.profileId ? null : defaultAccount?.email ?? null),
              focused: focused.includes(c.item.id),
              width: dim.width,
              height: dim.height,
              contextOpen: contextOwners.has(c.item.id),
              historyOpen: historyOwners.has(c.item.id),
              /*
               * How many refusals are sitting behind a folded history, so the arrow can say they
               * are there.
               *
               * This is not decoration. The refusal pill now folds away with the history, on the
               * owner's request, and canon 15 forbids a refusal that nobody can see. Folding may
               * hide the detail; it may never hide the fact. So the count travels to the card and
               * the arrow is marked while the block is shut.
               */
              refusalCount: refusalsByCard.get(c.item.id)?.length ?? 0,
            } satisfies SessionNodeData,
          }
        }
        const docDim = sizeOf(c.item)
        return {
          id: c.item.id,
          type: 'doc',
          position,
          data: {
            card: c.item,
            project: projects.find((p) => p.id === c.item.projectId),
            width: docDim.width,
            height: docDim.height,
          } satisfies DocNodeData,
        }
      }),
    [all, packed, projects, focused, contextOwners, historyOwners, profiles, defaultAccount, box.w, box.h],
  )

  /**
   * One frame per open web, drawn around wherever that web's cards actually ended up.
   *
   * Derived rather than stored, and deliberately so: the frame follows the cards, so dragging a
   * file out of the block widens the border to include it instead of leaving a boundary on screen
   * that is no longer true. It sits behind everything, is not draggable and cannot be selected,
   * because it is a boundary rather than a thing on the board.
   */
  const frames: Node[] = useMemo(() => {
    // From the shared table, because the server reserves the space this draws into. These were
    // two independent sets of numbers, and the day they disagreed the top of every web was drawn
    // inside the card above it.
    const PAD = BOARD.FRAME_PAD
    const HEAD = BOARD.FRAME_HEAD
    /*
     * Room for the column labels, which live between the frame's header and the cards.
     *
     * A column header is positioned at its column's top minus 34 and stands about 24 tall, so it
     * occupied the same band the frame's own title was drawn in and covered it. The first column
     * is Instructions and starts at the frame's left edge, so the word landing on top of "Files it
     * works from" was not a coincidence, it was the same 16 pixels every time. The frame reserves
     * that band instead of sharing it.
     */
    const COLUMN_LABELS = BOARD.FRAME_LABELS
    const groups = new Map<string, { web: 'context' | 'history'; cards: typeof visDocs }>()
    for (const d of visDocs) {
      if (!d.ownerId || (d.web !== 'context' && d.web !== 'history')) continue
      const key = `${d.ownerId}:${d.web}`
      const g = groups.get(key) ?? { web: d.web, cards: [] }
      g.cards.push(d)
      groups.set(key, g)
    }

    const out: Node[] = []
    for (const [key, g] of groups) {
      const ownerId = key.slice(0, key.lastIndexOf(':'))
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const d of g.cards) {
        const dim = sizeOf(d)
        const h = d.collapsed ? COLLAPSED_H : dim.height
        minX = Math.min(minX, d.x)
        minY = Math.min(minY, d.y)
        maxX = Math.max(maxX, d.x + dim.width)
        maxY = Math.max(maxY, d.y + h)
      }
      if (!Number.isFinite(minX)) continue
      out.push({
        id: `frame:${key}`,
        type: 'webFrame',
        position: { x: minX - PAD, y: minY - PAD - HEAD - COLUMN_LABELS },
        /*
         * The whole block can be picked up and put somewhere, by its title bar.
         *
         * Individual file cards were already draggable, which lets a block be taken apart one card
         * at a time and is not the same thing as moving it. The bar is the handle because the
         * frame's body is transparent to clicks so the cards inside it stay reachable, and dragging
         * from empty canvas has to keep panning the board.
         */
        draggable: true,
        dragHandle: '.webframe__head',
        selectable: false,
        // Behind the cards it contains, and behind the wires reaching them.
        zIndex: -1,
        data: {
          ownerId,
          web: g.web,
          title: g.web === 'history' ? 'History' : 'Roots',
          count: g.cards.length,
          width: maxX - minX + PAD * 2,
          height: maxY - minY + PAD * 2 + HEAD + COLUMN_LABELS,
        } satisfies WebFrameData,
      })
    }
    return out
  }, [visDocs, box.w, box.h])

  /**
   * Where each card actually sits right now, packed or placed. Wires need this to choose which
   * side to leave from: a card below its parent should be reached by dropping straight down, not
   * by a long diagonal across the board, which is unreadable past a handful of cards.
   */
  const geometry = useMemo(() => {
    const m = new Map<string, { x: number; y: number; w: number; h: number }>()
    computed.forEach((n) => {
      const d = n.data as { width: number; height: number }
      m.set(n.id, { x: n.position.x, y: n.position.y, w: d.width, h: d.height })
    })
    return m
  }, [computed])

  /**
   * The open pipeline panels, placed beside the card each one is about.
   *
   * Free space is found the way the rest of the board treats it: start beside the card, then step
   * down until the box touches nothing, counting the panels already placed as obstacles so two open
   * at once cannot land on each other. Once the owner drags one it keeps the position he gave it,
   * since a panel that snapped back every time the board redrew would be unusable while a session
   * is printing.
   */
  /**
   * The message cards, placed exactly where they were left.
   *
   * Outside the packing that arranges session and file cards, and that is deliberate rather than an
   * omission. A message card is one the owner puts where he wants it, next to whichever card he
   * talks to most, and auto-packing exists to stop cards that Garden creates from landing on top of
   * each other. Nothing creates these but him.
   */
  const channelNodes: Node[] = useMemo(
    () =>
      channels
        .filter((c) => c.projectId === activeProjectId)
        .map((c) => ({
          id: c.id,
          type: 'channel',
          position: { x: c.x, y: c.y },
          // The bound card is looked up here rather than in the node, so the card renders its
          // title without needing the whole session list of its own.
          data: {
            channel: c,
            session: sessions.find((s) => s.id === c.sessionId) ?? null,
          } satisfies ChannelNodeData,
        })),
    [channels, sessions, activeProjectId],
  )

  const panels: Node[] = useMemo(() => {
    if (pipelineOpen.length === 0) return []
    // From where the cards are actually drawn rather than from the stored row: with auto-packing
    // on the two differ, and placing against the stored row would drop the panel onto a card.
    const boxes = [...geometry.values()]
    const hits = (a: { x: number; y: number; w: number; h: number }) =>
      boxes.some(
        (b) => a.x < b.x + b.w + 40 && a.x + a.w + 40 > b.x && a.y < b.y + b.h + 40 && a.y + a.h + 40 > b.y,
      )

    const out: Node[] = []
    for (const sessionId of pipelineOpen) {
      const owner = visSessions.find((s) => s.id === sessionId)
      const at = geometry.get(sessionId)
      if (!owner || !at) continue
      const saved = getPipelineAt(sessionId)
      let spot = saved ?? { x: at.x + at.w + 160, y: at.y }
      if (!saved) {
        // Bounded on purpose: on a very full board this gives up and sits below everything rather
        // than searching for ever.
        for (let i = 0; i < 60 && hits({ ...spot, w: PIPE_W, h: PIPE_H }); i++) {
          spot = { x: spot.x, y: spot.y + 80 }
        }
      }
      boxes.push({ x: spot.x, y: spot.y, w: PIPE_W, h: PIPE_H })
      out.push({
        id: `${PIPE_ID}${sessionId}`,
        type: 'pipeline',
        position: spot,
        draggable: true,
        dragHandle: '.pipe-head',
        selectable: false,
        data: { sessionId, title: owner.title, width: PIPE_W, height: PIPE_H } satisfies PipelineNodeData,
      })
    }
    return out
  }, [pipelineOpen, visSessions, geometry])

  // Wires are the lines between cards. A manual one you drew is solid; a derived one, created by
  // Garden from a real event, is dashed, so a drawn line is never mistaken for an observed one.
  const edges: Edge[] = useMemo(() => {
    /*
     * Message cards count as present, or the wire that binds one is never drawn.
     *
     * This set exists to drop wires pointing at cards that are not on screen, and it was built from
     * the packed cards alone, which is every session and file card and nothing else. A message card
     * is placed by hand and so is not in that list, so wiring one bound it, renamed it, and drew no
     * line: the owner would have been looking at two cards that were connected with nothing between
     * them. Caught by counting edges after a drag rather than by looking at the board, which found
     * one wire created and zero drawn.
     */
    const present = new Set([...all.map((c) => c.item.id), ...channelNodes.map((n) => n.id)])
    const docIds = new Set(visDocs.map((d) => d.id))
    // One colour per kind, so the side a wire leaves from and the colour it is drawn in say the
    // same thing. History was falling through to the manual colour, which made a wire Garden
    // derived look like one the owner drew.
    const colourOf = (k: string) =>
      k === 'blind'
        ? '#f59e0b'
        : k === 'derived'
          ? '#2dd4bf'
          : k === 'context'
            ? '#7cc4ff'
            : k === 'history'
              ? '#c084fc'
              : k === 'evidence'
                ? '#a3e635'
                : '#7c5cff'
    return wires
      .filter((w) => present.has(w.sourceId) && present.has(w.targetId))
      .map((w) => ({
        id: w.id,
        source: w.sourceId,
        target: w.targetId,
        // Context and history wires always use the bottom and top dots. An agent-to-agent wire
        // picks its side from where the two cards actually are: straight down to a card below,
        // sideways to one beside it. A fixed right-to-left rule drew long diagonals that became
        // impossible to follow once the board had more than a few cards on it.
        ...handlesFor(w, (id) => docIds.has(id), geometry),
        type: 'wire',
        animated: false,
        // Solid violet: a wire you drew. Dashed teal: one Garden observed. Dotted amber: a blind
        // agent, wired to its caller and deliberately to nothing else. Pale blue: an attachment
        // to a file, which is not communication and so carries no arrow.
        style: {
          stroke: colourOf(w.kind),
          /*
           * Every wire rests at the same weight, and ONLY a real message lights one.
           *
           * This used to brighten and glow any wire touching a session whose CLI said it was
           * mid-turn. The intent was to show a busy path, but the owner reported the actual
           * effect on 2026-09-02: an orchestrator is wired to every card it can dispatch to, so
           * the moment it started a turn its entire fan lit at once and the board claimed sixteen
           * live connections when nothing had been sent along any of them.
           *
           * A wire means a channel between two cards, so lighting one has to mean traffic on that
           * channel and nothing else. `wire.pulse` already carries exactly that, per wire, only
           * when a message is really posted or a dispatch really fires, and WireEdge draws it in
           * a cyan no kind uses at rest. Card status is shown on the card, which is where a
           * property of one card belongs; a wire is a property of two.
           */
          strokeWidth: 2,
          strokeOpacity: 0.45,
          strokeDasharray:
            w.kind === 'blind' ? '2 6' : w.kind === 'derived' ? '6 4' : w.kind === 'context' ? '4 5' : undefined,
        },
        // The arrowhead carries the direction, so the connectors themselves need no meaning.
        markerEnd:
          w.kind === 'context' || w.kind === 'history' || w.kind === 'evidence'
            ? undefined
            : { type: MarkerType.ArrowClosed, width: 16, height: 16, color: colourOf(w.kind) },
        // A spawn is a round trip, so its wire has a head at both ends: work goes out and the
        // answer comes back. One wire with two heads rather than two lines between the same pair
        // of cards, which would draw two connections where there is one.
        markerStart: w.bidirectional
          ? { type: MarkerType.ArrowClosed, width: 16, height: 16, color: colourOf(w.kind) }
          : undefined,
        label: w.label || (w.kind === 'blind' ? 'blind' : undefined),
      }))
  }, [wires, all, channelNodes, geometry, visSessions, visDocs])

  /*
   * One wire per open panel, back to the card it is about.
   *
   * Client-side, like the panel itself, and drawn plainly so it cannot be mistaken for a wire
   * between two agents: no arrowhead, since nothing travels along it, and the same pale treatment
   * a file attachment gets, because this is a view of a card rather than a peer of one.
   */
  const panelEdges: Edge[] = useMemo(
    () =>
      panels.map((p) => {
        const sessionId = p.id.slice(PIPE_ID.length)
        return {
          id: `pipe-edge:${sessionId}`,
          source: sessionId,
          target: p.id,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'wire',
          style: { stroke: '#7cc4ff', strokeWidth: 2, strokeOpacity: 0.45, strokeDasharray: '4 5' },
        }
      }),
    [panels],
  )


  /*
   * "Arrange as a tree" was here, and it is gone at the owner's request, canon 02 revision 3.
   *
   * It read the agent-to-agent wires as a hierarchy and moved every card to match, which is the
   * behaviour recorded further down this file as costing him his positions project-wide: it wrote
   * `manualPos` for the whole board and flipped the auto-pack guard back on.
   *
   * Only the menu item and this callback went. `layout.ts` is untouched, so the Layouts section in
   * the rail still offers its tree arrangement (that one is `treeTiers`, reached through
   * `arrange`), and the placement a spawned team arrives with is unaffected. `treeLayout` itself is
   * left exported with nothing in the app calling it now, because deleting from `layout.ts` was not
   * what was asked.
   */

  const onConnect = useCallback(
    (c: Connection) => {
      if (!activeProjectId || !c.source || !c.target) return
      actions.createWire(activeProjectId, c.source, c.target)
    },
    [activeProjectId],
  )

  /**
   * Floating labels above each column of a context web.
   *
   * Derived from where the cards actually are rather than stored, so a header can never drift
   * away from the column it names, and there is nothing extra to clean up when the web is folded.
   */
  const headers: Node[] = useMemo(() => {
    const GROUP_LABEL: Record<string, string> = {
      instructions: 'Instructions',
      memory: 'Its own notes',
      research: 'Research',
      settings: 'Settings',
      skills: 'Skills',
      agents: 'Agent definitions',
      // This card's own hooks, read from the settings file Garden wrote for it, against `guards`
      // which is the machine's shared guard registry. Two different things, so two columns.
      hooks: 'Its own hooks',
      guards: 'Hooks and guards',
    }
    const ALWAYS = new Set(['instructions', 'memory', 'settings', 'guards', 'hooks'])

    const columns = new Map<string, { x: number; y: number; count: number; group: string }>()
    for (const d of visDocs) {
      if (d.web !== 'context' || !d.group) continue
      const key = `${d.ownerId}:${d.group}`
      const seen = columns.get(key)
      if (!seen) columns.set(key, { x: d.x, y: d.y, count: 1, group: d.group })
      else {
        seen.count++
        seen.x = Math.min(seen.x, d.x)
        seen.y = Math.min(seen.y, d.y)
      }
    }

    const out: Node[] = [...columns.entries()].map(([key, c]) => {
      const ownerId = key.slice(0, key.lastIndexOf(':'))
      return {
        id: `colhead:${key}`,
        type: 'columnHeader',
        position: { x: c.x, y: c.y - 34 },
        draggable: false,
        selectable: false,
        data: {
          label: GROUP_LABEL[c.group] ?? c.group,
          count: c.count,
          usage: ALWAYS.has(c.group) ? 'always' : 'mixed',
          // The same width as the pill it replaces, so the header row does not change shape when a
          // column opens.
          wide: true,
          // Pressing an open column's own header folds it back to its pill.
          onClose: () => actions.closeContextColumn(ownerId, c.group),
        } satisfies ColumnHeaderData,
      }
    })

    /*
     * Columns for a card whose roots are unfolded but whose files are not.
     *
     * The bottom dot used to open every file at once, which on a real project is well over a
     * hundred cards arriving together and, in the owner's words, "makes it too laggy the way it is
     * right now". So it unfolds these instead: one node per kind of thing the card runs from, with
     * the count that would have arrived as cards, and clicking one opens that column.
     *
     * A group that already has files open is skipped, so a header is never drawn twice for the same
     * column. The real one above is derived from where its cards actually are and is therefore the
     * truthful one; this is a placeholder for a column that has not been opened yet.
     */
    for (const s of sessionsWithColumns) {
      const card = visSessions.find((c) => c.id === s)
      const list = contextByCard.get(s)
      if (!card || !list) continue
      const openGroups = new Set(
        visDocs.filter((d) => d.ownerId === s && d.web === 'context' && d.group).map((d) => d.group as string),
      )
      const groups = new Map<string, number>()
      for (const e of list) groups.set(e.group, (groups.get(e.group) ?? 0) + 1)

      /*
       * Always-in-play columns first, then the ones only used when something invokes them.
       *
       * The two are already drawn differently, and a blind reviewer could see the difference meant
       * something and could not work out what: with the counts running 2, 3, 1 on the emphasised ones
       * and 31, 7 on the dim ones, the obvious reading is that the highlight tracks volume, which is
       * backwards. Putting them in two runs makes the split read as a grouping rather than as noise.
       */
      const order = ['instructions', 'memory', 'settings', 'hooks', 'guards', 'research', 'skills', 'agents']

      /*
       * Every column keeps its own slot whether it is open or not.
       *
       * The pills used to be laid out by their index in the filtered list, so opening one made every
       * pill to its right slide left to fill the gap. The opened column's own header stays where its
       * files are, which is the slot that just emptied, so a pill would slide underneath it and the
       * two read as one column labelled twice. The owner saw exactly that: "remove duplicate pill
       * from when a root column is expanded".
       *
       * Positions therefore come from the full ordered list, and opening or closing a column changes
       * nothing about where any other one sits.
       */
      const slots = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      const shown: Array<[string, number, number]> = slots
        .map(([g, n], i) => [g, n, i] as [string, number, number])
        .filter(([g]) => !openGroups.has(g))

      /*
       * The roots draw as a table, and this row is its header.
       *
       * Every pill is the width of a column of files and they are laid out on the same stride, so a
       * pill sits squarely over the rows that open under it. Equal widths regardless of label, at the
       * owner's asking and for the reason he gave: pills sized to their own text made a header row of
       * ragged blocks rather than a table. Positions come from the full list rather than the visible
       * one, so a pill never moves when another column opens or closes.
       *
       * The whole row is centred on the card, which is what keeps the table under the thing it
       * belongs to however many columns there are.
       */
      const COL_W = 260
      const COL_STRIDE = COL_W + BOARD.GAP
      /*
       * How far below the pill row a column's files start.
       *
       * Not a spacing choice. An open column's header is derived from where its cards are and drawn
       * 34px above them, so the files have to start exactly 34px below the pill row or the header
       * that replaces the pill lands at a different height and the row stops being level. Measured
       * at 18px out before this matched.
       */
      const HEADER_LIFT = 34
      const rowWidth = slots.length * COL_STRIDE - BOARD.GAP
      const rowX = card.x + (card.width ?? 420) / 2 - rowWidth / 2
      const y = card.y + (card.height ?? 260) + 56

      shown.forEach(([group, count, slot]) => {
        const colX = rowX + slot * COL_STRIDE
        out.push({
          id: `colpick:${s}:${group}`,
          type: 'columnHeader',
          position: { x: colX, y },
          draggable: false,
          selectable: false,
          data: {
            label: GROUP_LABEL[group] ?? group,
            count,
            usage: ALWAYS.has(group) ? 'always' : 'mixed',
            wide: true,
            // Rows under this column's own pill, which is what makes the whole thing a table.
            onOpen: () => actions.openContextWeb(s, group as never, { x: colX, y: y + HEADER_LIFT }),
          } satisfies ColumnHeaderData,
        })
      })
    }

    /*
     * And the same row above the card, for the days it has a history for.
     *
     * The arrow on a card used to put every turn it had ever taken on the board at once, which on
     * the orchestrator is dozens of cards arriving together: the fault the roots had before they
     * became columns. So the arrow asks for the days, they draw as pills, and a day's turns arrive
     * when he opens that day.
     *
     * By day because a turn carries nothing else to group by. He asked for one pill per task, and a
     * work record has who asked, what was asked, when, and which files it touched, with no
     * identifier tying several turns into one piece of work. Matching prose to invent one would be
     * the guessing this app refuses. A day is real and countable.
     *
     * Above rather than below, because that is where history already opens and where its own arrow
     * points. Same widths and the same stride as the roots row, so the two read as the same control
     * in two directions rather than as two designs.
     */
    /*
     * The refusal pill shares this row, and takes the first slot in it.
     *
     * One row rather than two, because a refusal is a thing that happened to this card at a time,
     * which is exactly what the rest of the row holds; a second row above the first would read as a
     * second kind of control rather than as more history. First rather than last so it sits in the
     * same place whether the card has one day behind it or nine, since a pill that moves depending
     * on how much history a card happens to have is a pill the eye has to hunt for.
     *
     * Drawn only while that card's history is unfolded, since 2026-09-09: "make 'refused' a part of
     * collapsible history section". It used to be drawn whenever refusals existed, which meant the
     * one thing in this row that could not be folded away was the one the owner most often wanted
     * out of the way once he had read it.
     *
     * What makes that safe is the mark on the card's own history arrow, which is drawn from
     * `refusalCount` above. Without it this change would hide a refusal behind a control nobody had
     * pressed, and canon 15 forbids exactly that. The two halves are one change and neither is
     * correct on its own.
     */
    const withRow = new Set(historyByCard.keys())
    for (const sessionId of withRow) {
      const card = visSessions.find((c) => c.id === sessionId)
      if (!card) continue
      const hist = historyByCard.get(sessionId)
      const refused = refusalsByCard.get(sessionId)
      const groups = hist?.groups ?? []
      // A card whose history is open but holds neither days nor refusals has an empty row, which is
      // nothing rather than a row of nothing.
      if (groups.length === 0 && !refused) continue
      const openDays = new Set(hist?.open ?? [])

      // The refusal pill occupies a slot of its own, so the row is centred over the card as one
      // block rather than the day pills being centred and the refusal hanging off the end.
      const slots = groups.length + (refused ? 1 : 0)
      const rowWidth = slots * (260 + BOARD.GAP) - BOARD.GAP
      const rowX = card.x + (card.width ?? 420) / 2 - rowWidth / 2
      /*
       * Where the row sits when nothing is open: 56 above the card, mirroring the roots row's 56
       * below it, less the 34 a pill takes so the two rows are the same distance from their card.
       */
      const restingY = card.y - 56 - 34
      /*
       * An opened day is drawn in the same band this row sits in, so the row moves above it.
       *
       * The owner: "when a history day is opened, make that panel not overlap the other dates". The
       * block is placed by the server directly above the card and grows upward in rows of six, and
       * this row is at a fixed 90 above the card, so the first opened day landed on the pills for
       * every day that was not open. Two things drawn above one card, neither knowing about the
       * other.
       *
       * Read from the board rather than recomputed from the server's placement arithmetic. The
       * block's cards are on the board already, as documents with `web === 'history'` under this
       * card, and the `frames` memo above draws the boundary the eye actually reads at
       * `min(their y) - FRAME_HEADROOM`. Taking the same expression means the row clears the frame
       * that is drawn rather than the frame that was intended, and it keeps following when the two
       * disagree. A second copy of `originY - (rows - 1) * ROW_PITCH` would be a number to keep in
       * step with a file in another package.
       *
       * Both awkward cases fall out of it rather than needing to be handled. Several days open at
       * once share one frame, because the frame is grouped per card and per web and not per day, so
       * the minimum is over all of them and the row clears the topmost. And a day that wraps from
       * one row of six to two moves those cards' `y`, so the minimum moves with it on the very next
       * render.
       *
       * `Math.min` rather than an assignment: a frame that somehow sat below the resting row would
       * otherwise pull the row DOWN into the card. Nothing may push this row lower than where it
       * sits with nothing open.
       */
      const HEADER_LIFT = 34
      let y = restingY
      const block = visDocs.filter((d) => d.web === 'history' && d.ownerId === sessionId)
      if (block.length > 0) {
        const frameTop = Math.min(...block.map((d) => d.y)) - FRAME_HEADROOM
        // The pill's own 34, and then the clear space the board keeps between any two things on it.
        y = Math.min(restingY, frameTop - HEADER_LIFT - BOARD.GAP)
      }
      const slotX = (slot: number) => rowX + slot * (260 + BOARD.GAP)

      if (refused) {
        out.push({
          id: `refusals:${sessionId}`,
          type: 'refusalPill',
          position: { x: slotX(0), y },
          draggable: false,
          selectable: false,
          data: { refusals: refused } satisfies RefusalPillData,
        })
      }

      groups.forEach((g, slot) => {
        if (openDays.has(g.group)) return
        out.push({
          id: `histpick:${sessionId}:${g.group}`,
          type: 'columnHeader',
          position: { x: slotX(slot + (refused ? 1 : 0)), y },
          draggable: false,
          selectable: false,
          data: {
            label: g.label,
            count: g.count,
            usage: 'mixed',
            wide: true,
            onOpen: () => actions.openHistoryDay(sessionId, g.group),
          } satisfies ColumnHeaderData,
        })
      })
    }

    return out
  }, [visDocs, sessionsWithColumns, contextByCard, visSessions, historyByCard, refusalsByCard])

  /*
   * One wire per unopened column, back to the card whose roots they are.
   *
   * Without them the row is five pills floating under a card, and a blind reviewer said exactly what
   * that costs: "If a second card existed on this board, I would not be able to tell which card this
   * row belongs to." The real columns of files are wired to their card already, so this is the same
   * relationship drawn the same way rather than a new idea; it leaves the card's bottom port, which
   * is the port that means "what this session runs from".
   */
  /*
   * The to-do bars, one above the To Do card and one above every card with items of its own.
   *
   * Everything here is derived from `TODO.md`: the file is the list, and a card's personal list is
   * the subset of it addressed to that card, worked out each time this runs. Nothing is stored, so
   * there is no second copy to disagree with the file. Canon 26.
   *
   * Positions come from `computed` rather than from the card rows, because packing moves cards and
   * a bar placed from the stored x would sit where the card used to be.
   */
  const [docTick, setDocTick] = useState(0)
  useEffect(() => onDocChange(() => setDocTick((n) => n + 1)), [])
  const [loopTick, setLoopTick] = useState(0)
  useEffect(() => onLoops(() => setLoopTick((n) => n + 1)), [])

  const todoCard = useMemo(
    () => visDocs.find((d) => d.kind !== 'image' && /(^|[\/])todo\.md$/i.test(d.relPath)) ?? null,
    [visDocs],
  )
  /*
   * Asked for once, rather than only when the card is expanded the way a document card asks.
   *
   * The bars are the reason: they are drawn above cards anywhere on the board, including while the
   * To Do card itself is collapsed or off screen, so the text has to arrive without anybody opening
   * it. The doc poll pushes the file again whenever it changes on disk, which is what makes a card
   * ticking its own item show up on every other card's bar.
   */
  useEffect(() => {
    if (todoCard && getDocContent(todoCard.id) === undefined) actions.readDoc(todoCard.id)
  }, [todoCard, docTick])

  const todoBars: Node[] = useMemo(() => {
    if (!todoCard) return []
    const text = getDocContent(todoCard.id)
    if (text === undefined) return []
    const items = parseTodo(text, visSessions.map((s) => ({ id: s.id, title: s.title })))

    const at = new Map(
      computed.map((n) => [n.id, { x: n.position.x, y: n.position.y, width: (n.data as { width?: number }).width ?? 260 }]),
    )
    const toggle = (line: number, done: boolean) => actions.saveDoc(todoCard.id, setDone(text, line, !done))
    const loops = getLoops(activeProjectId) ?? []
    const out: Node[] = []
    // Above the card, by the same gap the context web's column headers use, so the two families of
    // derived labels sit at the same distance from what they describe.
    const bar = (id: string, ownerId: string, data: Omit<TodoBarData, 'width'>) => {
      const p = at.get(ownerId)
      if (!p) return
      out.push({
        id,
        type: 'todoBar',
        position: { x: p.x, y: p.y - 34 },
        draggable: false,
        selectable: false,
        data: { ...data, width: p.width } satisfies TodoBarData,
      })
    }

    // The main list, on the To Do card, which carries the project's progress rather than any card's.
    const whole = progressOf(items)
    bar('todobar:main', todoCard.id, {
      ...whole,
      onToggle: (l) => toggle(l, !!items.find((i) => i.line === l)?.done),
      main: true,
    })

    const byCard = new Map<string, TodoItem[]>()
    for (const i of items) {
      if (!i.cardId) continue
      const list = byCard.get(i.cardId)
      if (list) list.push(i)
      else byCard.set(i.cardId, [i])
    }
    for (const [cardId, list] of byCard) {
      const p = progressOf(list)
      const has = loops.some((l) => l.sessionId === cardId)
      const card = visSessions.find((s) => s.id === cardId)
      bar(`todobar:${cardId}`, cardId, {
        ...p,
        onToggle: (l) => toggle(l, !!list.find((i) => i.line === l)?.done),
        looping: has,
        /*
         * Only offered when there is no loop yet, and it makes an ordinary loop row: it shows up in
         * the rail's Loops section like any other and is stopped, edited or deleted there. The owner
         * asked for both halves: "each card should loop to their to-do list and set to off when
         * completed", "with loop populating to loops list".
         */
        onLoop:
          has || !card || !activeProjectId
            ? undefined
            : () =>
                actions.setLoop(activeProjectId, {
                  sessionId: cardId,
                  prompt: loopPromptFor(card.title),
                  minutes: 15,
                  enabled: true,
                }),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoCard, computed, visSessions, activeProjectId, docTick, loopTick])

  const columnEdges: Edge[] = useMemo(
    () =>
      headers
        .filter((h) => h.id.startsWith('colpick:'))
        .map((h) => {
          const sessionId = h.id.split(':')[1]!
          return {
            id: `coledge:${h.id}`,
            source: sessionId,
            target: h.id,
            sourceHandle: 'context',
            targetHandle: 'owner',
            type: 'wire',
            style: { stroke: '#7c5cff', strokeWidth: 1.5, strokeOpacity: 0.4, strokeDasharray: '3 5' },
          }
        }),
    [headers],
  )

  const allEdges = useMemo(() => [...edges, ...panelEdges, ...columnEdges], [edges, panelEdges, columnEdges])


  const [nodes, setNodes, onNodesChange] = useNodesState(computed)

  /*
   * Which card the pointer is currently dragging, if any.
   *
   * A ref rather than state: it changes on every drag and nothing should re-render because of it.
   * It exists so a position arriving from the server can be applied to every card except the one
   * being moved by hand, which would otherwise jump out from under the pointer.
   */
  const draggingId = useRef<string | null>(null)
  const kindById = useMemo(
    () => new Map(all.map((c) => [c.item.id, c.kind])),
    [all],
  )

  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      // Frames first, so a boundary is painted before the cards that sit inside it.
      const withHeaders = [...frames, ...computed, ...headers, ...todoBars, ...panels, ...channelNodes]
      return withHeaders.map((n) => {
        const existing = byId.get(n.id)
        if (!existing) return n
        /*
         * Keep what React Flow measured, or every card blinks and drops the keyboard.
         *
         * These objects are rebuilt from scratch whenever anything on the board changes, and a
         * rebuilt node has none of the size React Flow worked out for it. React Flow treats a node
         * it has not measured as not ready and renders it `visibility: hidden` until it measures
         * again, and a browser blurs whatever is focused inside an element that becomes invisible.
         *
         * So typing into a card and having any card appear, finish or change status took the
         * keyboard away mid-sentence, focus fell to the body, and every keystroke after that went
         * nowhere. The owner had it exactly right: "is it something thats unselecting the card so
         * that my typing stops?" Caught by watching the card's own style attribute across the blur:
         *
         *   card style -> "... visibility: hidden;"
         *   blur; still in document: true; now focused: BODY
         *   card style -> "... visibility: visible;"
         *
         * Nothing is remounted and nothing is disabled, which is why it looked like a caret bug and
         * why it only bit sometimes: it needs a rebuild to land in the moment between two keystrokes.
         *
         * Spreading the existing node first is the whole fix. Everything Garden owns still comes
         * from `n`; what survives is what React Flow put there.
         */
        n = { ...existing, ...n }
        /*
         * The server's position wins unless this card is being dragged right now.
         *
         * This used to keep the local position for every card once auto-packing was off, to stop
         * a card snapping back mid-drag. It stopped far more than that: every position the server
         * sent was discarded, so pressing an arrangement wrote a correct layout to the database
         * and changed nothing on screen. Proved by reading both at once, with the stored board
         * one row and the drawn board five.
         *
         * Only the card actually under the pointer needs protecting, and only while the pointer
         * is down, which is what the ref tracks.
         */
        if (draggingId.current === n.id) {
          return { ...n, position: existing.position, selected: existing.selected }
        }
        return { ...n, selected: existing.selected }
      })
    })
  }, [computed, headers, todoBars, frames, panels, channelNodes, setNodes, auto])

  /*
   * Report packed positions back to the server.
   *
   * The renderer decides where auto-packed cards go, so without this the server places new cards
   * and context webs against coordinates that were never on screen.
   */
  const reported = useRef('')
  useEffect(() => {
    if (!auto || packed.length === 0) return
    const positions = all.map((c, i) => ({ id: c.item.id, x: packed[i]!.x, y: packed[i]!.y }))
    const key = JSON.stringify(positions)
    if (key === reported.current) return
    reported.current = key
    const id = setTimeout(() => actions.reportLayout(positions), 250)
    return () => clearTimeout(id)
  }, [auto, packed, all])

  /*
   * Fit the board when the owner arrives at it, and never again while he is working in it.
   *
   * The card count used to be part of this key, so anything that put a card on the board moved his
   * viewport. Opening a card's roots adds thirteen at once, so pressing a fold arrow zoomed the
   * whole board out from under him, which is the opposite of what that arrow is for: he pressed it
   * to look at one card's files and got sent to a view of everything.
   *
   * Switching tabs still fits, and so does the first load once there is something to fit, because
   * both of those are him arriving somewhere new. Nothing after that touches the viewport, since
   * from then on it is his.
   *
   * `auto` was removed from the key on 2026-08-13, and it was the same bug as the card count in a
   * second signal. `shouldAutoPack` (layout.ts) is true only while EVERY card is still where the
   * app put it, so the first drag of any card flips it false for the whole board, once. That drag
   * is the owner taking hold of the layout, which is precisely the moment the comment above says
   * the viewport becomes his, and it was the moment the camera was snatched back. Tidy layout cost
   * him it a second time, because it resets `manualPos` project-wide and flips the guard back to
   * true. Arrange as a tree did the same and has been removed from the menu since; Tidy is the one
   * that is left, and it is the reason this guard is still needed.
   *
   * It stays in the dependency array and out of the key deliberately: which fit to run still
   * depends on it, so it has to be read fresh when he does arrive, and the guard below is what
   * stops it from being a reason to fit.
   */
  const lastKey = useRef('')
  useEffect(() => {
    const key = activeProjectId ?? ''
    if (key === lastKey.current) return
    // Wait for something to be on the board rather than claiming this view as fitted while empty.
    if (all.length === 0) return
    lastKey.current = key

    const id = setTimeout(() => {
      // Packed cards are already at their natural size, so show them 1:1 from the top left.
      if (auto) setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 })
      else fitView({ padding: 0.08, maxZoom: 1, duration: 220 })
    }, 140)
    return () => clearTimeout(id)
    // `all.length` is deliberately not a dependency: a card appearing must not move the viewport.
  }, [activeProjectId, all.length, auto, fitView, setViewport])

  /*
   * A card that was just asked for gets found and shown, once the server confirms it exists.
   *
   * Every creation path stamps this the moment it actually sends the create, not when a menu item
   * is clicked or a form opens, so a Cancel leaves nothing pending. `sessions` and `docs` arriving
   * from the server are the only proof a card exists at all: this never assumes the create
   * succeeded, so a refusal (the hiring ceiling, an unknown project) just lets the window pass and
   * nothing happens, rather than panning to a card that was never made. The match is by project
   * and by `createdAt`, since nothing round-trips a client-chosen id back from the server yet.
   *
   * This is deliberately not folded into the fit-view effect above, whose whole point is that a
   * card appearing must never move the owner's viewport uninvited. This is the one exception,
   * because the card appearing here is the one he just asked for by clicking exactly where he
   * wanted it.
   */
  const pendingCreateRef = useRef<{ projectId: string; at: number } | null>(null)
  const markPendingCreate = useCallback((projectId: string) => {
    pendingCreateRef.current = { projectId, at: Date.now() }
  }, [])

  useEffect(() => {
    const pending = pendingCreateRef.current
    if (!pending) return
    if (Date.now() - pending.at > PENDING_CREATE_MS) {
      pendingCreateRef.current = null
      return
    }
    const candidates = [
      ...sessions.filter((s) => s.projectId === pending.projectId && s.createdAt >= pending.at),
      ...docs.filter((d) => d.projectId === pending.projectId && d.createdAt >= pending.at),
    ]
    if (candidates.length === 0) return
    const created = candidates.sort((a, b) => b.createdAt - a.createdAt)[0]!
    pendingCreateRef.current = null
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === created.id })))
    setCenter(created.x + created.width / 2, created.y + created.height / 2, { zoom: getZoom(), duration: 320 })
  }, [sessions, docs, setNodes, setCenter, getZoom])

  // Collapsing is per card kind, so the bulk actions in the pane menu route through one helper.
  const setCollapsed = useCallback((c: { kind: 'session' | 'doc'; item: { id: string } }, v: boolean) => {
    if (c.kind === 'doc') actions.setDocCollapsed(c.item.id, v)
    else actions.setSessionCollapsed(c.item.id, v)
  }, [])

  /**
   * Only a real drag counts as the owner positioning a card.
   *
   * This used to persist every position change React Flow emitted, but it emits them for its own
   * reasons too: measurement, fitView, viewport changes. The result was that every card silently
   * became "manually positioned" at whatever intermediate coordinates the library happened to
   * report, which switched auto-packing off permanently and left cards overlapping each other.
   * onNodeDragStop is unambiguous: it fires once, at the end of a drag the owner performed.
   */
  const handleChanges = useCallback(
    (changes: NodeChange[]) => onNodesChange(changes),
    [onNodesChange],
  )

  /**
   * Double-click steps a card up a size, and opens a document for editing at the same time.
   *
   * This has to come from React Flow's own hook rather than an onDoubleClick inside the card:
   * the canvas's drag handler consumes mousedown, which suppresses the native double-click, so
   * a handler on the card element never fired.
   */
  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      // A panel is not a card and has no size steps, so it must not be routed into either of the
      // card resizers: they would send a resize for an id the server has never heard of.
      if (node.id.startsWith(PIPE_ID)) return
      // Expand, and press again to come back to the size it has on the board.
      if (kindById.get(node.id) === 'doc') actions.toggleDocSize(node.id)
      else actions.toggleSessionSize(node.id)
    },
    [kindById],
  )

  const onDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node) => {
      /*
       * A frame is drawn from wherever its cards are rather than stored, so it has no position of
       * its own to save. What it has is a distance travelled, which is applied to every card in the
       * web so the block keeps its shape.
       */
      if (node.id.startsWith('frame:')) {
        const { ownerId, web } = node.data as WebFrameData
        const cards = visDocs.filter((d) => d.ownerId === ownerId && d.web === web)
        if (cards.length === 0) return
        const wasX = Math.min(...cards.map((d) => d.x)) - BOARD.FRAME_PAD
        const wasY = Math.min(...cards.map((d) => d.y)) - FRAME_HEADROOM
        actions.moveWeb(ownerId, web, node.position.x - wasX, node.position.y - wasY)
        return
      }
      // A panel's position is the browser's, not the board's: it is not a card, so there is
      // nothing on the server to tell about it.
      if (node.id.startsWith(PIPE_ID)) {
        actions.movePipeline(node.id.slice(PIPE_ID.length), node.position.x, node.position.y)
        return
      }
      // A message card is not in `kindById`, which is built from the packed cards, so it is asked
      // about by identity instead. It has its own row and its own move message.
      if (node.type === 'channel') {
        actions.moveChannel(node.id, node.position.x, node.position.y)
        return
      }
      if (kindById.get(node.id) === 'doc') actions.moveDoc(node.id, node.position.x, node.position.y)
      else actions.move(node.id, node.position.x, node.position.y)
    },
    [kindById, visDocs],
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  /** The right-click that is making a card, and where on the board it was. */
  const [newCard, setNewCard] = useState<NewCardRequest | null>(null)
  const [newDoc, setNewDoc] = useState<NewDocRequest | null>(null)

  /**
   * The bottom dot opens a grouped picker rather than dumping every file on the board.
   *
   * A real project answers with dozens: 0.5 alone has 68 across six groups. Showing them as a
   * menu of groups, each listing its files, answers "what does this run from" without burying
   * the board, and only what is chosen becomes a card.
   */
  const GROUP_LABEL: Record<string, string> = {
    instructions: 'Instructions',
    memory: 'Its own notes',
    settings: 'Settings',
    hooks: 'Hooks',
    guards: 'Hooks and guards',
    skills: 'Skills',
    agents: 'Agent definitions',
  }

  const openContextPicker = useCallback(
    (sessionId: string, at: { x: number; y: number }) => {
      const build = () => {
        const entries = getContextList(sessionId)
        if (!entries) return
        const groups = new Map<string, typeof entries>()
        for (const e of entries) {
          const list = groups.get(e.group) ?? []
          list.push(e)
          groups.set(e.group, list)
        }
        const items: MenuItem[] = [...groups.entries()].map(([group, list]) => ({
          label: `${GROUP_LABEL[group] ?? group}`,
          hint: `${list.length}`,
          submenu: [
            {
              label: `Open all ${list.length}`,
              onSelect: () => actions.openContextFiles(sessionId, list.map((e) => e.display)),
            },
            { separator: true },
            ...list.slice(0, 40).map((e) => ({
              // "always" and "sometimes" are not decoration: a guard fires on every matching
              // event, a skill does nothing until something invokes it.
              label: `${e.open ? '• ' : ''}${e.title}`,
              hint: e.usage === 'always' ? 'always' : 'when used',
              onSelect: () => actions.openContextFiles(sessionId, [e.display]),
            })),
          ],
        }))
        if (items.length === 0) items.push({ label: 'Nothing found for this session', disabled: true })
        setMenu({ x: at.x, y: at.y, items })
      }

      const cached = getContextList(sessionId)
      if (cached) build()
      else {
        const off = onContextList((id) => {
          if (id !== sessionId) return
          off()
          build()
        })
        actions.listContext(sessionId)
      }
    },
    [],
  )

  // The card asks for the picker; the canvas owns the menu so it is never clipped by a card.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId: string; x: number; y: number }
      openContextPicker(detail.sessionId, { x: detail.x, y: detail.y })
    }
    window.addEventListener('garden:context-picker', handler)
    return () => window.removeEventListener('garden:context-picker', handler)
  }, [openContextPicker])

  const edgeMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault()
      const wire = wires.find((w) => w.id === edge.id)
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            /*
             * The arrowheads are a statement about what is allowed, so this is a real setting
             * rather than decoration: one head means work only ever travels that way.
             */
            label: wire?.bidirectional ? 'Make it one way' : 'Make it two way',
            hint: wire?.bidirectional
              ? 'only the arrow direction may carry work'
              : 'either end may start something',
            disabled: !wire,
            onSelect: () => actions.setWireDirection(edge.id, !wire?.bidirectional),
          },
          { separator: true },
          {
            label: 'Mark as blind',
            hint: 'isolated from project context',
            disabled: wire?.kind === 'blind',
            onSelect: () => actions.setWireKind(edge.id, 'blind'),
          },
          {
            label: 'Mark as a normal wire',
            disabled: !wire || wire.kind === 'manual',
            onSelect: () => actions.setWireKind(edge.id, 'manual'),
          },
          { separator: true },
          {
            label: wire?.label ? 'Edit label' : 'Add label',
            hint: 'what this connection means',
            onSelect: () => {
              const l = prompt('Label this wire', wire?.label ?? '')
              if (l !== null) actions.labelWire(edge.id, l)
            },
          },
          { separator: true },
          {
            label: 'Delete wire',
            danger: true,
            onSelect: () => actions.deleteWire(edge.id),
          },
        ],
      })
    },
    [wires],
  )

  const paneMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      // The getting-started step ticks when a menu opens, not when something in it is chosen. What
      // the step claims is that this person has seen a right-click menu, and opening one is exactly
      // what establishes that. Board and card share the step; the panel's text names both. Canon 23.
      markFirstRun('rightClick')
      const pid = activeProjectId
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            /*
             * The card that knows what it is for before it starts.
             *
             * Above the plain launchers because it is the one that builds a team: a card's
             * restrictions are read by the CLI once, at launch, so a role chosen afterwards does
             * not apply until the session is restarted.
             */
            label: 'New role card',
            hint: 'orchestrator, boss, manager, worker or reviewer',
            disabled: !pid,
            onSelect: () => {
              if (!pid) return
              const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              setNewCard({ projectId: pid, x: at.x, y: at.y })
            },
          },
          {
            /*
             * The one card that is only ever the owner and one session.
             *
             * Beside the card launchers rather than under the document ones, because it is not a
             * file card: it makes no file the owner picks, it belongs to no web, and what it is for
             * is a conversation. His reason for wanting it: "currently orchestrator gets tied up in
             * a lot of things and its hard for me to found our back and forth".
             */
            label: 'New message card',
            hint: 'just you and one card, wire it to bind',
            disabled: !pid,
            onSelect: () => {
              if (!pid) return
              const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              actions.createChannel(pid, at.x, at.y)
            },
          },
          { separator: true },
          {
            label: 'New terminal',
            disabled: !pid,
            submenu: [
              {
                label: 'Shell',
                onSelect: () => {
                  if (!pid) return
                  const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  markPendingCreate(pid)
                  actions.newSession(pid, 'shell', at.x, at.y)
                },
              },
              {
                label: 'Claude Code',
                onSelect: () => {
                  if (!pid) return
                  const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  markPendingCreate(pid)
                  actions.newSession(pid, 'claude', at.x, at.y)
                },
              },
              {
                label: 'Codex',
                onSelect: () => {
                  if (!pid) return
                  const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  markPendingCreate(pid)
                  actions.newSession(pid, 'codex', at.x, at.y)
                },
              },
            ],
          },
          { separator: true },
          {
            /*
             * The project's to-do list, at a fixed path rather than through the name form, because
             * there is one of them and everything else in the feature looks for it by that name.
             * Seeded with a line addressed to nobody, so the card is not an empty box: the shape of
             * an item is the thing a person needs to see once.
             */
            label: 'Create To Do Card',
            hint: 'TODO.md',
            disabled: !pid || todoCard !== null,
            onSelect: () => {
              if (!pid) return
              const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              actions.createDoc(pid, 'TODO.md', at.x, at.y, true)
              markPendingCreate(pid)
            },
          },
          {
            label: 'New markdown file',
            hint: '.md',
            disabled: !pid,
            onSelect: () => {
              if (!pid) return
              const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              setNewDoc({ projectId: pid, kind: 'md', x: at.x, y: at.y })
            },
          },
          {
            label: 'New text file',
            hint: '.txt',
            disabled: !pid,
            onSelect: () => {
              if (!pid) return
              const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              setNewDoc({ projectId: pid, kind: 'txt', x: at.x, y: at.y })
            },
          },
          { separator: true },
          {
            label: 'Tidy layout',
            hint: 'repack all',
            disabled: !pid,
            onSelect: () => pid && actions.tidyBoard(pid),
          },
          {
            label: 'Compact all terminals',
            hint: 'headers only',
            onSelect: () => all.filter((c) => c.kind === 'session').forEach((c) => setCollapsed(c, true)),
          },
          {
            label: 'Expand all terminals',
            onSelect: () => all.filter((c) => c.kind === 'session').forEach((c) => setCollapsed(c, false)),
          },
          { separator: true },
          { label: 'Compact everything', onSelect: () => all.forEach((c) => setCollapsed(c, true)) },
          { label: 'Expand everything', onSelect: () => all.forEach((c) => setCollapsed(c, false)) },
        ],
      })
    },
    // `visSessions` was here for the arrange item's disabled state and went with it.
    [activeProjectId, all, markPendingCreate],
  )

  const nodeMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault()
      // The card's own menu, which is a different menu from the board's. One step covers both, and
      // its text says they are different, because five steps was the brief and this is one lesson.
      markFirstRun('rightClick')
      // The panel's only action is to fold away. Falling through to the card menu below would
      // offer Close, which would try to close a session by the panel's id.
      if (node.id.startsWith(PIPE_ID)) {
        const sessionId = node.id.slice(PIPE_ID.length)
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: 'Ask again', hint: 'an open run changes stage silently', onSelect: () => actions.readPipeline(sessionId) },
            { label: 'Fold away', onSelect: () => actions.closePipeline(sessionId) },
          ],
        })
        return
      }
      const kind = kindById.get(node.id)
      const session = visSessions.find((s) => s.id === node.id)
      const doc = visDocs.find((d) => d.id === node.id)
      const name = session?.title ?? doc?.title ?? 'this card'
      const isCollapsed = session?.collapsed ?? doc?.collapsed ?? false
      /*
       * The same question the server asks, asked with the same function.
       *
       * These were two lists of statuses that happened to match, until they did not: a card whose
       * shell outlived its CLI read as off here, offered Turn on, and was refused there as already
       * running. Canon 03, "When the shell outlives the agent".
       */
      const off = session != null && cardIsOff(session)

      const items: MenuItem[] = []

      if (session) {
        items.push({
          label: focused.includes(session.id) ? 'Hide terminal' : 'Open terminal',
          onSelect: () => actions.toggleFocus(session.id),
        })
        items.push({
          label: off ? 'Turn on' : 'Turn off',
          onSelect: () => (off ? actions.startSession(session.id) : actions.stopSession(session.id)),
        })
        items.push({
          label: 'Duplicate',
          onSelect: () => actions.newSession(session.projectId, session.adapterId),
        })
        items.push({
          label: 'Card colour',
          hint: 'for roles and teams',
          submenu: [
            { label: 'Default for this CLI', onSelect: () => actions.setSessionColor(session.id, null) },
            { label: 'Violet', onSelect: () => actions.setSessionColor(session.id, '#7c5cff') },
            { label: 'Teal', onSelect: () => actions.setSessionColor(session.id, '#2dd4bf') },
            { label: 'Amber', onSelect: () => actions.setSessionColor(session.id, '#f59e0b') },
            { label: 'Rose', onSelect: () => actions.setSessionColor(session.id, '#f43f5e') },
            { label: 'Sky', onSelect: () => actions.setSessionColor(session.id, '#38bdf8') },
            { label: 'Lime', onSelect: () => actions.setSessionColor(session.id, '#a3e635') },
          ],
        })
        items.push({
          label: 'Show what it runs from',
          submenu: [
            { label: 'Everything', onSelect: () => actions.openContextWeb(session.id) },
            { label: 'Its settings', onSelect: () => actions.openContextWeb(session.id, 'settings') },
            { label: 'Its own notes and lessons', onSelect: () => actions.openContextWeb(session.id, 'memory') },
            { label: 'Instructions (CLAUDE.md)', onSelect: () => actions.openContextWeb(session.id, 'instructions') },
            { label: 'Skills', onSelect: () => actions.openContextWeb(session.id, 'skills') },
            { label: 'Agent definitions', onSelect: () => actions.openContextWeb(session.id, 'agents') },
            { label: 'Guards', onSelect: () => actions.openContextWeb(session.id, 'guards') },
          ],
        })
        items.push({
          label: 'Fold those away',
          disabled: !contextOwners.has(session.id),
          onSelect: () => actions.closeContextWeb(session.id),
        })
        items.push({
          label: pipelineOpen.includes(session.id) ? 'Fold away how it ran' : 'Show how its runs went',
          hint: 'seven stages per run, with what was seen',
          onSelect: () => actions.togglePipeline(session.id),
        })
        items.push({ separator: true })
        items.push({
          label: 'Rename',
          onSelect: () => {
            const t = prompt('Rename card', session.title)
            if (t) actions.rename(session.id, t)
          },
        })
      }

      // "Compact" is the header-only chip: the card stays exactly where it is and keeps running,
      // it just stops taking up room. Bulk versions live in the canvas menu.
      // A document opened by hand belongs to nothing until it is attached to a terminal.
      if (doc) {
        if (doc.ownerId) {
          items.push({
            label: 'Detach from its terminal',
            onSelect: () => actions.detachDoc(doc.id),
          })
        } else if (visSessions.length > 0) {
          items.push({
            label: 'Attach to a terminal',
            hint: 'wire it to the session it belongs to',
            submenu: visSessions.map((s) => ({
              label: s.title,
              onSelect: () => actions.attachDoc(doc.id, s.id),
            })),
          })
        }
        items.push({ separator: true })
      }

      items.push({
        label: isCollapsed ? 'Expand' : 'Compact',
        hint: isCollapsed ? 'show the terminal' : 'header only',
        onSelect: () => (kind === 'doc' ? actions.setDocCollapsed(node.id, !isCollapsed) : actions.setSessionCollapsed(node.id, !isCollapsed)),
      })

      items.push({ separator: true })
      items.push({
        label: kind === 'doc' ? 'Remove from the board' : 'Close',
        danger: kind === 'doc',
        hint: kind === 'doc' ? 'the file on disk is untouched' : 'keeps everything, moves it to the closed list',
        onSelect: () => {
          /*
           * Only the destructive one asks.
           *
           * Deleting a session card ends a process and takes an agent's history with it, so it is
           * gated and always has been. Removing a document card does neither: the card leaves the
           * board and the file on disk is untouched, which the dialog itself said while still
           * demanding an answer.
           *
           * That gate was also swallowing the click. A browser stops honouring `confirm` once the
           * owner has ticked "prevent this page from creating additional dialogs", and from then on
           * it returns false instantly, so Delete silently did nothing with no error anywhere. The
           * cards it refused to remove were orphaned roots, which have no other way off the board.
           */
          if (kind === 'doc') {
            actions.closeDoc(node.id)
            return
          }
          /*
           * Closing, not deleting, and no dialog either.
           *
           * This menu item used to end the session, remove its history and cascade into every card
           * it had hired, all from one press, which is why it needed a confirmation in the first
           * place. Now it takes the card off the board and keeps everything, so there is nothing to
           * warn about. Deleting for good still exists and now lives where it belongs, on the
           * closed list in the sidebar, next to a card the owner has already decided to put down.
           */
          actions.closeSession(node.id)
        },
      })

      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [kindById, visSessions, visDocs, focused, contextOwners, pipelineOpen],
  )

  return (
    <div className="canvas-flow" ref={wrapRef}>
      <ReactFlow
        nodes={nodes}
        edges={allEdges}
        /*
         * Cards land on the dots rather than wherever the pointer left them.
         *
         * The dotted background was cosmetic: it looked like a grid and nothing lined up to it, so
         * a board of forty cards ended up a few pixels out on every axis and the owner was doing
         * the aligning by eye. Snapping to the same constant the dots are drawn at means the two
         * cannot drift apart, which is what a second hardcoded number would have guaranteed.
         *
         * Both axes take the same value. A rectangular snap would line a card's left edge up and
         * not its top, which reads as broken rather than as deliberate.
         */
        snapToGrid
        snapGrid={[GRID, GRID]}
        onConnect={onConnect}
        onEdgeContextMenu={edgeMenu}
        connectionLineStyle={{ stroke: '#7c5cff', strokeWidth: 2 }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleChanges}
        onNodeDragStart={(_e, node) => {
          draggingId.current = node.id
        }}
        onNodeDragStop={(e, node) => {
          draggingId.current = null
          onDragStop(e, node)
        }}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneContextMenu={paneMenu}
        onNodeContextMenu={nodeMenu}
        // Wide range on purpose: far out to see a board of forty cards as a shape, and well in
        // to read a terminal without opening the dock.
        minZoom={0.05}
        maxZoom={3}
        // Double-click belongs to the cards: it steps a card up a size. Leaving the canvas's own
        // zoom-on-double-click enabled meant every attempt to grow a card zoomed the board instead.
        zoomOnDoubleClick={false}
        /*
         * No keystroke takes a card off the board. React Flow removes the selected node on
         * Backspace and Delete by default, and nothing here had turned that off.
         *
         * Measured rather than argued: with a card selected, two Backspaces took the node count
         * from four to three. It came back on the next sync from the server, because the card was
         * never actually deleted, so what the owner saw was a card blinking out and the board
         * shifting under him with no explanation. He reported it as the camera moving when he
         * pressed backspace too many times in a terminal.
         *
         * Deleting a card is the one action that loses an agent's history, so every path to it
         * confirms first (see `deleteSession` in state.ts). A key that quietly does a fraction of
         * the same thing has no place beside that.
         */
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} color="#1b2030" />
        <Controls showInteractive={false} />
        {/*
          Labelled, because unlabelled it does not read as a map.
          A blind reviewer seeing this screen for the first time described the corner as "an
          unlabelled floating box holding three blank rectangles, no title, no content" and ranked
          it as looking unfinished. The rectangles are the cards and the lighter area is where the
          camera is pointing, which is obvious once you know and invisible until then.
        */}
        {/*
          A map you can read, rather than a box of grey shapes.

          A blind reviewer seeing this screen for the first time described the corner as "an
          unlabelled floating box holding three blank rectangles, no title, no content" and ranked it
          as looking unfinished. It draws the cards and the camera, which is obvious once you know
          and invisible until then. So each shape gets its card's name and the wires between them are
          drawn, which is what makes it a picture of this board rather than of any board.

          Children of MiniMap are rendered inside its SVG, which is in board coordinates, so the
          same x and y a card sits at can be used directly. Sizes are in board units for the same
          reason: they are scaled down with everything else, so they are set against the size of a
          card rather than in pixels.
        */}
        <MiniMap pannable zoomable nodeColor={() => '#2a3352'} maskColor="rgba(6,8,12,0.75)" />
      </ReactFlow>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

      {/* Saying what a card is for, before it starts and therefore before it can ignore the answer. */}
      <NewCardForm
        request={newCard}
        sessions={visSessions}
        onClose={() => setNewCard(null)}
        onCreate={markPendingCreate}
      />
      <NewDocForm request={newDoc} onClose={() => setNewDoc(null)} onCreate={markPendingCreate} />
    </div>
  )
}

export function Canvas() {
  const sessions = useApp((s) => s.sessions)
  const docs = useApp((s) => s.docs)
  const channels = useApp((s) => s.channels)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const inProject = (p: string) => !activeProjectId || p === activeProjectId
  // A board holding only a message card is not an empty board, so the empty-state panel that
  // offers to create a first card has to count them too or it covers one.
  const empty =
    sessions.filter((s) => inProject(s.projectId)).length === 0 &&
    docs.filter((d) => inProject(d.projectId)).length === 0 &&
    channels.filter((c) => inProject(c.projectId)).length === 0

  return (
    <div className="canvas">
      <ReactFlowProvider>
        <CanvasInner />
      </ReactFlowProvider>

      {/*
        The panel that used to sit here said "Nothing on the board yet. Pick a project, then start a
        terminal or open a document." It was accurate and it vanished the instant a card existed,
        which is the moment every other question a newcomer has starts. Its text survives inside the
        first two steps of the panel below, which stays until the six are done.
      */}
      {empty && (
        <div className="canvas-empty">
          <h2>Nothing on the board yet</h2>
          <p>Pick a project, then start a terminal or open a document. Both become cards here.</p>
        </div>
      )}
      <FirstRun />
    </div>
  )
}
