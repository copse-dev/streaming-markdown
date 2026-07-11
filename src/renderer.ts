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
import { type RenderPolicyOptions, withRenderPolicies } from './render-policies.ts'
import { renderBlocks, renderFootnoteSection } from './render-blocks.ts'
import { sanitizeRenderedMarkdown, type SanitizedHtml } from './sanitize.ts'

export { escapeHtml } from './escape.ts'

/**
 * Render options for a top-level document entry point. `htmlFromIndent` makes an
 * indented raw-HTML block follow the raw-HTML policy instead of becoming a
 * `<pre>` code block (#616); it is set only at the top level, never in recursive
 * list/blockquote rendering. Shared so the streaming frozen/tail path renders
 * slices byte-identically to `renderMarkdown` (its full-morph fallback) — the two
 * must not drift (#21).
 */
export const TOP_LEVEL_RENDER_OPTS = { htmlFromIndent: true, indentedCode: true } as const

export interface RenderMarkdownOptions extends RenderPolicyOptions {
  /**
   * Recognize 4-column (space or tab) indented lines as CommonMark indented code
   * blocks. Defaults to `true` — indented code is supported and conforms (#9).
   * Set `false` to opt out and render such lines as prose paragraphs instead (an
   * intentional divergence; see docs/ARCHITECTURE.md "Indented code blocks").
   */
  indentedCode?: boolean
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
export function renderMarkdown(raw: string, options: RenderMarkdownOptions = {}): SanitizedHtml {
  // The scope covers the sink too (sanitizeExtension / linkImagePolicy /
  // trustedTypesPolicy are read during sanitize), so wrap the whole thing.
  return withRenderPolicies(options, () =>
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
  return withRenderPolicies(options, () => renderMarkdownCore(raw, options))
}

function renderMarkdownCore(raw: string, options: RenderMarkdownOptions): string {
  const tokens = options.tokens ?? tokenizeBlocks(raw)
  const linkRefs = collectLinkReferenceDefinitions(raw, tokens)
  const renderOpts = {
    linkRefs,
    htmlFromIndent: TOP_LEVEL_RENDER_OPTS.htmlFromIndent,
    indentedCode: options.indentedCode ?? TOP_LEVEL_RENDER_OPTS.indentedCode,
  }
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
  // render literal (#144). Mirrors the scoped setHtmlPolicy `previous` pattern.
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
