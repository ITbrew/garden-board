import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Finding } from '@garden/shared'
import { dismissFinding, getFindings, getKeeper, onFindings, pauseKeeper } from '../findings'
import { useApp } from '../state'

/**
 * What the watchdog has noticed, at the top of the rail. docs/canonical/27-the-overseer.md.
 *
 * Every board shows every finding, because most of them are about the machine or the server, which
 * all boards share; a finding about a card names the card. Repairs the watchdog made itself
 * (`info`) are listed too, so the owner can see what was done without being asked.
 */
export function HealthPanel() {
  const findings = useSyncExternalStore(onFindings, getFindings)
  const keeper = useSyncExternalStore(onFindings, getKeeper)
  const sessions = useApp((s) => s.sessions)
  const [open, setOpen] = useState<string | null>(null)
  useTicker(findings.length > 0, 30_000)

  const needsLooking = findings.filter((f) => f.severity !== 'info').length
  const titleOf = (f: Finding) => sessions.find((s) => s.id === f.subject)?.title ?? null

  return (
    <section className="rail-section">
      <h3 className="rail-title rail-title--fold health-title">
        Health
        <span className={`rail-title__count${needsLooking ? ' is-warn' : ' is-on'}`}>
          {needsLooking ? `${needsLooking} open` : 'all clear'}
        </span>
      </h3>
      {/* The Keeper, when one is hired: what it is doing, and the owner's one switch over it. */}
      {keeper.present && (
        <div className={`health-keeper${keeper.paused ? ' is-paused' : ''}`}>
          <span className="health-keeper__text">
            Keeper {keeper.paused ? 'paused' : keeper.running ? 'watching' : 'off, wakes on the next finding'}
          </span>
          <button className="health-keeper__toggle" onClick={() => pauseKeeper(!keeper.paused)}>
            {keeper.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}
      {findings.length === 0 ? (
        <p className="hint">Nothing wrong right now.</p>
      ) : (
        <ul className="list list--scroll health">
          {findings.map((f) => {
            const card = titleOf(f)
            const expanded = open === f.id
            return (
              <li key={f.id} className={`health-row health-row--${f.severity}`}>
                <button className="health-row__main" onClick={() => setOpen(expanded ? null : f.id)} aria-expanded={expanded}>
                  <span className="health-row__dot" aria-hidden />
                  <span className="health-row__text">
                    <span className="health-row__title">{f.title}</span>
                    <span className="health-row__meta">
                      {[
                        card && !f.title.includes(card) ? card : null,
                        f.count > 1 ? `${f.count} times` : null,
                        ago(f.lastSeen),
                        f.state === 'handled' ? 'handled' : f.state === 'escalated' ? 'needs you' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
                <button className="health-row__dismiss" title="Dismiss for an hour" aria-label="Dismiss" onClick={() => dismissFinding(f.id)}>
                  ×
                </button>
                {expanded && (f.detail || f.note) && (
                  <div className="health-row__detail">
                    {f.detail && <p>{f.detail}</p>}
                    {f.note && <p className="health-row__note">{f.note}</p>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** Re-render on an interval while there is something whose "3 min ago" would otherwise go stale. */
function useTicker(active: boolean, ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [active, ms])
}
