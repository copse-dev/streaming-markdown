export {
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
  setSanitizerBackend,
  isBrowserSanitizerSupported,
  hydratePendingDiagrams,
  hydratePendingMath,
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

// Registers the diagram backend; the mermaid library itself is resolved via the
// page's import map (it is an optional peer, never bundled) on first render.
export function loadMermaidBackend() {
  return import('../dist/mermaid-mermaidjs.js').then((m) => m.loadMermaid())
}

// Registers the KaTeX math backend; katex itself is resolved via the page's
// import map (optional peer, never bundled) the first time an expression
// renders. `loadKatex()` calls `setMathRenderer(katexMathRenderer)`, so this
// also flips the prose `$…$` / `$$…$$` math syntax fully on.
export function loadKatexBackend() {
  return import('../dist/math-katex.js').then((m) => m.loadKatex())
}

// The Shiki backend is a second CodeHighlighter over the same setCodeHighlighter
// registry as highlight.js. shiki's core/engine/theme/lang modules are resolved
// via the import map (optional peer, never bundled). We keep the module handle
// so shikiThemeCss() can read the loaded theme palette after the load resolves.
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

// Re-register the highlight.js backend as the active CodeHighlighter (used when
// toggling back from Shiki). Idempotent — the grammar chunk is fetched once;
// later calls just flip the registry pointer back to highlight.js.
export function useHighlightjs() {
  return loadHighlightBackend()
}
