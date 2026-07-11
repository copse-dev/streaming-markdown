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
// Config-injected rendering (#145/#137/#147): pass a `MarkdownConfig` to
// `renderMarkdown` / the streaming entry points to scope every synchronous
// setting — the security/behavioural policy tier plus the grammar and
// inline-pipeline tier (htmlPolicy, safeHrefSchemes, sanitizeExtension,
// linkImagePolicy, trustedTypesPolicy, mathSyntax, emailAutolinks, the CJK
// boundary hooks, linkDecorator, fenceHandlers, codeHighlighter, rawImageRenderer,
// inlinePasses, entityDecoder, namedEntities) — to one render, or one
// `StreamingMarkdownRenderer` instance, with no process-wide mutation. Two
// renderers with different config coexist without interfering. The pluggable
// *backend* tier (sanitizer/highlighter/math/diagram/entity/inline-pass) still
// registers globally via its `set*`/`install*`/`load*` seam so async hydration
// can read it after the render.
export { type MarkdownConfig } from './config.ts'
export { type RenderPolicyOptions } from './render-policies.ts'
// Raw-HTML policy (#600). `'passthrough'` (default) emits well-formed raw HTML
// for the sink sanitizer to arbitrate; `'escape'` literalizes it. Scope it with
// `renderMarkdown`/streaming `htmlPolicy`. See
// docs/decisions/0002-raw-html-passthrough-default.md.
export { getHtmlPolicy, type HtmlPolicy } from './html-policy.ts'
export {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
  type StreamingMarkdownOptions,
} from './streaming.ts'
// `setSanitizerBackend` stays: the sanitizer is a pluggable backend registered
// once (native browser Sanitizer by default, or the DOMPurify entry). The
// per-render allowlist extension moved to `MarkdownConfig.sanitizeExtension`.
export {
  sanitizeRenderedMarkdown,
  setSanitizerBackend,
  type SanitizedHtml,
  type SanitizeExtension,
  type SanitizerBackend,
  type SanitizerConfig,
} from './sanitize.ts'
// Opt-in link/image origin allowlist (#83). Off by default (byte-identical
// output until installed); composes with the scheme allowlist and sink
// sanitizer rather than replacing them. Scope it via
// `MarkdownConfig.linkImagePolicy`. See docs/EXTENDING.md.
export {
  getLinkImagePolicy,
  type LinkImagePolicy,
} from './link-image-policy.ts'
// Trusted Types support: every internal `innerHTML` write routes through the
// html-sink chokepoint, which sanitizes and then blesses the markup with a TT
// policy when one is active (a lazily created `streaming-markdown` policy by
// default). `setSanitizedHtml` is the reference sink for hosts and custom fence
// handlers; a host TT policy for pages whose CSP restricts policy names is
// injected per render via `MarkdownConfig.trustedTypesPolicy`.
export {
  setSanitizedHtml,
  type TrustedHTMLValue,
  type TrustedTypesPolicy,
} from './html-sink.ts'
// The native-Sanitizer backend is zero-dependency, so it is safe to include in
// the main entry. The DOMPurify backend stays behind the
// `@copse/streaming-markdown/sanitizers/dompurify` entry so it is only bundled
// when a host explicitly opts in.
export { browserSanitizerBackend, isBrowserSanitizerSupported } from './sanitize-browser.ts'
// Raw `<img>` handling is scoped per render via `MarkdownConfig.rawImageRenderer`.
export {
  normalizeHostImagePath,
  type RawImageRenderer,
  type RawImageTag,
  type NormalizedImagePath,
  type NormalizeImagePathOptions,
} from './raw-images.ts'
// `escapeHtml` is the stable helper. `escapeHtmlTextNodes` and
// `decodeSafeMarkdownEntities` are low-level renderer internals marked
// `@experimental` (#147) — not part of the stable v1 surface; prefer the render
// entry points.
export { escapeHtml, escapeHtmlTextNodes, decodeSafeMarkdownEntities } from './escape.ts'
// HTML character-reference decoding is a pluggable backend (#594). The default
// decoder carries the 252 classic HTML4 named references plus all numeric refs
// (~1 KB) rather than the full ~2,100-entry HTML5 table (~23 KB gzip). Hosts that
// need the full set register a decoder — `browserEntityDecoder` (zero bundle cost
// in the DOM) or the `@copse/streaming-markdown/entities/full` entry (backed by
// the `entities` peer dependency) — or extend the built-in set with
// `addNamedEntities`. See docs/ARCHITECTURE.md.
// `BUILTIN_NAMED_ENTITIES` (internal data table) and `resetEntityDecoder`
// (test/reset helper) are marked `@experimental` (#147) — not part of the stable
// v1 surface. Extend the decoder via `addNamedEntities` / `setNamedEntities`.
// `setEntityDecoder` stays (the decoder is a pluggable backend — the full HTML5
// table or `browserEntityDecoder`); `addNamedEntities` stays as the incremental
// merge helper. A wholesale user table is scoped per render via
// `MarkdownConfig.namedEntities`.
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
// Custom fence handlers are registered per render via
// `MarkdownConfig.fenceHandlers` (the built-in mermaid/math handlers are always
// present); `getFenceHandler` introspects the active registry.
export {
  type FenceHandler,
  type FenceHandlerForming,
  FORMING_FENCE_PRE_CLASS,
  getFenceHandler,
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
// Prose math syntax is forced on/off per render via `MarkdownConfig.mathSyntax`;
// with no override it follows math-renderer registration (see setMathRenderer).
export { getMathSyntax } from './math-syntax.ts'
// Link decoration is a pluggable seam (#601). The built-in default is neutral
// (#112): rendered `<a>` carries only `href`/`title`, with no `target`, `rel`,
// `class`, or `data-*` routing hooks. Hosts opt into their own attributes per
// render via `MarkdownConfig.linkDecorator`; the Copse workspace/browser
// decorator (`appLinkDecorator`) and the workspace path helpers live behind the
// host-only entry `@copse/streaming-markdown/host/workspace`. The scheme
// allowlist is scoped via `MarkdownConfig.safeHrefSchemes`.
export {
  DEFAULT_SAFE_HREF_SCHEMES,
  getSafeHrefSchemes,
  type LinkDecoration,
  type LinkDecorator,
  renderAnchor,
} from './inline-links.ts'
// GFM extended email autolinks (#115) are on by default; a host targeting base
// CommonMark/GFM (a bare `user@host` stays plain text) turns them off per render
// via `MarkdownConfig.emailAutolinks`.
export { isEmailAutolinksEnabled } from './autolink-syntax.ts'
// Inline syntax is extensible via registered passes (#53): citations `[@key]`,
// highlights `==x==`, and friends run inside the inline pipeline with code-span
// shielding, escape-safe HTML emission (ctx.emit), and streaming-hold support.
// `setInlinePasses` registers them globally; a per-render set is scoped via
// `MarkdownConfig.inlinePasses`. Emitted HTML still passes the sanitizer sink —
// widen via `MarkdownConfig.sanitizeExtension`.
export {
  getInlinePasses,
  type InlinePass,
  type InlinePassContext,
  type InlinePassStage,
  setInlinePasses,
} from './inline-passes.ts'
