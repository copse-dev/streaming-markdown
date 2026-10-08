import {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_LENGTH,
  parseDiagramSize,
  type DiagramSize,
} from './mermaid-frame-protocol.ts'

export {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_LENGTH,
  parseDiagramSize,
  parseDiagramSource,
} from './mermaid-frame-protocol.ts'
export type { DiagramSize } from './mermaid-frame-protocol.ts'

export interface MermaidFrameOptions {
  /** Trusted, host-packaged document produced by buildMermaidFrameHtml. Never model input. */
  url: string
  layoutWidth?: number
  signal?: AbortSignal
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
  element.title = 'Mermaid diagram'
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
        element.contentWindow?.postMessage({ type: 'render', source }, '*', [channel.port2])
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
