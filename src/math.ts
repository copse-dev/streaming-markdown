import { setHostTrustedHtml, type TrustedHTMLValue } from './html-sink.ts'

// The math-renderer registry (#70): the KaTeX analogue of the pluggable diagram
// renderer. Like mermaid, the KaTeX *library* is never bundled by this package —
// the generator only emits inert scaffolding
// (`<div class="math-block math-block--pending"><pre class="math">…` for display
// math, `<span class="math-inline math-inline--pending">…` for inline math), so
// math support is already lazy by construction. This module is the core: it
// carries no KaTeX code, only the registry and the hydration walk.
//
// The KaTeX backend lives in `math-katex.ts` behind the
// `@copse/streaming-markdown/math/katex` entry (`katexMathRenderer`,
// `loadKatex`), which dynamically imports `katex` — fetched only
// when a host opts in.

/** Result of rendering one math expression: trusted HTML produced by the backend. */
export interface MathRenderResult {
  html: string
}

/** Options handed to a {@link MathRenderer} for one expression. */
export interface MathRenderOptions {
  /** Display (block) mode for `$$…$$` / `\[…\]` / ```` ```math ```` scaffolding; inline otherwise. */
  displayMode: boolean
}

/**
 * Pluggable math renderer. `render` turns TeX *source* into HTML. It may throw
 * for source the backend rejects — {@link hydratePendingMath} marks the
 * container errored and leaves the escaped source visible. Rendering is async
 * so a backend can lazy-load its library on first use.
 *
 * Obtain one from `loadKatex()` (`@copse/streaming-markdown/math/katex`) and pass
 * it via `MarkdownConfig.mathRenderer` (streaming `hydrate()`) or the
 * {@link HydrateMathOptions.renderer} option. Pair with `mathSyntax: true` to
 * turn on the prose `$…$` grammar.
 */
export interface MathRenderer {
  render(source: string, options: MathRenderOptions): Promise<MathRenderResult>
}

/** Containers/spans the generator emits for math, awaiting hydration. */
export const PENDING_MATH_SELECTOR =
  '.math-block.math-block--pending, .math-inline.math-inline--pending'

/** Options for {@link hydratePendingMath}. */
export interface HydrateMathOptions {
  /**
   * The {@link MathRenderer} to hydrate with — obtain one from `loadKatex()`
   * (`@copse/streaming-markdown/math/katex`) and pass it per hydration call.
   * When omitted (or `null`), hydration is a no-op returning 0.
   */
  renderer?: MathRenderer | null
  /**
   * Post-process the backend's HTML before it is injected. KaTeX HTML is
   * produced by the trusted library *after* sink sanitization and is not
   * re-sanitized by default (the same trust boundary as mermaid SVG); a
   * safety-conscious host can pass a transform here to run it through its own
   * sanitizer.
   *
   * Under Trusted Types enforcement this transform is *required*: the HTML
   * bypasses the markdown sanitizer, so this package never blesses it with its
   * own policy — return a `TrustedHTML` minted by a host policy (e.g.
   * `DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: true })`) or the injection
   * will be rejected by the page's CSP.
   */
  transformHtml?: (html: string) => string | TrustedHTMLValue
}

/** Read a pending element's TeX source (block scaffolding wraps it in `pre.math`). */
function readMathSource(el: Element): string {
  // textContent is already entity-decoded, so `a &lt; b` reads back as `a < b`.
  return (el.querySelector('pre.math') ?? el).textContent ?? ''
}

function markError(el: Element, kind: string): void {
  el.classList.remove(`${kind}--pending`)
  el.classList.add(`${kind}--error`)
}

/**
 * Hydrate every pending math container/span under `root` (inclusive) with the
 * registered {@link MathRenderer}. Display mode follows the scaffolding: block
 * containers (`math-block`) render with `displayMode: true`, inline spans
 * (`math-inline`) without. Each element is flipped to `--rendered` (HTML
 * injected) or `--error` (escaped source left visible — the graceful
 * fallback for TeX the backend rejects). Returns the number of expressions
 * successfully rendered. A no-op returning 0 when no {@link HydrateMathOptions.renderer}
 * is supplied.
 */
export async function hydratePendingMath(
  root: Element,
  options: HydrateMathOptions = {},
): Promise<number> {
  const renderer = options.renderer
  if (!renderer) return 0

  const targets: Element[] = []
  if (root.matches(PENDING_MATH_SELECTOR)) targets.push(root)
  targets.push(...root.querySelectorAll(PENDING_MATH_SELECTOR))

  let rendered = 0
  for (const el of targets) {
    const kind = el.classList.contains('math-block') ? 'math-block' : 'math-inline'
    const source = readMathSource(el)
    if (source.trim() === '') continue
    let html: string
    try {
      ;({ html } = await renderer.render(source, { displayMode: kind === 'math-block' }))
    } catch {
      markError(el, kind)
      continue
    }
    // Injection failures (e.g. Trusted Types rejecting a plain-string HTML
    // because transformHtml did not return a TrustedHTML) also fall back to
    // the escaped-source error state; the sink throws before mutating, so the
    // inert source stays visible.
    try {
      setHostTrustedHtml(el, options.transformHtml ? options.transformHtml(html) : html)
    } catch {
      markError(el, kind)
      continue
    }
    el.classList.remove(`${kind}--pending`)
    el.classList.add(`${kind}--rendered`)
    rendered++
  }
  return rendered
}
