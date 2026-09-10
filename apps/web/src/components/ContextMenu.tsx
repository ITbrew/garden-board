import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  /** Absent only on separators. */
  label?: string
  onSelect?: () => void
  /** Renders as a separator when true; every other field is ignored. */
  separator?: boolean
  disabled?: boolean
  /** Destructive entries sit apart and are styled as a warning. */
  danger?: boolean
  submenu?: MenuItem[]
  hint?: string
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/**
 * A right-click menu. Closes on any outside click, Escape, scroll, or after an item runs, and
 * flips itself back on screen when opened near an edge.
 */
export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [openSub, setOpenSub] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!state) return
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.min(state.x, window.innerWidth - width - 8),
      y: Math.min(state.y, window.innerHeight - height - 8),
    })
    setOpenSub(null)
  }, [state])

  useEffect(() => {
    if (!state) return
    /*
     * Close on a press anywhere outside the menu.
     *
     * Capture phase, because the canvas's own pan handler consumes pointer events and a bubbling
     * listener never saw a click on empty space. Capture runs before the target's own handlers
     * though, so this MUST ignore presses inside the menu: an earlier version did not, and it
     * closed the menu before any item's click could fire, which silently broke every entry.
     */
    const close = (e: Event) => {
      const el = ref.current
      if (el && e.target instanceof globalThis.Node && el.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Capture phase, and pointerdown as well as mousedown: the canvas's own pan handler consumes
    // pointer events, so a plain bubbling mousedown listener never saw a click on empty space.
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('mousedown', close, true)
    window.addEventListener('wheel', close as EventListener, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('wheel', close as EventListener)
      window.removeEventListener('keydown', onKey)
    }
  }, [state, onClose])

  if (!state) return null

  const run = (item: MenuItem) => {
    if (item.disabled || item.separator) return
    if (item.submenu) return
    item.onSelect?.()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ctxmenu__sep" />
        ) : (
          <div
            key={i}
            className={`ctxmenu__item ${item.disabled ? 'is-disabled' : ''} ${item.danger ? 'is-danger' : ''}`}
            onMouseEnter={() => setOpenSub(item.submenu ? i : null)}
            onClick={() => run(item)}
          >
            <span className="ctxmenu__label">{item.label}</span>
            {item.hint && <span className="ctxmenu__hint">{item.hint}</span>}
            {item.submenu && <span className="ctxmenu__arrow">›</span>}

            {item.submenu && openSub === i && (
              <div className="ctxmenu ctxmenu--sub">
                {item.submenu.map((sub, j) => (
                  <div
                    key={j}
                    className={`ctxmenu__item ${sub.disabled ? 'is-disabled' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (sub.disabled) return
                      sub.onSelect?.()
                      onClose()
                    }}
                  >
                    <span className="ctxmenu__label">{sub.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  )
}
