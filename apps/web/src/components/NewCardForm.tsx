import { useEffect, useMemo, useRef, useState } from 'react'
import { ROLE_CHAIN, ROLE_POWERS, type TerminalSession } from '@garden/shared'
import { actions } from '../state'

/**
 * Making a card by saying what it is for.
 *
 * The launcher buttons in the rail make a terminal and start it, which is the right thing when the
 * owner wants a shell. It is the wrong thing for building a team, because a card's restrictions are
 * read by the CLI once, at launch: a card started first and given a role afterwards runs its whole
 * first session with none of that role's denials, and a manager that could edit files for a session
 * will have edited files. So the role is chosen before anything starts.
 *
 * The form states what each role loses, quoted from the same table that writes the deny list into
 * the settings file. Two copies of that text is what once had Garden telling every manager in
 * writing that its editing tools were denied while its shell was wide open.
 *
 * Two fields make a card: what it is for, and what to call it. Everything below that is a sensible
 * default folded behind "More options" rather than a second, smaller form, because a card made
 * quickly is not made differently, it is made with fewer questions asked out loud. The nine-field
 * blueprint case is still exactly this form, just unfolded.
 */
export interface NewCardRequest {
  projectId: string
  /** Where the card should land, in board coordinates, from wherever he right-clicked. */
  x: number
  y: number
}

const MODELS = [
  { id: '', label: 'whatever the CLI defaults to' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

const EFFORTS = [
  { id: '', label: 'the CLI default' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
]

export function NewCardForm({
  request,
  sessions,
  onClose,
  onCreate,
}: {
  request: NewCardRequest | null
  sessions: TerminalSession[]
  onClose: () => void
  /**
   * Told the project id the instant a card is actually asked for, not when the form opens, so
   * whatever is watching for the new card to arrive is not left waiting on one that Cancel threw
   * away.
   */
  onCreate: (projectId: string) => void
}) {
  const [role, setRole] = useState('worker')
  const [title, setTitle] = useState('')
  const [adapterId, setAdapterId] = useState<'claude' | 'codex' | 'shell'>('claude')
  const [reportsTo, setReportsTo] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [teamSize, setTeamSize] = useState('')
  const [owned, setOwned] = useState('')
  const [roots, setRoots] = useState('')
  /*
   * On by default here, and deliberately off by default where `garden-hire` makes a card for an
   * agent. The two disagree on purpose, not by drift: this box is under his own pointer, and
   * "easier card creation" means fewer clicks between wanting one and having it working, which a
   * card that appears switched off and waits for a second click is not. The off-by-default rule
   * guards against an agent quietly spending a context window on his behalf before he has seen the
   * card appear; his own hand on this button is not that case, he has already decided. The
   * checkbox stays reachable behind "More options" for the blueprint session that wants a team
   * laid out before anything runs.
   */
  const [start, setStart] = useState(true)
  /*
   * Fast is the resting state. Two fields, a role's own brief quoted rather than retyped, and a
   * button. Everything from "Runs on" down is a real setting with a sensible default already
   * chosen, folded away rather than removed, so the nine-field blueprint case is one click further
   * rather than a form this one no longer offers.
   */
  const [advanced, setAdvanced] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  const powers = ROLE_POWERS[role]
  const canHire = powers?.hires ?? false

  /*
   * Who this role would normally answer to, offered rather than imposed.
   *
   * Picking a role is nearly always enough to say where the card belongs, and having to remember
   * the shape of the chain every time is how a card ends up wired to nothing. The owner can still
   * choose anyone, or nobody, and the wires are what actually permit a message either way.
   */
  const suggested = useMemo(() => {
    const answersTo = ROLE_CHAIN.find((r) => r.id === role)?.answersTo
    if (!answersTo || !request) return ''
    const inProject = sessions.filter((s) => s.projectId === request.projectId)
    return inProject.find((s) => s.roleClass === answersTo)?.id ?? ''
  }, [role, request, sessions])

  useEffect(() => setReportsTo(suggested), [suggested])

  useEffect(() => {
    if (request) {
      // A fresh open always starts fast, whatever the last card made from this form needed.
      setAdvanced(false)
      setTimeout(() => titleRef.current?.focus(), 30)
    }
  }, [request])

  if (!request) return null

  const options = sessions.filter((s) => s.projectId === request.projectId && s.kind === 'session')

  const submit = () => {
    /*
     * One path per line, blank lines dropped. The field is left out entirely when nothing was
     * typed rather than sent as an empty array: the server reads an empty list and a missing one
     * the same way, as null, but null means no limit while an empty list would read as a card that
     * may write nowhere, and only one of those is what an empty box meant.
     */
    const ownedPaths = owned
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)

    actions.createRoleCard({
      projectId: request.projectId,
      adapterId,
      title: title.trim() || undefined,
      roleClass: role as TerminalSession['roleClass'],
      reportsTo: reportsTo || null,
      modelChoice: model || null,
      effortChoice: effort || null,
      teamSize: teamSize === '' ? null : Math.max(0, Math.min(20, Number(teamSize) || 0)),
      ...(ownedPaths.length ? { ownedPaths } : {}),
      // Left out entirely when blank, so a card with no brief is stored as having none rather than
      // as having an empty one.
      ...(roots.trim() ? { roots: roots.trim() } : {}),
      start,
      x: request.x,
      y: request.y,
    })
    onCreate(request.projectId)
    onClose()
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="newcard"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          /*
           * Enter submits from anywhere, since this is a short form, except inside the owned paths
           * box. That one is the only multi-line field here, and a form that submitted on the
           * newline separating two paths could never be given a second path.
           */
          if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) submit()
        }}
      >
        <div className="newcard__head">
          <span className="newcard__title">New card</span>
          <button className="newcard__x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <label className="newcard__row">
          <span>What is it for</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLE_CHAIN.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        {/*
         * What the role actually costs it, from the table that writes the deny list. Shown before
         * the card is made, because this is the decision that cannot be changed later without
         * restarting the session.
         */}
        {powers && (
          <div className="newcard__powers">
            <p className="newcard__summary">{powers.summary}</p>
            <p className="newcard__denies">
              <strong>Denied by the CLI:</strong> {powers.denies.join(', ')}
            </p>
            <p className="newcard__enforced">{powers.enforced}</p>
          </div>
        )}

        <label className="newcard__row">
          <span>Called</span>
          <input
            ref={titleRef}
            value={title}
            placeholder={`${ROLE_CHAIN.find((r) => r.id === role)?.label ?? 'Card'}`}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

            {/*
          What this card is for, and it is now the only thing it will know.
          A card no longer loads the project's CLAUDE.md or the user's, so a card made with this
          box empty starts with nothing but its generated powers. That is deliberate and it is
          the whole point of the change, but it makes this field the difference between a card
          that knows its job and one that has to work it out.
        */}
        <label className="newcard__row">
          <span>Brief</span>
          <div>
            <textarea
              value={roots}
              rows={5}
              spellCheck={false}
              placeholder={
                'What this card is for, what it owns, who it answers to.\n\nLeave empty and it starts knowing only its powers.'
              }
              onChange={(e) => setRoots(e.target.value)}
            />
            <em
              style={{
                display: 'block',
                fontStyle: 'normal',
                fontSize: 11,
                lineHeight: 1.5,
                marginTop: 4,
                color: 'var(--text-faint)',
              }}
            >
              Written into this card's own CLAUDE.md and handed to it at startup. It does not
              inherit the project's instructions or yours, so what is here is what it knows.
            </em>
          </div>
        </label>

        {/*
         * The fold. Everything past this point already has a sensible default chosen above or
         * below: claude, whoever the role naturally answers to, no path limit, whatever the
         * account defaults to, no hiring cap, switched off. Opening it changes nothing by itself,
         * it only lets those defaults be overridden before the card exists rather than after.
         */}
        <button type="button" className="newcard__more" onClick={() => setAdvanced((v) => !v)}>
          <span className={`newcard__more-caret ${advanced ? 'is-open' : ''}`} aria-hidden="true">
            ▸
          </span>
          {advanced ? 'Fewer options' : 'More options: runs on, answers to, model, effort, hiring, start now'}
        </button>

        {advanced && (
          <>
            <label className="newcard__row">
              <span>Runs on</span>
              <select value={adapterId} onChange={(e) => setAdapterId(e.target.value as typeof adapterId)}>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="shell">Shell</option>
              </select>
            </label>

            <label className="newcard__row">
              <span>Answers to</span>
              <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
                <option value="">nobody, the owner talks to it</option>
                {options.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {s.roleClass ? ` (${s.roleClass})` : ''}
                  </option>
                ))}
              </select>
            </label>

            {/*
             * The part of the project this card is responsible for, one project-relative path per
             * line.
             *
             * Empty for every role, deliberately, with no per-role default. The division the owner
             * describes is that a boss owns the repo, a manager owns an area and a worker owns
             * files, but which area or which files belongs to the job the card is being made for
             * and not to its role, so anything pre-filled here would be a guess arriving as a
             * decision already taken. It would also land hardest on a worker, which is the role
             * most likely to need to touch several files at once, and switching a restriction on
             * for it is the opposite of what was asked for. An empty box narrows nothing.
             */}
            <label className="newcard__row">
              <span>Owns</span>
              <div>
                <textarea
                  value={owned}
                  rows={3}
                  spellCheck={false}
                  placeholder={'everything\n\nor, one per line:\nsrc/components/\ndocs/plan.md'}
                  onChange={(e) => setOwned(e.target.value)}
                />
                <em
                  style={{
                    display: 'block',
                    fontStyle: 'normal',
                    fontSize: 11,
                    lineHeight: 1.5,
                    marginTop: 4,
                    color: 'var(--text-faint)',
                  }}
                >
                  Optional. Leave it empty and the card may write anywhere in the project, which is
                  the normal case. Fill it in and the editing tools narrow to it: Write, Edit,
                  MultiEdit and NotebookEdit are refused outside the list. Bash is not, because
                  nothing can tell in advance which files a shell command will write. Reading is
                  never limited.
                </em>
              </div>
            </label>

            <label className="newcard__row">
              <span>Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="newcard__row">
              <span>Effort</span>
              <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                {EFFORTS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>

            {/*
             * Only offered to a role that can hire at all. A number next to a role whose hiring
             * tool is denied would read as a setting that does something, and it does not.
             */}
            {canHire && (
              <label className="newcard__row">
                <span>Helpers at a time</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={teamSize}
                  placeholder="no cap"
                  onChange={(e) => setTeamSize(e.target.value)}
                />
              </label>
            )}

            <label className="newcard__check">
              <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
              <span>
                Start it now
                <em>
                  {start ? 'the process launches with these restrictions' : 'lays the card out and spends nothing'}
                </em>
              </span>
            </label>
          </>
        )}

        <div className="newcard__foot">
          <button className="newcard__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="newcard__make" onClick={submit}>
            Make the card
          </button>
        </div>
      </div>
    </div>
  )
}
