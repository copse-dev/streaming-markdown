import { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'
import {
  MAX_DIAGRAM_SOURCE_LENGTH,
  parseRenderRequest,
  type FrameFont,
  type MermaidTheme,
} from './mermaid-frame-protocol.ts'

/** Structural interface: Mermaid remains an optional peer, supplied only inside the frame bundle. */
export interface FrameMermaid {
  initialize(config: {
    startOnLoad: boolean
    securityLevel: 'strict'
    maxTextSize: number
    theme: MermaidTheme
    fontFamily: string
    themeVariables: { fontFamily: string }
  }): void
  run(options: { nodes: HTMLElement[]; suppressErrors: boolean }): Promise<void>
}
export interface MermaidRunnerOptions {
  theme?: MermaidTheme
  fontFamily?: string
  /** Host-owned inert fallback presentation; never receives returned SVG. */
  onError?: (container: HTMLElement, source: string) => void
}

/** Only call within the isolated frame; exported separately for host rendering parity tests. */
export function createMermaidRunner(
  mermaid: FrameMermaid,
  options: MermaidRunnerOptions = {},
): (root: ParentNode) => Promise<void> {
  let initialized = false
  return async (root) => {
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])'),
    )
    if (!nodes.length) return
    if (!initialized) {
      const fontFamily = options.fontFamily ?? 'sans-serif'
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        maxTextSize: MAX_DIAGRAM_SOURCE_LENGTH,
        theme: options.theme ?? 'default',
        fontFamily,
        themeVariables: { fontFamily },
      })
      initialized = true
    }
    for (const node of nodes) {
      const container = node.closest<HTMLElement>('.mermaid-diagram')
      if (!container) continue
      const source = prepareMermaidSource(node.textContent ?? '')
      let rendered = false
      if (source.length <= MAX_DIAGRAM_SOURCE_LENGTH) {
        for (const candidate of mermaidSourceCandidates(source)) {
          node.textContent = candidate
          node.removeAttribute('data-processed')
          try {
            await mermaid.run({ nodes: [node], suppressErrors: true })
            if (container.querySelector('svg') && !container.querySelector('.error-icon')) {
              node.dataset['processed'] = 'true'
              rendered = true
              break
            }
          } catch {
            /* Try the alternate source, then fail inertly. */
          }
        }
      }
      if (!rendered) {
        if (options.onError) options.onError(container, source)
        else throw new Error('Diagram could not be rendered')
      }
    }
  }
}

export interface MermaidFrameRuntimeOptions extends MermaidRunnerOptions {
  mermaid: FrameMermaid
  /** Trusted bootstrap hook, e.g. install bundled font bytes before layout. No URL fetching. */
  prepare?: () => Promise<void>
}

/**
 * Register font bytes the host sent with a render request. A FontFace built from a buffer is not a
 * fetch, so the frame's `font-src 'none'` stays as it is. A face that fails to load leaves the
 * diagram on its fallback family rather than failing the render.
 */
async function installFont(font: FrameFont): Promise<void> {
  try {
    const face = new FontFace(font.family, font.data)
    document.fonts.add(await face.load())
  } catch {
    /* Render with the fallback family. */
  }
}

/**
 * Install once in the hash-pinned frame bootstrap, never in the parent app. The options are the
 * frame's defaults; a render request may choose its own theme, font family and font bytes (see
 * `RenderRequest`), so one prebuilt document serves every host presentation.
 */
export function startMermaidFrame(options: MermaidFrameRuntimeOptions): () => void {
  let disposed = false
  let activePort: MessagePort | undefined
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent || event.ports.length !== 1) return
    const request = parseRenderRequest(event.data)
    const port = event.ports[0]
    if (request === null || !port) return
    const { source } = request
    const runnerOptions: MermaidRunnerOptions = { ...options }
    if (request.theme) runnerOptions.theme = request.theme
    if (request.fontFamily) runnerOptions.fontFamily = request.fontFamily
    const run = createMermaidRunner(options.mermaid, runnerOptions)
    window.removeEventListener('message', receive)
    activePort = port
    void (async () => {
      try {
        await options.prepare?.()
        if (request.font) await installFont(request.font)
        if (disposed) return
        const diagram = document.createElement('div')
        diagram.className = 'mermaid-diagram'
        const pre = document.createElement('pre')
        pre.className = 'mermaid'
        pre.textContent = source
        diagram.append(pre)
        document.body.replaceChildren(diagram)
        await run(diagram)
        if (disposed) return
        const svg = diagram.querySelector('svg')
        if (!svg) throw new Error('No diagram')
        const box = svg.viewBox.baseVal
        const width = box.width || svg.getBoundingClientRect().width
        const height = box.height || svg.getBoundingClientRect().height
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.maxWidth = 'none'
        port.postMessage({ type: 'rendered', width, height })
      } catch {
        if (!disposed) port.postMessage({ type: 'failed' })
      } finally {
        port.close()
        activePort = undefined
      }
    })()
  }
  window.addEventListener('message', receive)
  return () => {
    disposed = true
    window.removeEventListener('message', receive)
    activePort?.close()
  }
}
