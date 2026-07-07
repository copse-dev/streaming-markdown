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
  type SanitizedHtml,
  type SanitizeExtension,
  type SanitizerBackend,
  type SanitizerConfig,
} from './sanitize.ts'
// Trusted Types support: every internal `innerHTML` write routes through the
// html-sink chokepoint, which sanitizes and then blesses the markup with a TT
// policy when one is active (a lazily created `streaming-markdown` policy by
// default). `setSanitizedHtml` is the reference sink for hosts and custom fence
// handlers; `setTrustedTypesPolicy` injects a host policy for pages whose CSP
// restricts policy names.
export {
  setSanitizedHtml,
  setTrustedTypesPolicy,
  type TrustedHTMLValue,
  type TrustedTypesPolicy,
} from './html-sink.ts'
// The native-Sanitizer backend is zero-dependency, so it is safe to include in
// the main entry. The DOMPurify backend stays behind the
// `@copse/streaming-markdown/sanitizers/dompurify` entry so it is only bundled
// when a host explicitly opts in.
export { browserSanitizerBackend, isBrowserSanitizerSupported } from './sanitize-browser.ts'
export {
  setRawImageRenderer,
  normalizeHostImagePath,
  type RawImageRenderer,
  type RawImageTag,
  type NormalizedImagePath,
  type NormalizeImagePathOptions,
} from './raw-images.ts'
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
// Fenced-block emission is a pluggable registry keyed by fence language (#53).
// The built-in mermaid scaffolding is itself a registered FenceHandler; hosts
// add their own (```math, ```graphviz, …) with setFenceHandler. Handlers emit
// inert allowlisted scaffolding pre-sanitizer and hydrate after the sink —
// widen the allowlist via setSanitizeExtension for anything beyond it.
export {
  type FenceHandler,
  type FenceHandlerForming,
  FORMING_FENCE_PRE_CLASS,
  getFenceHandler,
  setFenceHandler,
} from './fence-handlers.ts'
export { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'
// Diagram rendering is a pluggable backend, like highlighting. The core emits
// inert `mermaid-diagram--pending` scaffolding and `hydratePendingDiagrams` swaps
// in SVG once a renderer is registered; the mermaid backend stays behind the
// `@copse/streaming-markdown/diagrams/mermaid` entry so its library is only
// fetched when a host opts in — see docs/LAZY-LOADING.md.
export {
  type DiagramRenderer,
  type DiagramRenderResult,
  getDiagramRenderer,
  type HydrateDiagramsOptions,
  hydratePendingDiagrams,
  PENDING_DIAGRAM_SELECTOR,
  setDiagramRenderer,
} from './mermaid.ts'
// Math rendering is a pluggable backend, like diagrams (#70). The core emits
// inert `math-block--pending` / `math-inline--pending` scaffolding for
// ```math fences, `$$…$$` / `\[…\]` display blocks, and `$…$` / `\(…\)` inline
// math; `hydratePendingMath` swaps in rendered HTML once a renderer is
// registered. The KaTeX backend stays behind the
// `@copse/streaming-markdown/math/katex` entry so its library is only fetched
// when a host opts in — see docs/LAZY-LOADING.md.
export {
  getMathRenderer,
  type HydrateMathOptions,
  hydratePendingMath,
  type MathRenderer,
  type MathRenderOptions,
  type MathRenderResult,
  PENDING_MATH_SELECTOR,
  setMathRenderer,
} from './math.ts'
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
// Inline syntax is extensible via registered passes (#53): citations `[@key]`,
// highlights `==x==`, and friends run inside the inline pipeline with code-span
// shielding, escape-safe HTML emission (ctx.emit), and streaming-hold support.
// Emitted HTML still passes the sanitizer sink — widen via setSanitizeExtension.
export {
  getInlinePasses,
  type InlinePass,
  type InlinePassContext,
  type InlinePassStage,
  setInlinePasses,
} from './inline-passes.ts'
