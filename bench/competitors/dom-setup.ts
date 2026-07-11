// jsdom globals for the cross-library DOM benchmark (#157).
//
// Unlike tests/setup-dom-jsdom.ts this deliberately does NOT register a syntax
// highlighter: react-markdown and smd render code blocks as plain text by
// default, so our renderer runs unhighlighted too and the DOM tier compares
// markdown work, not highlighter choice (Streamdown's built-in highlighting is
// part of its defaults and is left enabled — see docs/BENCHMARKS.md).
//
// `pretendToBeVisual` provides requestAnimationFrame; the observer/matchMedia
// shims below are no-ops that React-based competitors probe for at mount time.
import { JSDOM } from 'jsdom'
import { setSanitizerBackend } from '../../src/sanitize.ts'

const win = new JSDOM('', { url: 'https://bench.invalid/', pretendToBeVisual: true }).window

Object.assign(globalThis, {
  document: win.document,
  window: win,
  customElements: win.customElements,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  SVGElement: win.SVGElement,
  Node: win.Node,
  MutationObserver: win.MutationObserver,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
})

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return []
  }
}
for (const name of ['ResizeObserver', 'IntersectionObserver']) {
  if (!(name in globalThis)) Object.assign(globalThis, { [name]: NoopObserver })
  if (!(name in win)) Object.assign(win, { [name]: NoopObserver })
}
if (typeof win.matchMedia !== 'function') {
  const matchMedia = (query: string): object => ({
    matches: false,
    media: query,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent: (): boolean => false,
  })
  Object.assign(win, { matchMedia })
  Object.assign(globalThis, { matchMedia })
}

// jsdom has no native Sanitizer API, so register the DOMPurify backend (the
// same fallback a real deployment uses on non-Chromium engines). Imported only
// after the DOM globals exist — DOMPurify binds `window` at module evaluation.
//
// One bench-local twist: DOMPurify's string-return mode retains ~2 MB per call
// under jsdom (surviving explicit GC — the fragment path does not), which OOMs
// a full corpus run at thousands of sanitizes. Override `sanitize` to route
// through the bundled fragment-mode node path (same allowlist and onElement
// gate — the SanitizerBackend contract requires the two paths to produce
// identically-serializing trees) and serialize from a reused scratch element.
// Real browsers don't exhibit the retention; this changes bench memory, not
// sanitize semantics.
const { dompurifyBackend } = await import('../../src/sanitize-dompurify.ts')
const scratch = win.document.createElement('div')
setSanitizerBackend({
  ...dompurifyBackend,
  sanitize(html, config): string {
    dompurifyBackend.sanitizeInto?.(scratch, html, config)
    const out = scratch.innerHTML
    scratch.replaceChildren()
    return out
  },
})
