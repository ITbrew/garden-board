import { useEffect, useState } from 'react'
import type { CardLoop, TerminalSession } from '@garden/shared'
import { actions } from '../state'

/**
 * Which loops and which section the owner has folded away, kept per window.
 *
 * In localStorage for the same reason the open terminal panes are: what is folded is a fact about
 * this window rather than about the board, and a second window looking at the same board may
 * legitimately have different things open. A key edited by hand or a browser with storage turned
 * off costs nothing here, so every read and write is wrapped and the unfolded state is the default.
 */
const FOLD_KEY = 'garden.loops.folded'

type Folded = { section?: boolean; byLoop?: Record<string, boolean> }

function folded(): Folded {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function remember(patch: Folded) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify({ ...folded(), ...patch }))
  } catch {
    // Storage full or blocked. The fold still works for this session, which is where it started.
  }
}

/**
 * A prompt typed into one card every N minutes, switched on and off from the rail.
 *
 * The owner: "create loop section in the ceiling menus that allows me to toggle loops on/off and
 * select frequency of checking in minutes." Everything that decides whether the prompt is typed
 * lives on the server (`loopTick`), which never types into a card that is not idle; this panel
 * only sets the four fields and shows the server's own account of the last attempt.
 *
 * The server's values win once it answers, like every other setting in the rail, so two windows
 * editing the same loop never fight silently.
 */
function LoopRow({ projectId, loop, cards }: { projectId: string; loop: CardLoop; cards: TerminalSession[] }) {
  const [minutes, setMinutes] = useState(String(loop.minutes))
  const [prompt, setPrompt] = useState(loop.prompt)
  useEffect(() => setMinutes(String(loop.minutes)), [loop.minutes])
  useEffect(() => setPrompt(loop.prompt), [loop.prompt])

  /*
   * Folded loops, remembered. A board with a loop on every card is a rail the owner has to scroll
   * past to reach anything below it, and his answer was to make both levels fold: "make each loop
   * collapsible as well on the loops side bar as entire section as well."
   */
  const [open, setOpen] = useState(() => folded().byLoop?.[loop.id] !== true)
  const fold = (next: boolean) => {
    setOpen(next)
    remember({ byLoop: { ...folded().byLoop, [loop.id]: !next } })
  }

  const card = cards.find((c) => c.id === loop.sessionId)
  // A server older than the count does not send one, and a rail served by Vite is newer than the
  // backend for as long as it takes the owner to relaunch. Zero, rather than "undefined runs".
  const runs = loop.runs ?? 0
  const save = (patch: Partial<Pick<CardLoop, 'minutes' | 'prompt' | 'enabled'>>) => {
    actions.setLoop(projectId, {
      id: loop.id,
      sessionId: loop.sessionId,
      prompt: loop.prompt,
      minutes: loop.minutes,
      enabled: loop.enabled,
      ...patch,
    })
  }
  const commitMinutes = () => {
    const n = Math.round(Number(minutes))
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      setMinutes(String(loop.minutes))
      return
    }
    if (n !== loop.minutes) save({ minutes: n })
  }
  const commitPrompt = () => {
    const p = prompt.trim()
    if (!p) {
      setPrompt(loop.prompt)
      return
    }
    if (p !== loop.prompt) save({ prompt: p })
  }

  const last = loop.lastOutcome === 'typed' && loop.lastFiredAt
    ? `typed ${new Date(loop.lastFiredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : loop.lastOutcome ?? (loop.enabled ? 'waiting for the card' : 'off')

  return (
    <div className={`rail-loop ${loop.enabled ? '' : 'is-off'}`}>
      <div className="rail-loop__head">
        <button
          className="twisty rail-loop__fold"
          title={open ? 'Fold this loop away' : 'Open this loop'}
          aria-expanded={open}
          onClick={() => fold(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="rail-loop__card" title={card ? card.title : loop.sessionId}>
          {card ? card.title : 'card gone'}
        </span>
        {/* Folded, the head is the whole loop, so the count comes up to meet it rather than the row
            saying only which card it belongs to. */}
        {!open && (
          <span className="rail-loop__runs" title={`This loop has typed into the card ${runs} times`}>
            {runs}
          </span>
        )}
        {/*
          The state is a chip and never a button, because one control answered neither question.

          It was a checkbox labelled "On", which reads as either "this loop is on" or "press this to
          turn it on" and gives no way to tell which. The owner asked for the split in the same
          breath as the buttons: "make the 'on' button top right show if the loop is active or not".
          So this says what the loop IS, and the row at the bottom says what pressing something will
          DO.
        */}
        <span
          className={`rail-loop__state ${loop.enabled ? 'is-on' : ''}`}
          title={loop.enabled ? 'This loop is running' : 'This loop is stopped'}
        >
          <span className="dot" />
          {loop.enabled ? 'running' : 'stopped'}
        </span>
      </div>
      {open && (
      <>
      <label className="rail-loop__every">
        every
        <input
          type="number"
          min={1}
          max={1440}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={commitMinutes}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        minutes
      </label>
      <textarea
        className="rail-loop__prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={commitPrompt}
        title="What is typed into the card each time"
        spellCheck={false}
      />
      <div className="rail-loop__foot">
        <span className="rail-loop__last" title="The server's account of the last time this loop was due">
          {last}
        </span>
        {/*
          The count is of prompts actually typed, not of times the clock came round, which is the
          only version of the statistic worth the space: the interval is already on screen two lines
          up, so a count of intentions would be the clock said back to him. A loop that has been due
          nine times and held every time because the card was working reads zero, and the line to its
          left says why.
        */}
        <span
          className="rail-loop__runs"
          title={
            runs === 0
              ? 'This loop has not typed into the card yet'
              : `This loop has typed into the card ${runs} times`
          }
        >
          {runs} {runs === 1 ? 'run' : 'runs'}
        </span>
      </div>
      {/*
        Start, Stop and Delete in one line, laid out the way the owner drew it: "add start button to
        the loops section. put them all in line [start][stop][delete]". Two buttons rather than one
        that changes its word, so the one you want is always in the same place and pressing the
        wrong one is a no-op instead of the opposite of what you meant. The button matching the
        current state is disabled rather than hidden, so the row never reflows.
      */}
      <div className="rail-loop__buttons">
        <button
          className="btn"
          disabled={loop.enabled}
          title={
            loop.enabled
              ? 'This loop is already running'
              : 'Start this loop. The prompt goes into the card now, as soon as it is idle, so it ' +
                `knows what it is being asked to do; then again every ${loop.minutes} minutes.`
          }
          onClick={() => save({ enabled: true })}
        >
          Start
        </button>
        <button
          className="btn"
          disabled={!loop.enabled}
          title={
            loop.enabled
              ? 'Stop this loop. Nothing is typed into the card until it is started again.'
              : 'This loop is already stopped'
          }
          onClick={() => save({ enabled: false })}
        >
          Stop
        </button>
        <button
          className="btn"
          title="Delete this loop. The card is not touched."
          onClick={() => {
            if (window.confirm(`Delete the loop on ${card ? card.title : 'this card'}?`)) {
              actions.deleteLoop(projectId, loop.id)
            }
          }}
        >
          Delete
        </button>
      </div>
      </>
      )}
    </div>
  )
}

export function LoopsPanel({
  projectId,
  loops,
  cards,
}: {
  projectId: string
  loops: CardLoop[]
  cards: TerminalSession[]
}) {
  const [adding, setAdding] = useState<string>('')
  const [open, setOpen] = useState(() => folded().section !== true)
  const unlooped = cards.filter((c) => !loops.some((l) => l.sessionId === c.id))
  const running = loops.filter((l) => l.enabled).length

  /*
   * The section's own title, rather than the plain `h3` the other rail sections carry.
   *
   * It lives here so one component owns both folds and one key remembers them. Folded, the title
   * still says how many loops there are and how many are running, because a section that hides its
   * contents and says nothing about them is a section the owner has to open to find out whether
   * anything is happening.
   */
  const head = (
    <h3 className="rail-title rail-title--fold">
      <button
        className="twisty"
        title={open ? 'Fold the loops away' : 'Open the loops'}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          remember({ section: open })
        }}
      >
        {open ? '▾' : '▸'}
      </button>
      Loops
      {loops.length > 0 && (
        <span className={`rail-title__count ${running ? 'is-on' : ''}`} title={`${running} of ${loops.length} running`}>
          {running ? `${running}/${loops.length}` : String(loops.length)}
        </span>
      )}
    </h3>
  )

  if (!open) return head

  return (
    <>
    {head}
    <div className="rail-loops">
      {loops.map((l) => (
        <LoopRow key={l.id} projectId={projectId} loop={l} cards={cards} />
      ))}
      {loops.length === 0 && <p className="hint">No loops. A loop types a prompt into a card every few minutes while it is idle.</p>}
      <div className="rail-loop__new">
        <select
          value={adding}
          title="Add a loop on a card. It arrives stopped, every 15 minutes, with a prompt to edit before you start it."
          onChange={(e) => {
            const sessionId = e.target.value
            setAdding('')
            if (!sessionId) return
            actions.setLoop(projectId, {
              sessionId,
              prompt: 'Check in: read your inbox and your notes, do the next step of your open work, and stop at its end.',
              minutes: 15,
              // Stopped, because Start now types the prompt into the card immediately and the
              // prompt at this moment is a placeholder nobody has read. Add the loop, write what it
              // should say, then Start, which is the order the buttons are in.
              enabled: false,
            })
          }}
        >
          <option value="">Add a loop on a card…</option>
          {unlooped.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
    </div>
    </>
  )
}
