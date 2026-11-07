import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { firstRunDismissed, firstRunDone } from '../firstrun'
import { getLoops, onLoops, useApp } from '../state'

/**
 * The goal ring in four short steps, once per browser, for someone new and for someone updating.
 * Canon 23. Each step sits beside the thing it describes with a line to it, the way the ring's own
 * notes do. The owner: "simple language", and "2 of 4 isnt connected to a ringbutto".
 */
const KEY = 'garden.ringsTutorial.2'
const DISC = '.goal-ring__disc, .goal-ring__blip-wrap'
const GOAL = '.goal-ring__seg[data-ring="goal"]'
const LOOPS = '.rail-section.rail-loops'
const MENU = '.ctxmenu'
const CHOICES = ['Start', 'Pause', 'Disable']

const PANEL_WIDE = 300
const MARGIN = 16
/** How far above the point the line reaches, and the flat run to the panel after it. */
const RISE = 34
const RUN = 40
/** From the top of the panel to its title, so the line arrives level with the title. */
const TITLE_DROP = 42

type Step = { title: string; body: string; target: string; spot: string }

const STEPS: Step[] = [
  {
    title: 'This is your goal ring',
    body: "It holds this tab's goals and sub-goals. The outer ring is the goals. The inner ring is the sub-goals of one goal. Each part fills in as its work finishes.",
    target: DISC,
    spot: DISC,
  },
  {
    title: 'Press a goal to read it',
    body: 'Each part of the outer ring is one goal, like this one. Press it to read it, and press it again to close it. Press the middle to see every name.',
    target: GOAL,
    spot: GOAL,
  },
  {
    title: 'Loops keep it moving',
    body: 'While goals are left, a loop keeps the work going. When the ring is full, the loop stops.',
    target: LOOPS,
    spot: LOOPS,
  },
  {
    title: 'Now right-click the ring',
    body: 'Right-click anywhere on the ring to see how you control its loop.',
    target: DISC,
    spot: DISC,
  },
]
const LAST = STEPS.length - 1
const MENU_STEP: Step = {
  title: 'You control the loop here',
  body: 'Start runs the loop. Pause holds it until you press Start. Disable turns it off for this tab, and cards can still send and read mail.',
  target: MENU,
  spot: '',
}

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return false
  }
}

/** The menu rows the last step points at. A row's own class cannot say which is which. */
function choiceRows(): Element[] {
  return [...document.querySelectorAll('.ctxmenu__item')].filter((n) =>
    CHOICES.includes(n.querySelector('.ctxmenu__label')?.textContent?.trim() ?? ''),
  )
}

type Spot = { left: number; top: number; line: string }

/** Where the panel goes and the line that joins it to the target: out at 45 degrees, then flat. */
function placeBeside(target: Element, isDisc: boolean, panelTall: number): Spot {
  const r = target.getBoundingClientRect()
  const right = r.left + r.width / 2 + PANEL_WIDE / 2 + RISE + RUN < window.innerWidth - r.width / 2
  const sign = right ? 1 : -1
  // A disc is left from its rim, and anything else from the middle of its side.
  const from = isDisc
    ? { x: r.left + r.width / 2 + sign * (r.width / 2) * Math.SQRT1_2, y: r.top + r.height / 2 - (r.height / 2) * Math.SQRT1_2 }
    : { x: right ? r.right : r.left, y: r.top + r.height / 2 }
  const wantTitle = from.y - RISE
  const top = Math.min(Math.max(MARGIN, wantTitle - TITLE_DROP), window.innerHeight - panelTall - MARGIN)
  const titleY = top + TITLE_DROP
  const rise = Math.abs(titleY - from.y)
  const bend = { x: from.x + sign * rise, y: titleY }
  const edge = bend.x + sign * RUN
  const left = Math.min(Math.max(MARGIN, right ? edge : edge - PANEL_WIDE), window.innerWidth - PANEL_WIDE - MARGIN)
  const end = right ? left : left + PANEL_WIDE
  return { left, top, line: `${from.x},${from.y} ${bend.x},${bend.y} ${end},${titleY}` }
}

export function RingsTutorial() {
  const activeProjectId = useApp((s) => s.activeProjectId)
  const hasOrchestrator = useApp((s) => s.sessions.some((c) => c.projectId === s.activeProjectId && c.roleClass === 'orchestrator' && c.closedAt === null))
  const loops = useSyncExternalStore(onLoops, () => getLoops(activeProjectId))
  const [done, setDone] = useState(seen)
  const [step, setStep] = useState(0)
  const [menuSeen, setMenuSeen] = useState(false)
  const [spot, setSpot] = useState<Spot | null>(null)
  const panel = useRef<HTMLElement>(null)

  // Someone new meets it once they have a card to run a ring, not on top of the steps before that.
  const firstRunOver = firstRunDismissed() || firstRunDone('rightClick')
  const showing = !done && !!activeProjectId && (hasOrchestrator || firstRunOver)
  const inMenu = step === LAST && menuSeen
  const current = inMenu ? MENU_STEP : STEPS[step]

  // The last step moves on only when the ring's menu has really been opened.
  useEffect(() => {
    if (!showing) return
    const opened = () => setMenuSeen(true)
    window.addEventListener('garden:ring-menu', opened)
    return () => window.removeEventListener('garden:ring-menu', opened)
  }, [showing])

  // The Loops section has to be on screen to be shown: its bar may be hidden, or scrolled away.
  useEffect(() => {
    if (!showing || current.target !== LOOPS) return
    document.querySelector<HTMLElement>('.rail-unfold')?.click()
    window.dispatchEvent(new Event('garden:open-loops'))
    const wait = window.setTimeout(() => document.querySelector(LOOPS)?.scrollIntoView({ block: 'nearest' }), 250)
    return () => window.clearTimeout(wait)
  }, [showing, current.target])

  // The ring may be panned away, or still loading, and it redraws as the list changes, so look again.
  useLayoutEffect(() => {
    if (!showing) return
    const look = () => {
      const marks = current.target === MENU ? choiceRows() : [...document.querySelectorAll(current.spot)].slice(0, current.target === GOAL ? 1 : undefined)
      for (const old of document.querySelectorAll('.tour-spot')) if (!marks.includes(old)) old.classList.remove('tour-spot')
      marks.forEach((n) => n.classList.add('tour-spot'))
      const target = current.target === GOAL ? marks[0] : document.querySelector(current.target) ?? (inMenu ? document.querySelector(DISC) : null)
      if (!target) {
        setSpot(null)
        return
      }
      const r = target.getBoundingClientRect()
      if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) {
        window.dispatchEvent(new Event('garden:show-ring'))
      }
      const next = placeBeside(target, target.matches(DISC), panel.current?.offsetHeight ?? 180)
      setSpot((was) => (was && was.left === next.left && was.top === next.top && was.line === next.line ? was : next))
    }
    look()
    const every = window.setInterval(look, 150)
    return () => {
      window.clearInterval(every)
      document.querySelectorAll('.tour-spot').forEach((n) => n.classList.remove('tour-spot'))
    }
  }, [showing, current.target, current.spot, inMenu])

  if (!showing) return null

  const finish = () => {
    try {
      localStorage.setItem(KEY, 'seen')
    } catch {
      /* With no storage it comes back next time, which is the smaller failure. */
    }
    setDone(true)
  }
  const running = (loops ?? []).filter((l) => l.enabled).length

  return (
    <>
      {spot && (
        <svg className="rings-tour__wire" aria-hidden="true">
          <polyline points={spot.line} />
        </svg>
      )}
      <aside
        ref={panel}
        className="rings-tour"
        aria-label="Goal ring tutorial"
        style={spot ? { left: spot.left, top: spot.top, right: 'auto', bottom: 'auto' } : undefined}
      >
        <span className="rings-tour__count">{step + 1} of {STEPS.length}</span>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        {current.target === LOOPS && (
          <p className={`rings-tour__state ${running ? 'is-on' : ''}`}>
            {running ? `${running} ${running === 1 ? 'loop' : 'loops'} active on this tab` : 'No loop active yet. Your orchestrator starts one when it has goals.'}
          </p>
        )}
        <div className="rings-tour__row">
          {!inMenu && <button onClick={finish}>Skip</button>}
          {step < LAST && <button className="is-next" onClick={() => setStep(step + 1)}>Next</button>}
          {inMenu && <button className="is-next" onClick={finish}>Done</button>}
        </div>
      </aside>
    </>
  )
}
