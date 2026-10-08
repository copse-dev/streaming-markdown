/**
 * Optional diagram viewer: zoom, pan, reset and full screen for a rendered diagram — an isolated
 * frame (`mountIsolatedDiagrams` / `createMermaidFrame`) or an in-document SVG. Plain DOM, no
 * framework, behind its own subpath (`diagrams/mermaid/viewer`).
 *
 * The diagram element itself is the viewport. The frame is never re-parented, because moving an
 * iframe in the DOM reloads it: the toolbar is inserted before it and the view is applied as a
 * transform on it. Styles are set through the CSSOM (allowed under a CSP without
 * `'unsafe-inline'` for styles), and only the functional ones; `styles/diagram-viewer.css` is an
 * optional cosmetic layer over the class hooks.
 */

export interface DiagramViewerLabels {
  /** Accessible name of the controls group. */
  toolbar: string
  zoomIn: string
  zoomOut: string
  reset: string
  fullscreen: string
}

export interface DiagramViewerOptions {
  /** Button and group names, for localization. Defaults are English. */
  labels?: Partial<DiagramViewerLabels>
  /** Show the built-in buttons (default `true`). Without them, drive the returned handle. */
  controls?: boolean
  /** Mouse-wheel zoom over the diagram (default `true`). */
  wheel?: boolean
  /** Positive finite zoom bounds (defaults 0.5 and 3); minScale must not exceed maxScale. */
  minScale?: number
  maxScale?: number
  /** Scale change per button press, wheel notch or `+`/`-` key (default 0.25). */
  step?: number
}

export interface DiagramViewer {
  readonly scale: number
  zoomBy(step: number): void
  panBy(dx: number, dy: number): void
  /** Clear panning and restore 100% zoom, clamped to the configured bounds. */
  reset(): void
  /** Removes the controls and listeners and restores the diagram's view. Idempotent. */
  dispose(): void
}

export const DIAGRAM_VIEWER_CLASS = 'mermaid-viewer'

const DEFAULT_LABELS: DiagramViewerLabels = {
  toolbar: 'Diagram controls',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  reset: 'Reset zoom',
  fullscreen: 'View full screen',
}

const KEY_PAN = 40

/**
 * Attach a viewer to `diagram`, the element holding the rendered frame or SVG as a direct child.
 * Throws if there is nothing rendered to view, or a RangeError for invalid zoom bounds.
 */
export function attachDiagramViewer(diagram: HTMLElement, options: DiagramViewerOptions = {}): DiagramViewer {
  const found = diagram.querySelector<HTMLElement | SVGSVGElement>(':scope > iframe, :scope > svg')
  if (!found) throw new Error('attachDiagramViewer: no rendered diagram to view')
  const target = found
  const labels = { ...DEFAULT_LABELS, ...options.labels }
  const minScale = options.minScale ?? 0.5
  const maxScale = options.maxScale ?? 3
  const step = options.step ?? 0.25
  if (!Number.isFinite(minScale) || !Number.isFinite(maxScale) || minScale <= 0 || maxScale < minScale)
    throw new RangeError('attachDiagramViewer: invalid zoom bounds')
  const initialScale = Math.min(maxScale, Math.max(minScale, 1))
  let scale = initialScale
  let x = 0
  let y = 0

  const saved = {
    overflow: diagram.style.overflow,
    touchAction: diagram.style.touchAction,
    cursor: diagram.style.cursor,
    tabIndex: diagram.getAttribute('tabindex'),
    transform: target.style.transform,
    transformOrigin: target.style.transformOrigin,
    pointerEvents: target.style.pointerEvents,
  }
  diagram.classList.add(DIAGRAM_VIEWER_CLASS)
  diagram.style.overflow = 'hidden'
  diagram.style.touchAction = 'none'
  diagram.style.cursor = 'grab'
  if (saved.tabIndex === null) diagram.tabIndex = 0
  target.style.transformOrigin = 'center center'
  // A frame must not take the pointer: the drag is the diagram's, and a click inside an isolated
  // frame could navigate it.
  target.style.pointerEvents = 'none'

  const buttons: Partial<Record<'zoomIn' | 'zoomOut' | 'reset' | 'fullscreen', HTMLButtonElement>> = {}
  const apply = (): void => {
    target.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    diagram.dataset['viewerScale'] = String(scale)
    if (buttons.zoomIn) buttons.zoomIn.disabled = scale >= maxScale
    if (buttons.zoomOut) buttons.zoomOut.disabled = scale <= minScale
    if (buttons.reset) buttons.reset.disabled = scale === initialScale && x === 0 && y === 0
  }
  const viewer: DiagramViewer = {
    get scale() {
      return scale
    },
    zoomBy(delta) {
      scale = Math.min(maxScale, Math.max(minScale, Math.round((scale + delta) * 1000) / 1000))
      apply()
    },
    panBy(dx, dy) {
      x += dx
      y += dy
      apply()
    },
    reset() {
      scale = initialScale
      x = 0
      y = 0
      apply()
    },
    dispose,
  }

  let toolbar: HTMLElement | null = null
  if (options.controls !== false) {
    toolbar = document.createElement('div')
    toolbar.className = `${DIAGRAM_VIEWER_CLASS}__toolbar`
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', labels.toolbar)
    const button = (
      name: keyof typeof buttons,
      glyph: string,
      label: string,
      action: () => void,
    ): void => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `${DIAGRAM_VIEWER_CLASS}__button ${DIAGRAM_VIEWER_CLASS}__button--${name}`
      el.setAttribute('aria-label', label)
      el.title = label
      el.textContent = glyph
      el.addEventListener('click', action)
      buttons[name] = el
      toolbar!.append(el)
    }
    button('zoomOut', '−', labels.zoomOut, () => viewer.zoomBy(-step))
    button('zoomIn', '+', labels.zoomIn, () => viewer.zoomBy(step))
    button('reset', '↺', labels.reset, () => viewer.reset())
    if (document.fullscreenEnabled && typeof diagram.requestFullscreen === 'function')
      button('fullscreen', '⛶', labels.fullscreen, () => void diagram.requestFullscreen())
    diagram.insertBefore(toolbar, target)
  }

  const fromToolbar = (event: Event): boolean =>
    !!toolbar && event.target instanceof Node && toolbar.contains(event.target)
  const onWheel = (event: WheelEvent): void => {
    if (fromToolbar(event)) return
    event.preventDefault()
    viewer.zoomBy(event.deltaY > 0 ? -step : step)
  }
  let drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false || fromToolbar(event)) return
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y }
    diagram.setPointerCapture?.(event.pointerId)
    diagram.dataset['viewerPanning'] = ''
    diagram.style.cursor = 'grabbing'
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return
    event.preventDefault()
    x = drag.x + event.clientX - drag.startX
    y = drag.y + event.clientY - drag.startY
    apply()
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return
    drag = null
    diagram.releasePointerCapture?.(event.pointerId)
    delete diagram.dataset['viewerPanning']
    diagram.style.cursor = 'grab'
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== diagram || event.altKey || event.ctrlKey || event.metaKey) return
    const handled: Record<string, () => void> = {
      '+': () => viewer.zoomBy(step),
      '=': () => viewer.zoomBy(step),
      '-': () => viewer.zoomBy(-step),
      '0': () => viewer.reset(),
      ArrowLeft: () => viewer.panBy(KEY_PAN, 0),
      ArrowRight: () => viewer.panBy(-KEY_PAN, 0),
      ArrowUp: () => viewer.panBy(0, KEY_PAN),
      ArrowDown: () => viewer.panBy(0, -KEY_PAN),
    }
    const action = handled[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  if (options.wheel !== false) diagram.addEventListener('wheel', onWheel, { passive: false })
  diagram.addEventListener('pointerdown', onPointerDown)
  diagram.addEventListener('pointermove', onPointerMove)
  diagram.addEventListener('pointerup', onPointerUp)
  diagram.addEventListener('pointercancel', onPointerUp)
  diagram.addEventListener('keydown', onKeyDown)
  apply()

  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    diagram.removeEventListener('wheel', onWheel)
    diagram.removeEventListener('pointerdown', onPointerDown)
    diagram.removeEventListener('pointermove', onPointerMove)
    diagram.removeEventListener('pointerup', onPointerUp)
    diagram.removeEventListener('pointercancel', onPointerUp)
    diagram.removeEventListener('keydown', onKeyDown)
    toolbar?.remove()
    diagram.classList.remove(DIAGRAM_VIEWER_CLASS)
    delete diagram.dataset['viewerScale']
    delete diagram.dataset['viewerPanning']
    diagram.style.overflow = saved.overflow
    diagram.style.touchAction = saved.touchAction
    diagram.style.cursor = saved.cursor
    if (saved.tabIndex === null) diagram.removeAttribute('tabindex')
    target.style.transform = saved.transform
    target.style.transformOrigin = saved.transformOrigin
    target.style.pointerEvents = saved.pointerEvents
  }

  return viewer
}
