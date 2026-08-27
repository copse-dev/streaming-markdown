// Config-injected renderer API (#145/#137/#147) — the ambient render context.
//
// A host passes a `MarkdownConfig` object to a render entry point; that object
// IS the configuration for the render. There are no `set*` singletons: instead
// of ~20 per-module mutable slots, the whole config lives in one ambient slot
// (`active`) that every read site reads through {@link activeConfig}. `withConfig`
// swaps that slot for the duration of one *synchronous* render and restores it in
// a `finally`, so two renderers with different config coexist in one process with
// no bleed, and nested/recursive renders inherit the outer config (the swap
// merges over the parent, so an inner render that sets only `htmlPolicy` keeps the
// parent's `linkDecorator`).
//
// Isolation rests on one invariant: the render + sink pass is **synchronous**.
// The async backend tier (math/diagram renderers) runs during hydration, *after*
// the scoped block returns, so those fields ride the config for
// `StreamingMarkdownRenderer.hydrate()` / the `hydratePending*` options rather
// than being read through `activeConfig` during the render.
//
// This module is a near-leaf: it imports only *types* from the feature modules,
// so those modules can import `activeConfig` from here at runtime without a cycle.
import type { HtmlPolicy } from './html-policy.ts'
import type { SanitizeExtension, SanitizerBackend } from './sanitize.ts'
import type { LinkImagePolicy } from './link-image-policy.ts'
import type { UrlPolicy } from './url-policy.ts'
import type { TrustedTypesPolicy } from './html-sink.ts'
import type { LinkDecorator } from './inline-links.ts'
import type { FenceHandler } from './fence-handlers.ts'
import type { CodeHighlighter } from './highlight.ts'
import type { RawImageRenderer } from './raw-images.ts'
import type { InlinePass } from './inline-passes.ts'
import type { EntityDecoder } from './entity-decoder.ts'
import type { MathRenderer } from './math.ts'
import type { DiagramRenderer } from './mermaid.ts'

/**
 * The full per-render configuration for a document or a streaming renderer.
 *
 * Every field is optional and inherits its built-in default when omitted; a field
 * set to `null` scopes that setting back to its built-in default for this render
 * only. A host injects this once — at construction for `StreamingMarkdownRenderer`,
 * or per call for `renderMarkdown` — so two renderers with different config coexist
 * without interfering.
 *
 * The heavy *async backend* tier (`mathRenderer` / `diagramRenderer`) is read
 * during hydration, after the synchronous render, so it is carried here for
 * `StreamingMarkdownRenderer.hydrate()` / the `hydratePending*` `renderer` option
 * rather than applied around the render itself.
 */
export interface MarkdownConfig {
  /**
   * Raw-HTML handling (#600). `'passthrough'` (the default) emits well-formed tags
   * for the sink sanitizer to arbitrate; `'escape'` literalizes them except the
   * benign attribute-less inline set; `'escape-all'` literalizes everything but
   * `<br>` — no raw element can form, which also retires the streaming path's
   * tag-balance guards and their fallback cliffs. See html-policy.ts.
   */
  htmlPolicy?: HtmlPolicy
  /**
   * Scheme allowlist enforced on link/image destinations — the gate against
   * `javascript:`/`data:` XSS. `null` restores the built-in default set. Pass a
   * materialized collection (array/`Set`), not a one-shot iterator: the value is
   * resolved to a `Set` lazily and may be resolved again later, and a consumed
   * iterator then yields an empty allowlist (every scheme-bearing URL rejected).
   * See inline-links.ts.
   */
  safeHrefSchemes?: Iterable<string> | null
  /** Host sanitizer allowlist extension; `null` uses the core allowlist only. See sanitize.ts. */
  sanitizeExtension?: SanitizeExtension | null
  /** Opt-in link/image origin allowlist; `null` disables it (unrestricted). See link-image-policy.ts. */
  linkImagePolicy?: LinkImagePolicy | null
  /**
   * Opt-in host gate consulted for **every** URL this package emits — markdown
   * links/images/autolinks, raw-HTML passthrough destinations, and the URLs
   * inside diagram/math markup that bypasses the sink sanitizer. `null` (the
   * default) disables it and every URL is emitted unchanged.
   *
   * Modelled on the `TrustedURL` type Trusted Types dropped (w3c/trusted-types#65):
   * the scheme allowlist stays a floor a policy cannot lift, and everything above
   * it is the host's. See url-policy.ts.
   */
  urlPolicy?: UrlPolicy | null
  /** Trusted Types policy used to bless sink output; `null` uses the default. See html-sink.ts. */
  trustedTypesPolicy?: TrustedTypesPolicy | null
  /**
   * Sanitizer backend for the sink (`null` uses the native browser Sanitizer). See sanitize.ts.
   */
  sanitizerBackend?: SanitizerBackend | null
  /**
   * Force `$…$`-style prose math syntax on (`true`); `false`/`null` (the default)
   * leave it off. See math-syntax.ts.
   */
  mathSyntax?: boolean | null
  /**
   * Recognize bare `user@host` addresses as `mailto:` autolinks (GFM extension,
   * on by default). See autolink-syntax.ts.
   */
  emailAutolinks?: boolean
  /**
   * GFM footnotes — inline `[^label]` references and `[^label]: …` definition
   * blocks (#72) — on by default. `false` disables the grammar for the render:
   * definition lines tokenize as ordinary paragraphs (so their text is visible,
   * matching renderers without footnote support), references stay literal, and
   * the streaming path skips its per-update definition scan. See footnotes.ts.
   */
  footnotes?: boolean
  /**
   * Per-render namespace inserted into every footnote DOM id and its matching
   * anchor, so multiple rendered documents can coexist on one page without id
   * collisions — smd's primary chat use case, where many messages stack on a
   * single page. Defaults to `''`, which is **byte-identical** to prior output
   * (`id="fn-1"` / `id="fnref-1"`); single-render consumers need not set it.
   *
   * With a prefix the ids become `fn-<prefix><label>` / `fnref-<prefix><label>`
   * (and the `href` jump targets track them), so two messages that both use
   * `[^1]` no longer both emit `id="fn-1"` and cross-link. Pass a **distinct,
   * attribute-safe** token per rendered message (e.g. `` `${messageId}-` ``,
   * characters in `[A-Za-z0-9_-]`). The value must be deterministic and stable
   * across incremental updates of the same render — do NOT derive it from
   * `Math.random()`/`Date.now()`; the id must not change as content streams in.
   * See footnotes.ts.
   */
  footnoteIdPrefix?: string
  /**
   * CommonMark link reference definitions — `[label]: /url "title"` blocks
   * resolved by `[text][label]` / `[label]` references — on by default. `false`
   * disables them: definition lines tokenize as ordinary paragraphs and
   * reference-style links stay literal text, and the streaming path skips its
   * per-update definition scan. Inline `[text](url)` links are unaffected.
   * See link-references.ts.
   */
  linkReferences?: boolean
  /**
   * Exclude characters from the emphasis flanking *punctuation* class — the seam
   * markdown-cjk-friendly uses to pair emphasis around full-width punctuation.
   * For the CJK preset, spread `cjkFriendlyConfig` from
   * `@copse/streaming-markdown/cjk` rather than hardcoding the range table here
   * (it stays in that opt-in bundle). See inline-emphasis.ts / cjk.ts.
   */
  flankingPunctuationExclusion?: ((ch: string) => boolean) | null
  /**
   * Flag characters as a bare-autolink boundary — the CJK seam that stops a
   * run-together `https://example.com。次` at the `。`. See the note on
   * {@link flankingPunctuationExclusion} for the CJK preset. See inline-spans.ts.
   */
  bareUrlCjkBoundary?: ((ch: string) => boolean) | null
  /**
   * Host {@link LinkDecorator} applied to rendered `<a>` output; `null` restores
   * the neutral built-in. See inline-links.ts.
   */
  linkDecorator?: LinkDecorator | null
  /**
   * Fence-handler registrations keyed by info-string language, layered over the
   * built-in `mermaid`/`math` handlers for this render. A value of `null` removes
   * that language's handler for the render. See fence-handlers.ts.
   */
  fenceHandlers?: Record<string, FenceHandler | null>
  /**
   * Synchronous syntax highlighter for fenced code; `null` falls back to escaped
   * plain text. See highlight.ts.
   */
  codeHighlighter?: CodeHighlighter | null
  /**
   * Host renderer for raw `<img>` tags found in prose; `null` escapes them (the
   * default). Runs inside the synchronous render. See raw-images.ts.
   */
  rawImageRenderer?: RawImageRenderer | null
  /**
   * The active inline passes (execution order = array order within each stage);
   * `null`/`[]` clears them. See inline-passes.ts.
   */
  inlinePasses?: readonly InlinePass[] | null
  /**
   * Replace the reference HTML-entity decoder wholesale; `null` uses the built-in
   * numeric + HTML4-named decoder. See entity-decoder.ts.
   */
  entityDecoder?: EntityDecoder | null
  /**
   * User-defined named entity references layered over the built-in HTML4 set
   * (only affects the built-in decoder). See entity-decoder.ts.
   */
  namedEntities?: Record<string, string>
  /**
   * Math renderer used by {@link StreamingMarkdownRenderer.hydrate} to fill
   * pending math scaffolding, and by `hydratePendingMath(root, { renderer })`.
   * Read during *async* hydration (after the render returns). Obtain one from
   * `loadKatex()`; pair with `mathSyntax: true` for the prose `$…$` grammar.
   */
  mathRenderer?: MathRenderer | null
  /**
   * Diagram renderer used by {@link StreamingMarkdownRenderer.hydrate} to fill
   * pending mermaid scaffolding, and by `hydratePendingDiagrams(root, { renderer })`.
   * Read during async hydration (see {@link mathRenderer}). Obtain one from
   * `loadMermaid()`.
   */
  diagramRenderer?: DiagramRenderer | null
}

// The process-wide default config, and the config for the current render. Outside
// any `withConfig` scope `active === baseDefaults`; a render swaps `active` for the
// duration of its synchronous pass and restores it.
let baseDefaults: MarkdownConfig = {}
let active: MarkdownConfig = baseDefaults
// Depth of nested `withConfig` scopes. Guards `setDefaultConfig`: mutating the
// process defaults mid-render would clobber the running render's merged config,
// and the scope's `finally` would then restore a stale snapshot — silently
// losing the new defaults.
let scopeDepth = 0

/**
 * The configuration for the current synchronous render — the process defaults
 * outside any `withConfig` scope. Every read site reads its setting through this,
 * e.g. `activeConfig().mathSyntax ?? false`. @internal
 */
export function activeConfig(): MarkdownConfig {
  return active
}

/**
 * Merge `config` into the **process-wide defaults** — the "install once" seam for
 * environments that configure a backend or policy for their whole lifetime rather
 * than per render: a Node/SSR host installing a `sanitizerBackend`, or a test
 * harness registering a `codeHighlighter`. A field set to `null` clears it back to
 * the built-in default. Every `renderMarkdown`/streaming call still overrides
 * these per render via its own `MarkdownConfig`.
 *
 * Call it before rendering (setup time), not inside a render — it throws when a
 * `withConfig` scope is active (from a fence handler, inline pass, or link
 * decorator), because the mutation would be lost when the scope restores. Most
 * browser apps never need it (the native Sanitizer is the default and everything
 * else is per-render config).
 */
export function setDefaultConfig(config: MarkdownConfig): void {
  if (scopeDepth > 0) {
    throw new Error(
      'setDefaultConfig cannot be called during a render (inside a withConfig scope): ' +
        'the running render would be clobbered and the new defaults lost when its scope ' +
        'restores. Call it at setup time, or pass per-render config to the entry point.',
    )
  }
  baseDefaults = { ...baseDefaults, ...config }
  active = baseDefaults
}

/**
 * Run `fn` with `config` as the ambient render context, then restore the previous
 * context in a `finally`. Returns `fn`'s result.
 *
 * The swap **merges over** the current context (`{ ...parent, ...config }`) so a
 * render inherits the process defaults, and a nested/recursive render (a fence
 * handler or the streaming path re-entering `renderMarkdownUnsafe`) inherits the
 * outer config and overrides only the fields it sets. Isolation requires the
 * render to be synchronous: the context is set before `fn()` and restored after,
 * and nested renders compose because each level restores its own parent.
 */
export function withConfig<T>(config: MarkdownConfig, fn: () => T): T {
  const previous = active
  active = { ...previous, ...config }
  scopeDepth++
  try {
    return fn()
  } finally {
    scopeDepth--
    active = previous
  }
}
