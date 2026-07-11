import { mermaidSourceCandidates } from './mermaid-source.ts'
import { setHostTrustedHtml, type TrustedHTMLValue } from './html-sink.ts'

// PROTOTYPE (#lazy-load): the diagram-renderer registry, the mermaid analogue of
// the pluggable code highlighter. Unlike highlight.js, the mermaid *library* is
// never bundled by this package — the generator only emits inert scaffolding
// (`<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">…`)
// and the source-prep helpers in `mermaid-source.ts` are pure strings. Mermaid is
// therefore already lazy by construction; what was missing is an *official* hook
// so hosts stop hand-rolling the "find pending diagrams, load mermaid, inject SVG,
// retry on the aggressive source candidate" dance.
//
// This module is the core: it carries no mermaid code. The mermaid backend lives
// in `mermaid-mermaidjs.ts` behind the `@copse/streaming-markdown/diagrams/mermaid`
// entry (`mermaidDiagramRenderer`, `loadMermaid`), which
// dynamically imports `mermaid` — the "lazy load" fetched only when a host opts in.

/** Result of rendering one diagram: the trusted SVG markup produced by the backend. */
export interface DiagramRenderResult {
  svg: string
}

/**
 * Pluggable diagram renderer. `render` turns prepared diagram *source* into SVG.
 * It may throw for a source the backend's parser rejects — {@link hydratePendingDiagrams}
 * retries with the aggressive source candidate before giving up. Rendering is async
 * because the mermaid library is (`mermaid.render` returns a promise).
 *
 * Obtain one from `loadMermaid()` (`@copse/streaming-markdown/diagrams/mermaid`)
 * and pass it via `MarkdownConfig.diagramRenderer` (streaming `hydrate()`) or the
 * {@link HydrateDiagramsOptions.renderer} option.
 */
export interface DiagramRenderer {
  render(source: string): Promise<DiagramRenderResult>
}

/** Container the generator emits for a diagram fence, awaiting hydration. */
export const PENDING_DIAGRAM_SELECTOR = '.mermaid-diagram.mermaid-diagram--pending'

/** Options for {@link hydratePendingDiagrams}. */
export interface HydrateDiagramsOptions {
  /**
   * The {@link DiagramRenderer} to hydrate with — obtain one from `loadMermaid()`
   * (`@copse/streaming-markdown/diagrams/mermaid`) and pass it per hydration call.
   * When omitted (or `null`), hydration is a no-op returning 0.
   */
  renderer?: DiagramRenderer | null
  /**
   * Post-process the backend's SVG before it is injected. Mermaid SVG is produced
   * by the trusted library *after* sink sanitization and is not re-sanitized by
   * default (see the design invariant); a safety-conscious host can pass a
   * transform here to run it through its own SVG sanitizer.
   *
   * Under Trusted Types enforcement this transform is *required*: the SVG
   * bypasses the markdown sanitizer, so this package never blesses it with its
   * own policy — return a `TrustedHTML` minted by a host policy (e.g.
   * `DOMPurify.sanitize(svg, { RETURN_TRUSTED_TYPE: true })`) or the injection
   * will be rejected by the page's CSP.
   */
  transformSvg?: (svg: string) => string | TrustedHTMLValue
}

/** Read a pending container's diagram source from its `<pre class="mermaid">`. */
function readDiagramSource(container: Element): string {
  // textContent is already entity-decoded, so `A --&gt; B` reads back as `A --> B`.
  return container.querySelector('pre.mermaid')?.textContent ?? ''
}

function markRendered(container: Element, svg: string | TrustedHTMLValue): void {
  container.classList.remove('mermaid-diagram--pending')
  container.classList.add('mermaid-diagram--rendered')
  setHostTrustedHtml(container, svg)
}

function markError(container: Element): void {
  container.classList.remove('mermaid-diagram--pending')
  container.classList.add('mermaid-diagram--error')
}

/**
 * Hydrate every pending diagram under `root` (inclusive) with the registered
 * {@link DiagramRenderer}. For each, the gentle then aggressive source candidates
 * ({@link mermaidSourceCandidates}) are tried until one renders; the container is
 * flipped to `mermaid-diagram--rendered` with the SVG injected, or to
 * `mermaid-diagram--error` if every candidate throws. Returns the number of
 * diagrams successfully rendered. A no-op returning 0 when no
 * {@link HydrateDiagramsOptions.renderer} is supplied — pending diagrams keep
 * their inert source `<pre>`.
 */
export async function hydratePendingDiagrams(
  root: Element,
  options: HydrateDiagramsOptions = {},
): Promise<number> {
  const renderer = options.renderer
  if (!renderer) return 0

  const containers: Element[] = []
  if (root.matches(PENDING_DIAGRAM_SELECTOR)) containers.push(root)
  containers.push(...root.querySelectorAll(PENDING_DIAGRAM_SELECTOR))

  let rendered = 0
  for (const container of containers) {
    const rawSource = readDiagramSource(container)
    if (rawSource.trim() === '') continue
    let ok = false
    for (const candidate of mermaidSourceCandidates(rawSource)) {
      let svg: string
      try {
        ;({ svg } = await renderer.render(candidate))
      } catch {
        // Try the next (more aggressive) candidate before declaring failure.
        continue
      }
      // Injection failures are candidate-independent — e.g. Trusted Types
      // rejecting a plain-string SVG because transformSvg did not return a
      // TrustedHTML — so fail the diagram without re-rendering every
      // candidate just to hit the same sink error.
      try {
        markRendered(container, options.transformSvg ? options.transformSvg(svg) : svg)
        ok = true
        rendered++
      } catch {
        // fall through to markError below
      }
      break
    }
    if (!ok) markError(container)
  }
  return rendered
}
