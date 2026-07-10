/**
 * Public surface of @copse/streaming-markdown.
 *
 * `renderMarkdown` is the safe, default entry point: it returns sanitized HTML
 * ready for an `innerHTML` sink. `renderMarkdownUnsafe` is the zero-dependency,
 * DOM-free path that returns untrusted HTML — hosts must sanitize it at their
 * `innerHTML` sinks (`sanitizeRenderedMarkdown` is the reference sanitizer).
 * See README.md for the design invariants and the streaming architecture.
 */
export { renderMarkdown, renderMarkdownUnsafe, type RenderMarkdownOptions } from './renderer.ts'
// Per-render policy overrides (#137, ADR 0003): pass any of `htmlPolicy`,
// `safeHrefSchemes`, `sanitizeExtension`, `linkImagePolicy`, `trustedTypesPolicy`
// to `renderMarkdown` / the streaming entry points to scope that policy to one
// render (or one `StreamingMarkdownRenderer` instance) instead of the process
// default. The `set*` functions still move the global default.
export { type RenderPolicyOptions } from './render-policies.ts'
// Raw-HTML policy (#600). `'passthrough'` (default) emits well-formed raw HTML
// for the sink sanitizer to arbitrate; `'escape'` literalizes it. Per-render
// via `renderMarkdown`/streaming `htmlPolicy`, or process-wide via
// `setHtmlPolicy`. See docs/decisions/0002-raw-html-passthrough-default.md.
export { getHtmlPolicy, type HtmlPolicy, setHtmlPolicy } from './html-policy.ts'
export {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
  type StreamingMarkdownOptions,
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
// Opt-in link/image origin allowlist (#83). Off by default (byte-identical
// output until installed); composes with the scheme allowlist and sink
// sanitizer rather than replacing them. See docs/EXTENDING.md.
export {
  getLinkImagePolicy,
  type LinkImagePolicy,
  setLinkImagePolicy,
} from './link-image-policy.ts'
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
// HTML character-reference decoding is a pluggable backend (#594). The default
// decoder carries the 252 classic HTML4 named references plus all numeric refs
// (~1 KB) rather than the full ~2,100-entry HTML5 table (~23 KB gzip). Hosts that
// need the full set register a decoder — `browserEntityDecoder` (zero bundle cost
// in the DOM) or the `@copse/streaming-markdown/entities/full` entry (backed by
// the `entities` peer dependency) — or extend the built-in set with
// `addNamedEntities`. See docs/ARCHITECTURE.md.
export {
  addNamedEntities,
  BUILTIN_NAMED_ENTITIES,
  browserEntityDecoder,
  decodeHtmlEntities,
  type EntityDecoder,
  getEntityDecoder,
  getNamedEntities,
  resetEntityDecoder,
  setEntityDecoder,
  setNamedEntities,
} from './entity-decoder.ts'
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
// registered. Registering the renderer is also what turns the *prose* math
// grammar on (#78) — without one, `$…$`-style text stays ordinary prose and
// output is byte-identical to a math-free build; `setMathSyntax` overrides that
// default in either direction (the ```math fence is always on). The KaTeX
// backend stays behind the `@copse/streaming-markdown/math/katex` entry so its
// library is only fetched when a host opts in — see docs/LAZY-LOADING.md.
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
export { getMathSyntax, setMathSyntax } from './math-syntax.ts'
// Link decoration is a pluggable seam (#601). The built-in default is neutral
// (#112): rendered `<a>` carries only `href`/`title`, with no `target`, `rel`,
// `class`, or `data-*` routing hooks. Hosts opt into their own attributes via
// `setLinkDecorator`; the Copse workspace/browser decorator (`appLinkDecorator`)
// and the workspace path helpers now live behind the host-only entry
// `@copse/streaming-markdown/host/workspace` so the main surface stays
// host-agnostic. Migration for existing hosts is a single call:
// `setLinkDecorator(appLinkDecorator)`.
export {
  DEFAULT_SAFE_HREF_SCHEMES,
  getSafeHrefSchemes,
  type LinkDecoration,
  type LinkDecorator,
  renderAnchor,
  setLinkDecorator,
  setSafeHrefSchemes,
} from './inline-links.ts'
// GFM extended email autolinks (#115) are on by default; a host targeting base
// CommonMark/GFM (a bare `user@host` stays plain text) turns them off here.
export { isEmailAutolinksEnabled, setEmailAutolinks } from './autolink-syntax.ts'
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
