import { useState } from 'react'
import { actions, useApp } from '../state'
import { ContextMenu, type MenuState } from './ContextMenu'

/**
 * One tab per project, each showing the account its sessions run on.
 *
 * The account is not decoration. Two Claude accounts are billed separately, so a tab states
 * which one every session in it uses, and the server enforces it rather than trusting the UI.
 * A tab with no account bound says so plainly instead of implying a default is fine.
 */
export function ProjectTabs() {
  const projects = useApp((s) => s.projects)
  const profiles = useApp((s) => s.profiles)
  const sessions = useApp((s) => s.sessions)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const closed = useApp((s) => s.closedProjects)
  const boards = useApp((s) => s.boards)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** The tab waiting on a second press before it is closed. */
  const [confirm, setConfirm] = useState<{
    projectId: string
    name: string
    live: number
    x: number
    y: number
  } | null>(null)

  const defaultAccount = useApp((s) => s.defaultAccount)
  const claudeProfiles = profiles.filter((p) => p.adapterId === 'claude')

  // Name the signed-in account rather than calling it "default", which tells you nothing about
  // which of two separately billed accounts you are about to spend on.
  const defaultLabel = defaultAccount?.email ?? 'signed-in account (not signed in)'

  const accountMenu = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...claudeProfiles.map((p) => ({
          label: p.accountEmail ? `${p.name} — ${p.accountEmail}` : `${p.name} — not signed in`,
          onSelect: () => actions.setProjectProfile(projectId, 'claude', p.id),
        })),
        ...(claudeProfiles.length ? [{ separator: true as const, label: undefined }] : []),
        {
          label: 'New account profile',
          hint: 'sign in inside its first session',
          onSelect: () => {
            const name = prompt('Name this account profile (for example: Personal, Studio)')
            if (name) actions.createProfile(name, 'claude')
          },
        },
        {
          label: defaultLabel,
          hint: 'the one you already use',
          onSelect: () => actions.setProjectProfile(projectId, 'claude', null),
        },
      ],
    })
  }

  /**
   * Right-click a tab to close it: everything running in it stops, and it leaves the row.
   *
   * Asked twice, in the menu itself rather than through a browser dialog. This is the most
   * destructive button in the app, it can be hit by aiming slightly wrong at the account pill next
   * to it, and what it ends is live processes doing work. The second step says how many, because
   * "three sessions" is the number that makes someone stop and think and "are you sure" is not.
   */
  const tabMenu = (e: React.MouseEvent, projectId: string, name: string, count: number) => {
    e.preventDefault()
    e.stopPropagation()
    const live = sessions.filter((s) => s.projectId === projectId && s.pid !== null).length
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Save this board',
          hint: 'cards, positions and wires, into the Garden directory',
          onSelect: () => actions.saveBoard(projectId, name),
        },
        ...(boards.length
          ? [
              {
                label: 'Open a saved board',
                submenu: boards.map((b) => ({
                  label: b.name,
                  hint: `${b.cards} cards, ${new Date(b.savedAt).toLocaleString()}`,
                  onSelect: () => actions.openBoard(b.file),
                })),
              },
            ]
          : []),
        ...(closed.length
          ? [
              {
                label: 'Reopen a closed tab',
                submenu: closed.map((p) => ({
                  label: p.name,
                  hint: p.path,
                  onSelect: () => actions.reopenProject(p.id),
                })),
              },
            ]
          : []),
        { separator: true as const },
        {
          label: `Close "${name}"`,
          hint:
            count === 0
              ? 'nothing is on this board'
              : `${count} card${count === 1 ? '' : 's'}${live ? `, ${live} still running` : ', none running'}`,
          /*
           * The second step lives in its own state rather than replacing this menu's.
           * A menu clears itself once something in it is chosen, and that happens after the
           * handler runs, so a confirmation put back into the same state was wiped the instant it
           * appeared and the first click silently did nothing.
           */
          onSelect: () => setConfirm({ projectId, name, live, x: e.clientX, y: e.clientY }),
        },
      ],
    })
  }

  return (
    <div className="tabs">
      {projects.map((p) => {
        const profile = profiles.find((x) => x.id === p.profiles?.claude)
        // Cards on the board, which is what the tab is a count of. Closed cards live in the rail's
        // own list and counting them here made the tab read 4 beside a board holding 3.
        const count = sessions.filter((s) => s.projectId === p.id && s.closedAt === null).length
        const active = p.id === activeProjectId
        return (
          <button
            key={p.id}
            className={`tab ${active ? 'is-active' : ''}`}
            onClick={() => actions.setActiveProject(p.id)}
            onContextMenu={(e) => tabMenu(e, p.id, p.name, count)}
            title={p.path}
          >
            <span className="tab-swatch" style={{ background: p.color }} />
            <span className="tab-name">{p.name}</span>
            {count > 0 && <span className="tab-count">{count}</span>}
            <span
              className={`tab-account ${profile?.accountEmail || defaultAccount?.email ? '' : 'is-unset'}`}
              title={
                profile
                  ? `Every session in this tab runs as ${profile.accountEmail ?? 'this profile (not signed in yet)'}`
                  : defaultAccount?.email
                    ? `Every session in this tab runs as ${defaultAccount.email}. Click to change.`
                    : 'No account bound. Click to choose one.'
              }
              onClick={(e) => accountMenu(e, p.id)}
            >
              {profile
                ? profile.accountEmail ?? `${profile.name} (sign in)`
                : defaultAccount?.email ?? 'set account'}
            </span>
          </button>
        )
      })}

      {/*
       * Opening a tab is three different things, so it asks which.
       *
       * A folder is the way a new project starts. The other two are the ones the owner asked for:
       * a board he saved from inside Garden, and a tab he closed earlier whose layout is still
       * sitting there intact. Hiding those behind a folder dialog would mean the only way back to
       * a flow he built was to remember which directory it belonged to.
       */}
      <button
        className="tab tab--add"
        title="Open a project, a saved board, or a tab you closed"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              {
                label: 'Open a project folder',
                hint: 'the Windows folder dialog',
                onSelect: () => actions.pickProject(),
              },
              ...(boards.length
                ? [
                    { separator: true as const },
                    {
                      label: 'Saved boards',
                      hint: `${boards.length} saved in the Garden directory`,
                      submenu: boards.map((b) => ({
                        label: b.name,
                        hint: `${b.cards} cards, ${new Date(b.savedAt).toLocaleString()}`,
                        onSelect: () => actions.openBoard(b.file),
                      })),
                    },
                  ]
                : []),
              ...(closed.length
                ? [
                    {
                      label: 'Tabs you closed',
                      hint: 'their boards are exactly as you left them',
                      submenu: closed.map((p) => ({
                        label: p.name,
                        hint: p.path,
                        onSelect: () => actions.reopenProject(p.id),
                      })),
                    },
                  ]
                : []),
            ],
          })
        }}
      >
        +
      </button>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

      {/* The second press. Separate so choosing from the first menu cannot close this one. */}
      <ContextMenu
        state={
          confirm
            ? {
                x: confirm.x,
                y: confirm.y,
                items: [
                  {
                    label: confirm.live
                      ? `Yes, stop ${confirm.live} running session${confirm.live === 1 ? '' : 's'} and close it`
                      : 'Yes, close it',
                    hint: 'the board is kept; reopen it from this menu whenever',
                    onSelect: () => actions.closeProject(confirm.projectId),
                  },
                  { label: 'Keep it', onSelect: () => {} },
                ],
              }
            : null
        }
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}
