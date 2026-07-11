/**
 * Opt-in CJK / East-Asian text handling (`@copse/streaming-markdown/cjk`).
 *
 * CommonMark's emphasis flanking rules classify every code point as whitespace,
 * *punctuation* (Unicode `P`/`S`), or "other". Full-width / ideographic
 * punctuation (`「」`, `。`, `！`, `（）`, …) is Unicode punctuation, so a
 * delimiter that sits between a CJK character and one of these marks fails the
 * flanking test and the emphasis never pairs — `これは**「強調」**です` stays
 * literal, and LLMs routinely emit exactly that shape. This is a documented
 * CommonMark limitation, not a bug in this renderer: the reference
 * implementation produces the same literal output, so the fix is an **opt-in
 * extension** (markdown-cjk-friendly), never the default.
 *
 * Turning it on treats full-width punctuation as *non-flanking* punctuation, so
 * emphasis pairs around it, and marks it as a bare-autolink boundary, so a
 * run-together `https://example.com。次` stops the URL at the `。`. Both hooks
 * are default-off registries in the core (`inline-emphasis.ts` /
 * `inline-spans.ts`); this module — and the range table below — is only pulled
 * into a bundle that imports this entry, exactly like the optional highlighter,
 * diagram, and math backends. With the extension off (the default) Latin output
 * and the conformance suites are byte-identical.
 *
 * Line-break and inter-script spacing (no space between two ideographs at a
 * soft break, kerning full-width punctuation, `word-break`/`line-break`) are the
 * host's CSS to own, not the renderer's — see `styles/cjk.css` and the CJK
 * section of `docs/EXTENDING.md`.
 */

/**
 * Full-width / ideographic punctuation, i.e. the East-Asian-width punctuation
 * that markdown-cjk-friendly treats as non-flanking. Covers CJK Symbols and
 * Punctuation (`。、「」『』（）【】〔〕〈〉《》…` — U+3000 ideographic space is
 * already Unicode whitespace and handled as such), the katakana middle dot,
 * Vertical Forms, CJK Compatibility Forms, Small Form Variants, the full-width
 * ASCII punctuation of the Halfwidth and Fullwidth Forms block (excluding
 * full-width alphanumerics), and the half-width katakana punctuation `｡｢｣､･`.
 */
const CJK_PUNCTUATION_RE =
  /[　-〿・︐-︙︰-﹯！-／：-＠［-｀｛-･]/u

/** True for a single full-width / ideographic punctuation character. */
export function isCjkPunctuation(ch: string): boolean {
  return ch !== '' && CJK_PUNCTUATION_RE.test(ch)
}

/**
 * The CJK-friendly preset as a `MarkdownConfig` fragment — spread it into a
 * render config to enable markdown-cjk-friendly emphasis + autolink boundaries
 * without a process-wide setter:
 *
 * ```ts
 * import { cjkFriendlyConfig } from '@copse/streaming-markdown/cjk'
 * renderMarkdown(md, { ...cjkFriendlyConfig })
 * ```
 *
 * Both hooks point at the built-in {@link isCjkPunctuation} predicate. The range
 * table lives in this opt-in entry, so the core bundle stays byte-identical for
 * Latin-only hosts (see the module note).
 */
export const cjkFriendlyConfig: {
  flankingPunctuationExclusion: (ch: string) => boolean
  bareUrlCjkBoundary: (ch: string) => boolean
} = {
  flankingPunctuationExclusion: isCjkPunctuation,
  bareUrlCjkBoundary: isCjkPunctuation,
}
