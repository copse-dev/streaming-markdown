import { JSDOM } from 'jsdom'
import { setDefaultConfig } from '../src/config.ts'

// jsdom-backed DOM globals for tests that exercise the markdown sanitizer.
// DOMPurify relies on a spec-complete DOM (HTML parsing + serialization), so any
// test that runs `sanitizeRenderedMarkdown` imports this setup to install jsdom
// globals and the DOMPurify backend. Node's test runner isolates each file in
// its own process, so these globals never leak into DOM-free test files.
const win = new JSDOM('').window
Object.assign(globalThis, {
  document: win.document,
  window: win,
  customElements: win.customElements,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
})

// jsdom has no native Sanitizer API (`Element.setHTML`), so the default backend
// is unavailable here — install the DOMPurify backend process-wide for tests, plus
// the highlight.js backend (tests assert hljs-span output). This is the
// `setDefaultConfig` "install once" seam — the deployment analogue of a Node/SSR
// host configuring its backends at startup; per-render config still overrides it.
// Import the backends only after the DOM globals above exist (DOMPurify binds to
// `window` at module evaluation time).
const { dompurifyBackend } = await import('../src/sanitize-dompurify.ts')
const { highlightjsHighlighter } = await import('../src/highlight-hljs.ts')
setDefaultConfig({
  sanitizerBackend: dompurifyBackend,
  codeHighlighter: highlightjsHighlighter,
})
