import type { RenderOptions } from 'pele'
import type { DiagramRenderer } from './mermaid.ts'

/**
 * Default Pele diagram backend. Colors come from --pele-* CSS variables, rather
 * than Mermaid themes. This adapter uses the existing in-document hydration
 * path; it does not replace the isolated Mermaid frame runtime.
 */
export type PeleDiagramOptions = Pick<
  RenderOptions,
  'fontFamily' | 'fontFamilyMono' | 'fontSize' | 'limit' | 'outputLimit' | 'maxEdges'
>

let diagramSeq = 0

/**
 * Create a renderer with host-owned font and resource limits. Links and images
 * are disabled by this backend. SVG insertion still uses the host's
 * transformSvg hook, including its Trusted Types policy where required.
 *
 * Pele loads only on the first render. No Pele code enters the core bundle.
 * Container-aware layout is not exposed by DiagramRenderer yet.
 */
export function createPeleDiagramRenderer(options: PeleDiagramOptions = {}): DiagramRenderer {
  const settings = { ...options }
  return {
    async render(source) {
      const { render } = await import('pele')
      const { svg } = render(source, {
        ...settings,
        links: false,
        images: false,
        idPrefix: `smd-pele-${String(++diagramSeq)}`,
      })
      return { svg }
    },
  }
}

export const peleDiagramRenderer: DiagramRenderer = createPeleDiagramRenderer()

/** Return the renderer; the optional Pele peer loads on its first render. */
export function loadPele(): Promise<DiagramRenderer> {
  return Promise.resolve(peleDiagramRenderer)
}
