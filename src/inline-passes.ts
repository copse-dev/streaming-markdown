// The inline-pass registry (#53): pluggable inline syntax (citations, ==highlights==,
// emoji shortcodes, …) as ordered passes injected into the fixed inline pipeline
// (`inline-spans.ts`). The registry — not each plugin — carries the three costs
// that make inline extension hard in this renderer:
//
// 1. **Masking.** Passes are applied only outside rendered `<code>`/`<a>`/`<img>`
//    spans (the `INLINE_HTML_SHIELD_RE` split in `inline-spans.ts`), so a pass can
//    never fire inside a code span; backslash escapes are PUA-encoded before
//    passes run, so `\[@key]` is inert for free.
// 2. **Escaping.** `escapeHtmlTextNodes` escapes any tag outside its safe set,
//    which would destroy pass-emitted HTML. Passes emit trusted HTML through
//    {@link InlinePassContext.emit}, which parks it in a side table and returns an
//    inert placeholder token restored *after* the escape step — the same
//    placeholder shape `raw-images.ts` uses. Attacker-typed placeholder
//    characters are stripped from the input before any pass runs, so markdown
//    text can never address the side table. The sink sanitizer remains the
//    second gate: emitted HTML using non-allowlisted tags/attributes needs
//    `MarkdownConfig.sanitizeExtension`.
// 3. **Streaming hold.** `pendingHoldIndex` (`inline-emphasis.ts`) takes the min
//    over registered passes' {@link InlinePass.holdStart}, so a half-open
//    construct (`[@doe`, `==foo`) holds instead of flashing raw mid-stream —
//    exactly how the built-in strikethrough hold composes.
//
// This module is a leaf on purpose (no project imports): the pipeline
// (`inline-spans.ts`) and the hold walker (`inline-emphasis.ts`) both consume it
// without creating an import cycle.

/** Where in the inline pipeline a pass runs. */
import { activeConfig } from './config.ts'

export type InlinePassStage = 'before-links' | 'after-links'

/** Render-time services handed to {@link InlinePass.apply}. */
export interface InlinePassContext {
  /**
   * Shield trusted HTML from later passes and the escape step. Returns an inert
   * placeholder token to splice into the returned text; the pipeline restores
   * the HTML after escaping. The HTML still passes the host's sanitizer sink —
   * stay inside the allowlist or widen it via `MarkdownConfig.sanitizeExtension`.
   */
  emit(html: string): string
}

/**
 * A pluggable inline syntax pass. `apply` receives one unshielded text segment
 * (never the interior of a rendered `<code>`/`<a>`/`<img>` span) mid-pipeline —
 * emphasis and strikethrough are already rendered; escaped punctuation is
 * PUA-encoded and inert — and returns the transformed segment, splicing any
 * generated HTML via {@link InlinePassContext.emit}. Passes run in registration
 * order within their stage and may run more than once over nested link-label
 * text, so they must be idempotent (placeholder tokens make emitted output
 * inert automatically).
 */
export interface InlinePass {
  name: string
  /**
   * `'before-links'` (default) runs after emphasis/strikethrough and before
   * markdown-link resolution — required for bracket syntaxes like citation
   * `[@key]`, which must win over link-label parsing (as in Pandoc).
   * `'after-links'` runs last, over text with `<a>`/`<code>` already rendered.
   */
  stage?: InlinePassStage
  apply(text: string, ctx: InlinePassContext): string
  /**
   * Streaming hold: the index in a pending line from which output must be
   * suppressed because this pass's syntax is half-open (cf. the strikethrough
   * hold). `line` is raw pending markdown; `mask` flags code-span interiors.
   * Return `line.length` when nothing holds.
   */
  holdStart?(line: string, mask: boolean[]): number
}

const NO_PASSES: readonly InlinePass[] = []

/**
 * The inline passes configured for the current render (execution order = array
 * order within each stage), optionally filtered to one pipeline stage. Set them
 * per render via `MarkdownConfig.inlinePasses`.
 *
 * @experimental Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.inlinePasses` instead. May move behind a
 * subpath or be removed in a minor release.
 */
export function getInlinePasses(stage?: InlinePassStage): readonly InlinePass[] {
  const passes = activeConfig().inlinePasses ?? NO_PASSES
  if (stage === undefined) return passes
  return passes.filter((pass) => (pass.stage ?? 'before-links') === stage)
}

// Placeholder tokens for pass-emitted HTML: PUA characters that are inert to
// every later pipeline stage (the escaper only touches `&<>"'`), chosen outside
// the U+E021-U+E07E range used by `backslash-escapes.ts` and distinct from the
// ￹/￻ raw-image placeholders so the two never collide.
const TOKEN_OPEN = '\uE100'
const TOKEN_CLOSE = '\uE101'
const TOKEN_RE = /\uE100(\d+)\uE101/g
const TOKEN_CHAR_RE = /[\uE100\uE101]/g

const emitted = new Map<number, string>()
let nextEmitId = 0

/** The {@link InlinePassContext} handed to every pass. */
export const inlinePassContext: InlinePassContext = {
  emit(html: string): string {
    const id = nextEmitId++
    emitted.set(id, html)
    return `${TOKEN_OPEN}${id}${TOKEN_CLOSE}`
  },
}

/**
 * Prepare untrusted text for a render that may run inline passes: strip any
 * literal placeholder characters (so markdown text can never address the emit
 * table) and reset the table — placeholders never outlive the single
 * `renderInlineSpans` call that created them. Unconditional since the built-in
 * inline-math (#70) and footnote (#72) passes emit through the table on every
 * render, host passes or not.
 */
export function beginInlinePassRender(text: string): string {
  emitted.clear()
  nextEmitId = 0
  return text.replace(TOKEN_CHAR_RE, '')
}

/** Substitute emitted HTML back for its placeholder tokens (post-escape). */
export function restoreInlinePassHtml(text: string): string {
  if (emitted.size === 0) return text
  return text.replace(TOKEN_RE, (_match, id: string) => emitted.get(Number(id)) ?? '')
}
