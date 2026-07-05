/**
 * Public surface of @copse/streaming-markdown.
 *
 * The renderer returns untrusted HTML strings; hosts must sanitize at their
 * `innerHTML` sinks (`sanitizeRenderedMarkdown` is the reference sanitizer).
 * See README.md for the design invariants and the streaming architecture.
 */
export { renderMarkdown, type RenderMarkdownOptions } from './renderer.ts'
export {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
} from './streaming.ts'
export {
  sanitizeRenderedMarkdown,
  setSanitizeExtension,
  setSanitizerBackend,
  type SanitizeExtension,
  type SanitizerBackend,
  type SanitizerConfig,
} from './sanitize.ts'
// The native-Sanitizer backend is zero-dependency, so it is safe to include in
// the main entry. The DOMPurify backend stays behind the
// `@copse/streaming-markdown/sanitizers/dompurify` entry so it is only bundled
// when a host explicitly opts in.
export { browserSanitizerBackend, isBrowserSanitizerSupported } from './sanitize-browser.ts'
export { setRawImageRenderer, type RawImageRenderer, type RawImageTag } from './raw-images.ts'
export { escapeHtml, escapeHtmlTextNodes, decodeSafeMarkdownEntities } from './escape.ts'
// Syntax highlighting is a pluggable backend. The core (`highlight.ts`) carries
// no highlight.js code and renders escaped plain text until a backend is
// registered; the highlight.js backend stays behind the
// `@copse/streaming-markdown/highlighters/highlightjs` entry so it is only bundled
// (or lazily fetched) when a host opts in — see README / docs/LAZY-LOADING.md.
export {
  type CodeHighlighter,
  fenceCodeClass,
  getCodeHighlighter,
  highlightFenceCode,
  KNOWN_LANGUAGES,
  setCodeHighlighter,
  stripAppCodeDecorations,
} from './highlight.ts'
export { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'
export {
  appLinkDecorator,
  DEFAULT_SAFE_HREF_SCHEMES,
  getSafeHrefSchemes,
  type LinkDecoration,
  type LinkDecorator,
  renderAnchor,
  setLinkDecorator,
  setSafeHrefSchemes,
  stripAppImageAttributes,
  stripAppLinkAttributes,
} from './inline-links.ts'
export {
  isWorkspaceMarkdownLinkHref,
  workspaceLinkTargetFromHref,
  type WorkspaceLinkTarget,
} from './workspace-link-href.ts'
