import { useEffect, useSyncExternalStore } from 'react'
import {
  dismissFirstRun,
  firstRunDismissed,
  firstRunDone,
  firstRunSnapshot,
  markFirstRun,
  onFirstRun,
  type FirstRunStep,
} from '../firstrun'
import { useApp } from '../state'

/**
 * Five steps, and the list is the owner's: "1. seclect project. 2 create new orhcestrator card 3.
 * have orchestrator create a second card 4. wire tutorial. 5. right click tutorial", with "simple as
 * possible" after it.
 *
 * Every line is an instruction for something to do on the board, not a description of a feature. A
 * newcomer with a board in front of them does not need to be told what a wire is for; they need to
 * be told to drag from the dot.
 *
 * Step three is the one that is not like the others and is the reason the list is shaped this way.
 * Every other step is something the person does. That one is something they ask a card to do, and
 * watching a second card appear on the board because the first one hired it is the only way to learn
 * what this board is for. Canon 23 has the longer argument.
 */
const STEPS: Array<{ key: FirstRunStep; title: string; body: string }> = [
  {
    key: 'project',
    title: 'Open a project',
    body: 'Press + in the tab strip along the top, then "Open a project folder". A project is the folder your cards run in, and everything below needs one.',
  },
  {
    key: 'orchestrator',
    title: 'Make an orchestrator card',
    body: 'Right-click the empty board, then "New role card", then orchestrator. It is a real terminal running in your project folder. Type into it the way you would type into any terminal.',
  },
  {
    key: 'hired',
    title: 'Ask it to make a second card',
    body: 'Tell the orchestrator what you want built and ask it to hire someone for it. A second card appears on the board, wired to the first. This is the thing Garden does that a terminal does not.',
  },
  {
    key: 'wire',
    title: 'Wire two cards together',
    body: 'Drag from the dot on one card’s side to another card. A wire is not a diagram: it is the permission that lets one card send to the other. Right-click a wire to make it one way.',
  },
  {
    key: 'rightClick',
    title: 'Right-click things',
    body: 'Two menus, and almost everything lives in them. On the board: new terminals, new files, Tidy layout. On a card: Open terminal, which puts its terminal in the panel below, plus turning it on and off, its colour, and what it runs from.',
  },
]

/**
 * A corner panel, and never a modal.
 *
 * A modal would have to be got rid of before the board could be touched, and every step here is
 * done on the board. Covering the board to explain the board is self-defeating, and the reflex it
 * teaches is to dismiss the thing without reading it.
 */
export function FirstRun() {
  const sessions = useApp((s) => s.sessions)
  const wires = useApp((s) => s.wires)
  const activeProjectId = useApp((s) => s.activeProjectId)

  useSyncExternalStore(onFirstRun, firstRunSnapshot, firstRunSnapshot)

  /*
   * Two steps are facts about the board rather than things remembered here, so they are read off it
   * and then written down.
   *
   * Written down rather than only read, because canon 23 forbids un-ticking: a user who makes a
   * card, wires it, and then deletes both should not be told they have not made a card. Reading the
   * board is how the step becomes true; recording it is how it stays true.
   *
   * In an effect rather than during render, since `markFirstRun` notifies subscribers and a store
   * that changes while React is rendering is how a render loop starts.
   */
  const mine = sessions.filter((s) => !activeProjectId || s.projectId === activeProjectId)
  /*
   * An orchestrator is a card whose role says so, not a card that happens to be first. The role is
   * chosen when the card is made and stored on the row, so this is the board's own answer rather
   * than a guess from the title.
   */
  const hasOrchestrator = mine.some((s) => s.roleClass === 'orchestrator')
  /*
   * A card that another card brought into existence, which is what `parentId` records. Counting to
   * two cards instead would tick this step for somebody who made both by hand, and the step is not
   * "there are two cards", it is "one of your cards hired the other".
   */
  const hasHired = mine.some((s) => s.parentId != null)
  const hasWire = wires.length > 0
  useEffect(() => {
    if (activeProjectId) markFirstRun('project')
  }, [activeProjectId])
  useEffect(() => {
    if (hasOrchestrator) markFirstRun('orchestrator')
  }, [hasOrchestrator])
  useEffect(() => {
    if (hasHired) markFirstRun('hired')
  }, [hasHired])
  useEffect(() => {
    if (hasWire) markFirstRun('wire')
  }, [hasWire])

  const done = STEPS.filter((s) => firstRunDone(s.key)).length

  /*
   * Gone for good once every step is done, and gone for now if it is dismissed.
   *
   * It used to return null with no project open, on the reasoning that there was nothing to do any
   * of this on. That was backwards and the owner said so: with no project open the panel is at its
   * most useful, because opening one is the step nobody can guess and the only one that unblocks the
   * rest. It draws with the first step open instead.
   */
  if (firstRunDismissed()) return null
  if (done === STEPS.length) return null

  /*
   * The first outstanding step is the open one. Everything above it is ticked and everything below
   * is a title, so the panel stays the size of one instruction however many steps there are, and
   * the thing to do next is the thing being read.
   */
  const nextIndex = STEPS.findIndex((s) => !firstRunDone(s.key))

  return (
    <aside className="firstrun" aria-label="Getting started">
      <header className="firstrun__head">
        <h2>Getting started</h2>
        {/*
          "done", explicitly, because without it the number reads as which step you are on and
          contradicts the list. A blind reader with two ticked and the third open put it plainly:
          the header said 2 of 6 while the bold step was the third, and the two signals did not
          agree. One word settles which question the number is answering.
        */}
        <span className="firstrun__count">
          {done} of {STEPS.length} done
        </span>
        <button
          className="firstrun__close"
          title="Hide this. It will not come back."
          aria-label="Hide getting started"
          onClick={dismissFirstRun}
        >
          x
        </button>
      </header>
      <ol className="firstrun__list">
        {STEPS.map((step, i) => {
          const ticked = firstRunDone(step.key)
          return (
            <li
              key={step.key}
              className={`firstrun__step ${ticked ? 'is-done' : ''} ${i === nextIndex ? 'is-next' : ''}`}
            >
              {/*
                A tick, or this step's number. Nothing in between: every one of these is set by the
                thing having happened, so there is no "in progress" state to draw and inventing one
                would be the panel guessing.

                Numbered rather than bulleted, after a blind reader was shown this panel and did not
                take the open step to be one of the six at all. It read as a section heading above a
                list of five, because it is the only row carrying a paragraph and a dot said nothing
                about where it sat. A number says "this is the first of six" against a header that
                already says how many are done, and the two now agree in front of the reader rather
                than in the code.
              */}
              <span className="firstrun__mark" aria-hidden="true">
                {ticked ? '✓' : i + 1}
              </span>
              <div className="firstrun__text">
                <span className="firstrun__title">{step.title}</span>
                {i === nextIndex && <p className="firstrun__body">{step.body}</p>}
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
