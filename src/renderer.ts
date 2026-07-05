import {
  collectLinkReferenceDefinitions,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import { renderBlocks } from './render-blocks.ts'

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

export interface RenderMarkdownOptions {
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
 * Render complete markdown to HTML via block tokenization (#475).
 * Fenced code is tokenized as blocks so its contents are not HTML-escaped.
 * HTML comments are stripped from prose blocks only (see render-blocks.ts).
 */
export function renderMarkdown(raw: string, options: RenderMarkdownOptions = {}): string {
  const tokens = options.tokens ?? tokenizeBlocks(raw)
  const linkRefs = collectLinkReferenceDefinitions(raw, tokens)
  return renderBlocks(raw, tokens, {
    linkRefs,
    htmlFromIndent: TOP_LEVEL_RENDER_OPTS.htmlFromIndent,
    indentedCode: options.indentedCode ?? TOP_LEVEL_RENDER_OPTS.indentedCode,
  })
}
