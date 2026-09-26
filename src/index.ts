/**
 * Public surface of @copse/streaming-markdown.
 *
 * `renderMarkdown` is the safe, default entry point: it returns sanitized HTML
 * ready for an `innerHTML` sink. `renderMarkdownUnsafe` is the zero-dependency,
 * DOM-free path that returns untrusted HTML — hosts must sanitize it at their
 * `innerHTML` sinks (`sanitizeRenderedMarkdown` is the reference sanitizer).
 * See README.md for the design invariants and the streaming architecture.
 *
 * Surface tiers (#147): every export here is the stable v1 host API and is
 * covered by the semver contract. The former `@experimental` tier — the
 * ambient-config introspection getters (`getHtmlPolicy`, `getSafeHrefSchemes`,
 * `getMathSyntax`, `getLinkImagePolicy`, `getEntityDecoder`, `getNamedEntities`,
 * `getInlinePasses`, `getCodeHighlighter`, `isEmailAutolinksEnabled`), the
 * low-level renderer internals (`splitForStreaming`, `escapeHtmlTextNodes`,
 * `decodeSafeMarkdownEntities`), and the `BUILTIN_NAMED_ENTITIES` data table —
 * was removed from this entry for 1.0. Those symbols remain in their source
 * modules for internal/test use; scope behaviour through `MarkdownConfig` and
 * the render entry points instead.
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
export { type MarkdownConfig, setDefaultConfig } from './config.ts'
// Raw-HTML policy (#600). `'passthrough'` (default) emits well-formed raw HTML
// for the sink sanitizer to arbitrate; `'escape'` literalizes it. Scope it with
// `renderMarkdown`/streaming `htmlPolicy`. See
// docs/decisions/0002-raw-html-passthrough-default.md.
export { type HtmlPolicy } from './html-policy.ts'
export {
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
  type StreamingMarkdownOptions,
} from './streaming.ts'
// The sanitizer backend is a runtime *capability* (native browser Sanitizer by
// default; the DOMPurify entry's `dompurifyBackend` for Node/jsdom/SSR). A
// non-browser host installs it once with `setDefaultConfig({ sanitizerBackend })`;
// a render's `MarkdownConfig.sanitizerBackend` overrides it, as does the allowlist
// extension via `sanitizeExtension`.
export {
  sanitizeRenderedMarkdown,
  type SanitizedHtml,
  type SanitizeExtension,
  type SanitizerBackend,
  type SanitizerConfig,
} from './sanitize.ts'
// Opt-in link/image origin allowlist (#83). Off by default (byte-identical
// output until installed); composes with the scheme allowlist and sink
// sanitizer rather than replacing them. Scope it via
// `MarkdownConfig.linkImagePolicy`. See docs/EXTENDING.md.
export { type LinkImagePolicy } from './link-image-policy.ts'
// PROTOTYPE (#url-policy): the TrustedURL-shaped gate every emitted URL passes
// through — markdown links/images/autolinks, raw-HTML passthrough destinations,
// and the URLs inside diagram/math markup that bypasses the sink sanitizer.
export {
  type UrlPolicy,
  type UrlRequest,
  type UrlSink,
  type UrlSource,
} from './url-policy.ts'
export { filterMarkupUrlsString } from './url-filter-markup.ts'
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
export { escapeHtml } from './escape.ts'
// HTML character-reference decoding is a pluggable backend (#594). The default
// decoder carries the 252 classic HTML4 named references plus all numeric refs
// (~1 KB) rather than the full ~2,100-entry HTML5 table (~23 KB gzip). Hosts that
// need the full set supply a decoder — `browserEntityDecoder` (zero bundle cost
// in the DOM) or the `@copse/streaming-markdown/entities/full` entry (backed by
// the `entities` peer dependency). See docs/ARCHITECTURE.md.
// The entity decoder is scoped per render via `MarkdownConfig.entityDecoder`
// (the full HTML5 table from the `entities/full` entry, or `browserEntityDecoder`);
// a user named-reference table via `MarkdownConfig.namedEntities`. The built-in
// carries the 252 classic HTML4 named references plus all numeric refs.
export {
  browserEntityDecoder,
  decodeHtmlEntities,
  type EntityDecoder,
} from './entity-decoder.ts'
// Syntax highlighting is a pluggable backend. The core (`highlight.ts`) carries
// no highlight.js code and renders escaped plain text until a highlighter is
// provided; the highlight.js/shiki backends stay behind their subpath entries so
// they are only bundled (or lazily fetched) when a host opts in — obtain one from
// their `load*` and pass it via `MarkdownConfig.codeHighlighter`.
export {
  type CodeHighlighter,
  fenceCodeClass,
  highlightFenceCode,
  KNOWN_LANGUAGES,
} from './highlight.ts'
// Fenced-block emission is a pluggable registry keyed by fence language (#53).
// The built-in mermaid/math scaffolding are themselves registered handlers; hosts
// add their own (```graphviz, …) per render via `MarkdownConfig.fenceHandlers`.
// Handlers emit inert allowlisted scaffolding pre-sanitizer and hydrate after the
// sink — widen the allowlist via `MarkdownConfig.sanitizeExtension` for anything
// beyond it. `getFenceHandler` introspects the active registry.
export {
  type FenceHandler,
  type FenceHandlerForming,
  FORMING_FENCE_PRE_CLASS,
  getFenceHandler,
} from './fence-handlers.ts'
export { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'
// Diagram rendering is a pluggable backend, like highlighting. The core emits
// inert `mermaid-diagram--pending` scaffolding and `hydratePendingDiagrams` swaps
// in SVG once a renderer is supplied; the mermaid backend stays behind the
// `@copse/streaming-markdown/diagrams/mermaid` entry so its library is only
// fetched when a host opts in. Obtain a renderer from `loadMermaid()` and pass it
// via `MarkdownConfig.diagramRenderer` (streaming `hydrate()`) or the
// `hydratePendingDiagrams(root, { renderer })` option — see docs/LAZY-LOADING.md.
export {
  type DiagramRenderer,
  type DiagramRenderResult,
  type HydrateDiagramsOptions,
  hydratePendingDiagrams,
  PENDING_DIAGRAM_SELECTOR,
} from './mermaid.ts'
// Math rendering is a pluggable backend, like diagrams (#70). The core emits
// inert `math-block--pending` / `math-inline--pending` scaffolding for
// ```math fences, `$$…$$` / `\[…\]` display blocks, and `$…$` / `\(…\)` inline
// math; `hydratePendingMath` swaps in rendered HTML once a renderer is supplied.
// The `$…$`-style *prose* grammar (#78) is turned on with `MarkdownConfig.mathSyntax`
// (the ```math fence is always on); without it those delimiters stay ordinary
// prose and output is byte-identical to a math-free build. The KaTeX backend
// stays behind the `@copse/streaming-markdown/math/katex` entry — obtain a renderer
// from `loadKatex()` and pass it via `MarkdownConfig.mathRenderer` (streaming
// `hydrate()`) or the `hydratePendingMath(root, { renderer })` option.
export {
  type HydrateMathOptions,
  hydratePendingMath,
  type MathRenderer,
  type MathRenderOptions,
  type MathRenderResult,
  PENDING_MATH_SELECTOR,
} from './math.ts'
// Link decoration is a pluggable seam (#601). The built-in default is neutral
// (#112): rendered `<a>` carries only `href`/`title`, with no `target`, `rel`,
// `class`, or `data-*` routing hooks. Hosts opt into their own attributes per
// render via `MarkdownConfig.linkDecorator`; the Copse workspace/browser
// decorator (`appLinkDecorator`) and the workspace path helpers live behind the
// host-only entry `@copse/streaming-markdown/host/workspace`. The scheme
// allowlist is scoped via `MarkdownConfig.safeHrefSchemes`. GFM extended email
// autolinks (#115) are on by default; a host targeting base CommonMark/GFM
// (a bare `user@host` stays plain text) turns them off per render via
// `MarkdownConfig.emailAutolinks`.
export {
  DEFAULT_SAFE_HREF_SCHEMES,
  type LinkDecoration,
  type LinkDecorator,
  renderAnchor,
} from './inline-links.ts'
// Inline syntax is extensible via registered passes (#53): citations `[@key]`,
// highlights `==x==`, and friends run inside the inline pipeline with code-span
// shielding, escape-safe HTML emission (ctx.emit), and streaming-hold support.
// Supply them per render via `MarkdownConfig.inlinePasses` (e.g. the `emojiInlinePass`
// from `@copse/streaming-markdown/inline/emoji`). Emitted HTML still passes the
// sanitizer sink — widen via `MarkdownConfig.sanitizeExtension`.
export {
  type InlinePass,
  type InlinePassContext,
  type InlinePassStage,
} from './inline-passes.ts'
