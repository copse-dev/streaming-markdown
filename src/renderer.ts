import {
  collectFootnoteDefinitions,
  collectLinkReferenceDefinitions,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import {
  createFootnoteContext,
  getActiveFootnoteContext,
  setActiveFootnoteContext,
} from './footnotes.ts'
import { activeConfig, type MarkdownConfig, withConfig } from './config.ts'
import { renderBlocks, renderFootnoteSection } from './render-blocks.ts'
import { sanitizeRenderedMarkdown, type SanitizedHtml } from './sanitize.ts'

export { escapeHtml } from './escape.ts'

/**
 * Render options for a top-level document entry point. `htmlFromIndent` makes an
 * indented raw-HTML block follow the raw-HTML policy instead of becoming a
 * `<pre>` code block (#616); it is set only at the top level, never in recursive
 * list/blockquote rendering. Shared so the streaming frozen/tail path renders
 * slices byte-identically to `renderMarkdown` (its full-morph fallback) — the two
 * must not drift (#21). `indentedCode` comes from the active config
 * (`MarkdownConfig.indentedCode`), so call this inside the render's config scope.
 */
export function topLevelRenderOpts(): { htmlFromIndent: true; indentedCode: boolean } {
  return { htmlFromIndent: true, indentedCode: activeConfig().indentedCode !== false }
}

/**
 * {@link topLevelRenderOpts} for a streaming emitter's committed prefix. With
 * `formingTail` (the trailing block still continues into the held tail,
 * `committedTailContinues`), a fence still open at the end of the prefix (nested
 * in a list item or blockquote; top-level open fences never commit) renders in
 * its forming shape (`RenderBlocksOptions.formingTail`). Every streaming render
 * of committed source goes through this, so both emitters mark the same fences.
 */
export function committedRenderOpts(formingTail: boolean): {
  htmlFromIndent: true
  indentedCode: boolean
  formingTail: boolean
} {
  return { ...topLevelRenderOpts(), formingTail }
}

export interface RenderMarkdownOptions extends MarkdownConfig {
  /**
   * Pre-computed `tokenizeBlocks(raw)` result. Supplying it lets the streaming
   * hot path reuse a single tokenization instead of re-scanning `raw` (#21).
   * Must correspond exactly to `raw`; ignored (re-tokenized) if omitted.
   */
  tokens?: BlockToken[]
}

/**
 * Render complete markdown to **sanitized**, ready-to-insert HTML (#104).
 *
 * This is the safe, default entry point: its output has already passed through
 * the sink sanitizer ({@link sanitizeRenderedMarkdown}), so it can be assigned to
 * an `innerHTML` sink (or handed to {@link setSanitizedHtml}) without a separate
 * sanitize step. The return value is branded {@link SanitizedHtml}.
 *
 * Because sanitizing builds a DOM, this requires a sanitizer backend — the
 * browser's native Sanitizer API (the zero-dependency default when available) or
 * a registered backend such as `@copse/streaming-markdown/sanitizers/dompurify`.
 * With neither available (e.g. pure-Node SSR with no jsdom) it throws rather than
 * return unsafe HTML — the same fail-closed contract as `renderStreamingMarkdown`.
 * For a pure `string → HTML` result with no backend (SSR, snapshots, non-DOM
 * pipelines), use {@link renderMarkdownUnsafe} and sanitize at your own sink.
 */
// Only `MarkdownConfig` fields belong in the ambient scope. `tokens` (a
// potentially large per-call array) is a call option read directly by
// renderMarkdownCore; leaking it into the ambient object would hand an outer
// render's tokens to any nested render that consulted them.
function scopedConfig(options: RenderMarkdownOptions): MarkdownConfig {
  const { tokens, ...config } = options
  return config
}

export function renderMarkdown(raw: string, options: RenderMarkdownOptions = {}): SanitizedHtml {
  // The scope covers the sink too (sanitizeExtension / linkImagePolicy /
  // trustedTypesPolicy are read during sanitize), so wrap the whole thing.
  return withConfig(scopedConfig(options), () =>
    sanitizeRenderedMarkdown(renderMarkdownCore(raw, options)),
  )
}

/**
 * Render complete markdown to an **untrusted** HTML string via block tokenization
 * (#475). Fenced code is tokenized as blocks so its contents are not HTML-escaped.
 * HTML comments are stripped from prose blocks only (see render-blocks.ts).
 *
 * The returned HTML is assembled by string concatenation and is **not**
 * sanitized: under the default `htmlPolicy: 'passthrough'` it emits raw HTML
 * (including `<script>`) verbatim for a downstream sink to arbitrate. Never assign
 * it to `innerHTML` directly — route it through {@link sanitizeRenderedMarkdown}
 * (or use the safe {@link renderMarkdown}). This is the zero-dependency,
 * DOM-free path used internally (the streaming emitters sanitize its output at
 * their sinks) and by hosts that own their own sanitization boundary.
 */
export function renderMarkdownUnsafe(raw: string, options: RenderMarkdownOptions = {}): string {
  return withConfig(scopedConfig(options), () => renderMarkdownCore(raw, options))
}

/**
 * {@link renderMarkdownUnsafe} for a streaming emitter's committed prefix
 * ({@link committedRenderOpts}). Runs in the caller's config scope: the emitters
 * already wrap each update in `withConfig`.
 * @internal Not exported from the package entry.
 */
export function renderCommittedMarkdownUnsafe(
  raw: string,
  tokens: BlockToken[],
  formingTail: boolean,
): string {
  return renderMarkdownCore(raw, { tokens }, formingTail)
}

function renderMarkdownCore(
  raw: string,
  options: RenderMarkdownOptions,
  formingTail = false,
): string {
  const tokens = options.tokens ?? tokenizeBlocks(raw)
  const linkRefs = collectLinkReferenceDefinitions(raw, tokens)
  const renderOpts = { linkRefs, ...committedRenderOpts(formingTail) }
  // GFM footnotes (#72): with definitions present, install a document-scoped
  // context so inline `[^label]` references resolve (numbered in first-use
  // order) and append the trailing footnotes section for the referenced ones.
  // Without definitions, references stay literal and this path costs nothing.
  const footnoteDefs = collectFootnoteDefinitions(raw, tokens)
  if (footnoteDefs.size === 0) return renderBlocks(raw, tokens, renderOpts)
  const footnotes = createFootnoteContext(footnoteDefs)
  // Save/restore the prior context rather than clearing to null: the extension
  // API (fence handlers, inline passes) invites recursive renderMarkdownUnsafe
  // calls, and a footnote-bearing inner render must not strand the outer
  // document's context — every later `[^ref]` in the outer doc would otherwise
  // render literal (#144). Mirrors withConfig's save/restore pattern.
  const previousFootnotes = getActiveFootnoteContext()
  setActiveFootnoteContext(footnotes)
  try {
    const body = renderBlocks(raw, tokens, renderOpts)
    const section = renderFootnoteSection(footnotes, linkRefs)
    if (section === '') return body
    return body === '' ? section : `${body}\n${section}`
  } finally {
    setActiveFootnoteContext(previousFootnotes)
  }
}
