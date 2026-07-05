import { JSDOM } from 'jsdom'
import { setSanitizerBackend } from '../src/sanitize.ts'

// jsdom-backed DOM globals for tests that exercise the markdown sanitizer.
// DOMPurify relies on a spec-complete DOM (HTML parsing + serialization); the
// lighter happy-dom used by `setup-dom.ts` mis-parses sanitized output, so any
// test that runs `sanitizeRenderedMarkdown` must use this setup instead. Node's
// test runner isolates each file in its own process, so this does not affect
// the happy-dom globals used elsewhere.
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
// is unavailable here — register the DOMPurify backend for tests. Import it only
// after the DOM globals above exist, since DOMPurify binds to `window` at module
// evaluation time.
const { dompurifyBackend } = await import('../src/sanitize-dompurify.ts')
setSanitizerBackend(dompurifyBackend)

// Syntax highlighting is now a lazily-loaded backend (see docs/LAZY-LOADING.md):
// the core renders plain text until one is registered. Tests assert highlighted
// (hljs span) output, so register the highlight.js backend up front — the
// deployment analogue of a host calling `loadHighlightjs()` at startup.
const { installHighlightjs } = await import('../src/highlight-hljs.ts')
installHighlightjs()
