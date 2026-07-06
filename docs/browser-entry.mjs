export {
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
  setSanitizerBackend,
  isBrowserSanitizerSupported,
  hydratePendingDiagrams,
} from '../dist/index.js'

export { dompurifyBackend } from '../dist/sanitize-dompurify.js'

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
