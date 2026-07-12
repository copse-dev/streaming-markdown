export {
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
  isBrowserSanitizerSupported,
  hydratePendingDiagrams,
  hydratePendingMath,
  // The at-rest ("naive") renderer and the reference sanitized sink. The
  // playground (docs/playground.html) drives the naive baseline pane with
  // `setSanitizedHtml(el, renderMarkdown(prefix))` on every chunk — a
  // full-subtree replace of the whole partial — to contrast the flash-of-raw
  // -syntax / relayout jank against the incremental StreamingMarkdownRenderer.
  renderMarkdown,
  setSanitizedHtml,
  // Registers a process-wide default config. The playground uses it to install
  // the DOMPurify sanitizer backend once, up front, on engines without the
  // native Sanitizer API — so `setSanitizedHtml` (which re-sanitizes at its own
  // sink using the ambient config, not a per-call one) resolves a backend too.
  setDefaultConfig,
} from '../dist/index.js'

export { dompurifyBackend } from '../dist/sanitize-dompurify.js'

// The OPTIONAL input smoother (#84). It ships behind the
// '@copse/streaming-markdown/smoothing' subpath and is never in the main entry,
// so importing it here mirrors a host adding `import { createInputSmoother }
// from '@copse/streaming-markdown/smoothing'`. It carries no external
// dependency (unlike the CDN peers above), so the demo pulls it in eagerly
// rather than lazily — there is no network cost to defer.
export { createInputSmoother } from '../dist/smoothing.js'

// Lazy backends (see docs/LAZY-LOADING.md). These dynamic imports become
// separate code-split chunks under esbuild --splitting, so the demo fetches
// them over the network only when first called — the same shape a bundler
// gives a real host importing '@copse/streaming-markdown/highlighters/highlightjs'
// or '.../diagrams/mermaid'.
export function loadHighlightBackend() {
  return import('../dist/highlight-hljs.js').then((m) => m.loadHighlightjs())
}

// Returns the mermaid `DiagramRenderer` (the demo passes it as
// `MarkdownConfig.diagramRenderer` to `hydrate()` / `hydratePendingDiagrams()`);
// the mermaid library itself is resolved via the page's import map (it is an
// optional peer, never bundled) on first render.
export function loadMermaidBackend() {
  return import('../dist/mermaid-mermaidjs.js').then((m) => m.loadMermaid())
}

// Returns the KaTeX `MathRenderer`; katex itself is resolved via the page's
// import map (optional peer, never bundled) the first time an expression
// renders. The demo captures the returned renderer and passes it as
// `MarkdownConfig.mathRenderer` to `hydrate()` / `hydratePendingMath()`. Turning
// the prose `$…$` grammar on is the separate, explicit `{ mathSyntax: true }`
// config knob (the demo sets it when it detects math).
export function loadKatexBackend() {
  return import('../dist/math-katex.js').then((m) => m.loadKatex())
}

// Returns a second `CodeHighlighter` (Shiki) the demo passes as
// `MarkdownConfig.codeHighlighter`, alongside the highlight.js backend. shiki's
// core/engine/theme/lang modules are resolved via the import map (optional peer,
// never bundled). We keep the module handle so shikiThemeCss() can read the
// loaded theme palette after the load resolves.
let shikiModule = null
export function loadShikiBackend(options) {
  return import('../dist/highlight-shiki.js').then((m) => {
    shikiModule = m
    return m.loadShiki(options)
  })
}

// The theme stylesheet for the loaded Shiki theme (host-injected style, not
// sanitized markdown). Returns '' until loadShikiBackend() has resolved.
export function shikiThemeCss() {
  return shikiModule ? shikiModule.shikiThemeCss() : ''
}

// Resolve the highlight.js `CodeHighlighter` again (used when toggling back from
// Shiki). Idempotent — the grammar chunk is fetched once; later calls just
// return the same backend, which the demo threads back into
// `MarkdownConfig.codeHighlighter`.
export function useHighlightjs() {
  return loadHighlightBackend()
}
