import { actions, useApp } from '../state'

/**
 * Step two of opening a tab: choose the account before any session exists.
 *
 * This appears whenever the active project has no account bound and the machine offers more than
 * one. Two Claude accounts are billed separately, so the workspace stays deliberately empty until
 * the question is answered, rather than quietly defaulting and spending on the wrong one.
 *
 * A project whose folder matches an account's declared prefix is bound automatically, so this bar
 * only shows up when the answer genuinely is not known.
 */
export function AccountPrompt() {
  const projects = useApp((s) => s.projects)
  const profiles = useApp((s) => s.profiles)
  const activeProjectId = useApp((s) => s.activeProjectId)

  const defaultAccount = useApp((s) => s.defaultAccount)
  const project = projects.find((p) => p.id === activeProjectId)
  if (!project || project.profiles?.claude) return null

  const accounts = profiles.filter((p) => p.adapterId === 'claude')
  if (accounts.length < 2) return null

  /*
   * Never ask when there is a sensible answer already.
   *
   * An unbound project falls back to whichever account the CLI is signed in as, and the tab shows
   * that account at all times, so nothing is hidden by not asking. Being asked the same question
   * on every restart is worse than a default that is visible and one click to change.
   */
  if (defaultAccount?.email) return null

  return (
    <div className="acctbar">
      <span className="acctbar-label">
        Which Claude account should <strong>{project.name}</strong> use?
      </span>
      {accounts.map((a) => (
        <button
          key={a.id}
          className="btn btn--primary"
          title={a.accountEmail ? `${a.configDir}` : `${a.configDir} (not signed in yet)`}
          onClick={() => actions.setProjectProfile(project.id, 'claude', a.id)}
        >
          {a.accountEmail ?? `${a.name} (sign in)`}
        </button>
      ))}
      <span className="acctbar-hint">Asked once per tab. Every session here inherits it.</span>
    </div>
  )
}
