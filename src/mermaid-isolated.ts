import {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_LENGTH,
  parseDiagramSize,
  type DiagramSize,
  type MermaidTheme,
} from './mermaid-frame-protocol.ts'

export {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_LENGTH,
  MAX_FONT_BYTES,
  MERMAID_THEMES,
  parseDiagramSize,
  parseDiagramSource,
  parseRenderRequest,
} from './mermaid-frame-protocol.ts'
export type { DiagramSize, MermaidTheme, RenderRequest } from './mermaid-frame-protocol.ts'

export interface MermaidFrameOptions {
  /**
   * Trusted, host-packaged document: the prebuilt `diagrams/mermaid/frame.html`, or one produced by
   * buildMermaidFrameHtml. Never model input.
   */
  url: string
  layoutWidth?: number
  signal?: AbortSignal
  /** Mermaid theme for this diagram. Defaults to the frame's own (`default` for the prebuilt one). */
  theme?: MermaidTheme
  /** CSS font-family list for labels, e.g. `Inter, sans-serif`. Names, spaces, commas and quotes only. */
  fontFamily?: string
  /**
   * Font bytes to install in the frame for this diagram, e.g. a woff2 the host already ships. The
   * frame's `font-src 'none'` cannot load URLs. Name it in `fontFamily` to use it. The bytes are
   * copied, so one buffer can serve many frames.
   */
  font?: { family: string; data: ArrayBuffer | ArrayBufferView }
  /** Accessible name for the frame. Defaults to `Mermaid diagram`; pass a localized, descriptive one. */
  title?: string
}

function copyBytes(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0)
  const copy = new Uint8Array(data.byteLength)
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return copy.buffer
}

export interface DiagramFrame {
  element: HTMLIFrameElement
  ready: Promise<DiagramSize>
  /** Closes pending channels, rejects pending readiness and removes the frame. Idempotent. */
  dispose(): void
}

/**
 * Render source in an opaque realm. No SVG or actions are accepted from the child.
 * The host must separately block frame navigation (CSP is not a navigation firewall).
 * This API does not change the legacy in-document DiagramRenderer integration.
 */
export function createMermaidFrame(source: string, options: MermaidFrameOptions): DiagramFrame {
  const element = document.createElement('iframe')
  element.className = 'mermaid-frame'
  element.title = options.title ?? 'Mermaid diagram'
  // The frame document declares no color-scheme, so it renders light. In a dark page the iframe's
  // used scheme is dark (`normal` resolves to the page's scheme), and a mismatch makes the browser
  // paint an opaque backdrop behind the frame: a white box around every diagram. Matching it keeps
  // the frame transparent, so the diagram sits on whatever the host paints behind it.
  element.style.colorScheme = 'light'
  element.setAttribute('sandbox', 'allow-scripts')
  element.setAttribute('referrerpolicy', 'no-referrer')
  element.setAttribute('tabindex', '-1')
  element.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  )
  const layoutWidth = options.layoutWidth ?? 300
  const width =
    Number.isFinite(layoutWidth) && layoutWidth > 0
      ? Math.min(layoutWidth, MAX_DIAGRAM_DIMENSION)
      : 300
  element.style.width = `${String(width)}px`
  let cancel = (): void => {}
  const dispose = (): void => {
    cancel()
    element.remove()
  }
  const ready = new Promise<DiagramSize>((resolve, reject) => {
    if (source.length > MAX_DIAGRAM_SOURCE_LENGTH || options.signal?.aborted) {
      reject(new Error('Diagram source is too large or rendering was cancelled'))
      return
    }
    const channel = new MessageChannel()
    let settled = false
    const observer = new MutationObserver((records) => {
      if (
        !element.isConnected &&
        records.some((record) =>
          Array.from(record.removedNodes).some(
            (node) => node === element || node.contains(element),
          ),
        )
      )
        dispose()
    })
    const finish = (size: DiagramSize | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      observer.disconnect()
      options.signal?.removeEventListener('abort', dispose)
      channel.port1.close()
      channel.port2.close()
      element.onload = null
      element.onerror = null
      if (size) {
        element.style.width = `${String(size.width)}px`
        element.style.aspectRatio = `${String(size.width)} / ${String(size.height)}`
        element.style.height = 'auto'
        element.dataset['rendered'] = 'true'
        resolve(size)
      } else reject(new Error('Diagram frame did not render'))
    }
    const timer = setTimeout(() => finish(null), 30_000)
    cancel = () => finish(null)
    channel.port1.onmessage = (event: MessageEvent<unknown>): void =>
      finish(parseDiagramSize(event.data))
    channel.port1.onmessageerror = cancel
    element.onerror = cancel
    element.onload = (): void => {
      element.onload = null
      try {
        // An opaque origin requires '*'; this targets one exact window and private port.
        // The frame validates every optional field (see parseRenderRequest) and drops bad ones.
        const font = options.font
          ? { family: options.font.family, data: copyBytes(options.font.data) }
          : undefined
        element.contentWindow?.postMessage(
          {
            type: 'render',
            source,
            theme: options.theme,
            fontFamily: options.fontFamily,
            font,
          },
          '*',
          font ? [channel.port2, font.data] : [channel.port2],
        )
      } catch {
        finish(null)
      }
    }
    options.signal?.addEventListener('abort', dispose, { once: true })
    observer.observe(document, { childList: true, subtree: true })
    element.src = options.url
  })
  return { element, ready, dispose }
}

/** Attribute recording a diagram's isolated state: `deferred`, `pending`, `rendered` or `failed`. */
export const ISOLATED_DIAGRAM_ATTRIBUTE = 'data-isolated-diagram'

/** Class a diagram carries once its frame has rendered (its source `<pre>` is gone). */
export const ISOLATED_DIAGRAM_CLASS = 'mermaid-diagram--isolated'

/** Deferred mounting: when a closed fence gets its frame. Defaults mirror Streamdown's. */
export interface LazyDiagramsOptions {
  /** How close to the viewport a diagram must come, as an IntersectionObserver margin (`300px`). */
  rootMargin?: string
  /** How long it must stay that close before mounting, in ms (300), so a fast scroll mounts nothing. */
  debounce?: number
  /** Upper bound on waiting for an idle moment once due, in ms (500). */
  idleTimeout?: number
}

export interface IsolatedDiagramsOptions extends Omit<MermaidFrameOptions, 'layoutWidth' | 'signal'> {
  /**
   * Mount a diagram's frame only once it nears the viewport, then at an idle moment. Each frame
   * starts its own Mermaid, so a long thread with many diagrams otherwise pays for all of them up
   * front. A deferred diagram shows its source and has state `deferred`. Off by default; `true`
   * uses the defaults of {@link LazyDiagramsOptions}. Ignored where IntersectionObserver is missing.
   */
  lazy?: boolean | LazyDiagramsOptions
  /**
   * Called once per diagram when its frame has rendered or failed, e.g. to add host controls. A
   * failed diagram keeps its escaped source as the inert fallback.
   */
  onSettled?: (diagram: HTMLElement, state: 'rendered' | 'failed', frame: DiagramFrame) => void
}

/** Closed mermaid fences awaiting a frame: not forming, not inside the streaming tail, not mounted. */
const MOUNTABLE_SELECTOR =
  `.mermaid-diagram.mermaid-diagram--pending:not(.stream-fence-forming):not([${ISOLATED_DIAGRAM_ATTRIBUTE}])`

/**
 * Mount an isolated frame into every closed mermaid fence under `root` that does not have one
 * yet. Call it after each streaming `update()` (or once after an at-rest render); repeat calls are
 * cheap and idempotent.
 *
 * Only a diagram whose fence has closed is mounted: the forming fence and anything in the
 * streaming tail are skipped, because the renderer still reconciles those. A closed fence is
 * frozen, so the frame survives later updates. While the frame renders, the source stays visible
 * and the frame is held out of layout; once ready, the source is removed and the diagram gets
 * {@link ISOLATED_DIAGRAM_CLASS}. On failure the frame is disposed and the source stays as the inert
 * fallback. Frames removed with their diagram dispose themselves.
 *
 * Do not also configure a `diagramRenderer` for the same render: the two paths would race for
 * the same scaffolding.
 */
export function mountIsolatedDiagrams(root: ParentNode, options: IsolatedDiagramsOptions): void {
  const { lazy, ...rest } = options
  const deferral =
    lazy && typeof IntersectionObserver === 'function'
      ? { rootMargin: '300px', debounce: 300, idleTimeout: 500, ...(lazy === true ? {} : lazy) }
      : null
  for (const diagram of Array.from(root.querySelectorAll<HTMLElement>(MOUNTABLE_SELECTOR))) {
    if (diagram.closest('.stream-forming, .stream-pending')) continue
    const pre = diagram.querySelector<HTMLElement>(':scope > pre.mermaid')
    if (!pre) continue
    if (deferral) deferMount(diagram, pre, rest, deferral)
    else mountFrame(diagram, pre, rest)
  }
}

const requestIdle = (callback: () => void, timeout: number): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout })
  else setTimeout(callback, 1)
}

function deferMount(
  diagram: HTMLElement,
  pre: HTMLElement,
  options: Omit<IsolatedDiagramsOptions, 'lazy'>,
  { rootMargin, debounce, idleTimeout }: Required<LazyDiagramsOptions>,
): void {
  diagram.setAttribute(ISOLATED_DIAGRAM_ATTRIBUTE, 'deferred')
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.at(-1)?.isIntersecting) {
        clearTimeout(timer)
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => {
        observer.disconnect()
        requestIdle(() => {
          // The renderer may have rebuilt the message meanwhile; the new copy mounts on its own.
          if (diagram.isConnected && diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE) === 'deferred')
            mountFrame(diagram, pre, options)
        }, idleTimeout)
      }, debounce)
    },
    { rootMargin, threshold: 0 },
  )
  observer.observe(diagram)
}

function mountFrame(
  diagram: HTMLElement,
  pre: HTMLElement,
  options: Omit<IsolatedDiagramsOptions, 'lazy'>,
): void {
  const { onSettled, ...frameOptions } = options
  diagram.setAttribute(ISOLATED_DIAGRAM_ATTRIBUTE, 'pending')
  const frame = createMermaidFrame(pre.textContent ?? '', {
    ...frameOptions,
    ...(diagram.clientWidth > 0 ? { layoutWidth: diagram.clientWidth } : {}),
  })
  // Out of layout until it has a size; the source stays on screen meanwhile.
  frame.element.style.position = 'absolute'
  frame.element.style.visibility = 'hidden'
  diagram.append(frame.element)
  frame.ready.then(
    () => {
      pre.remove()
      frame.element.style.removeProperty('position')
      frame.element.style.removeProperty('visibility')
      diagram.classList.remove('mermaid-diagram--pending')
      diagram.classList.add(ISOLATED_DIAGRAM_CLASS)
      diagram.setAttribute(ISOLATED_DIAGRAM_ATTRIBUTE, 'rendered')
      onSettled?.(diagram, 'rendered', frame)
    },
    () => {
      frame.dispose()
      diagram.setAttribute(ISOLATED_DIAGRAM_ATTRIBUTE, 'failed')
      onSettled?.(diagram, 'failed', frame)
    },
  )
}
