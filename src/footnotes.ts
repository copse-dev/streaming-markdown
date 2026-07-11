/**
 * GFM footnotes (#72): inline `[^label]` references and `[^label]: content`
 * definition blocks.
 *
 * Definitions are collected like link reference definitions (they never render
 * in place — see `collectFootnoteDefinitions` in block-tokenizer.ts) and render
 * as a trailing `<section class="footnotes"><ol>…</ol></section>` in reference
 * order (render-blocks.ts). References resolve against that map during inline
 * rendering, numbered in first-use order; unresolved references stay literal
 * text, mirroring unresolved link references. Definitions never referenced are
 * dropped (GitHub behavior).
 *
 * This module is a leaf on purpose (block-patterns + link-references only): the
 * block tokenizer, the inline pipeline, and the streaming hold all consume it
 * without an import cycle. The document-scoped reference state lives in a
 * {@link FootnoteContext} installed by `renderMarkdown` around one render
 * (module-level, like the other registries) — numbering is therefore
 * deterministic in render order, which walks blocks in document order.
 */
import { dropTrailingNewline, stripFourColumnIndent } from './block-patterns.ts'
import { decodeEscapes, normalizeReferenceLabel } from './link-references.ts'

/**
 * A footnote label: `^` then one or more characters that are neither
 * whitespace nor `]` (cmark-gfm's footnote label shape). The definition form
 * additionally requires the marker at a line start (≤3 spaces indent) with a
 * `:` immediately after the closing bracket.
 */
export const FOOTNOTE_DEF_LINE_RE = /^ {0,3}\[\^([^\s\]]+)\]:/

/** Inline `[^label]` reference (applied outside code spans/rendered HTML). */
const FOOTNOTE_REF_RE = /\[\^([^\s\]]+)\]/g

/** One collected definition: the source label plus its dedented content. */
export interface FootnoteDefinition {
  label: string
  /** Block-level markdown content (continuation lines dedented). */
  content: string
}

export type FootnoteDefinitionMap = ReadonlyMap<string, FootnoteDefinition>

/** Footnote labels normalize exactly like link reference labels (case fold). */
export function normalizeFootnoteLabel(label: string): string {
  return normalizeReferenceLabel(decodeEscapes(label))
}

/**
 * Parse one `footnote_def` block slice into its label and content: the first
 * line's remainder after `[^label]:`, then continuation lines with up to four
 * columns of indent removed (indented continuations and multi-paragraph
 * content via blank + 4-space indent; lazy continuation lines pass through
 * unchanged). Trailing blank lines are dropped.
 */
export function parseFootnoteDefSlice(slice: string): FootnoteDefinition | null {
  const lines = dropTrailingNewline(slice).split('\n')
  const first = lines[0] ?? ''
  const m = FOOTNOTE_DEF_LINE_RE.exec(first)
  if (!m?.[1]) return null
  const content = [
    first.slice(m[0].length).trimStart(),
    ...lines.slice(1).map((line) => stripFourColumnIndent(line)),
  ]
  while (content.length && (content.at(-1) ?? '').trim() === '') content.pop()
  return { label: m[1], content: content.join('\n') }
}

/**
 * Document-scoped reference state for one render: numbering in first-use
 * order, deterministic slugs, and per-label reference counts (for distinct
 * `fnref-…-N` ids on repeated references, following GitHub where cheap).
 */
export interface FootnoteContext {
  readonly defs: FootnoteDefinitionMap
  /** Normalized labels in first-reference order (drives the section). */
  readonly order: string[]
  readonly numbers: Map<string, number>
  readonly slugs: Map<string, string>
  readonly usedSlugs: Set<string>
  readonly refCounts: Map<string, number>
  /** Every emitted `fnref-…` id (a slug's `-2` suffix could collide with a repeat-ref id). */
  readonly usedRefIds: Set<string>
  /** First emitted ref id per label — the backref target in the section. */
  readonly firstRefIds: Map<string, string>
}

export function createFootnoteContext(defs: FootnoteDefinitionMap): FootnoteContext {
  return {
    defs,
    order: [],
    numbers: new Map(),
    slugs: new Map(),
    usedSlugs: new Set(),
    refCounts: new Map(),
    usedRefIds: new Set(),
    firstRefIds: new Map(),
  }
}

/**
 * A context carrying `from`'s numbering/slug state forward onto a fresh (current)
 * definition map, with the per-render ref-count/id state reset — the streaming
 * fast path (#133) reseats each commit so newly-arrived definitions resolve while
 * existing references keep their assigned numbers and ids.
 */
export function reseatFootnoteContext(
  defs: FootnoteDefinitionMap,
  from: FootnoteContext,
): FootnoteContext {
  return {
    defs,
    order: [...from.order],
    numbers: new Map(from.numbers),
    slugs: new Map(from.slugs),
    usedSlugs: new Set(from.usedSlugs),
    refCounts: new Map(),
    usedRefIds: new Set(),
    firstRefIds: new Map(from.firstRefIds),
  }
}

let activeFootnotes: FootnoteContext | null = null

/**
 * Install the context for one `renderMarkdown` call (reset in a `finally`).
 * Module-level rather than threaded so the recursive block/inline pipeline —
 * including footnote content, which may itself contain references — shares one
 * numbering sequence.
 */
export function setActiveFootnoteContext(ctx: FootnoteContext | null): void {
  activeFootnotes = ctx
}

export function getActiveFootnoteContext(): FootnoteContext | null {
  return activeFootnotes
}

/**
 * Deterministic, attribute-safe slug for a footnote label: lowercased with
 * every run outside `[a-z0-9_-]` collapsed to `-`. Collisions (distinct labels
 * with equal slugs) disambiguate with a numeric suffix in first-use order, so
 * no label text ever reaches an attribute unescaped or ambiguously.
 */
function assignSlug(ctx: FootnoteContext, key: string, label: string, n: number): string {
  const base =
    decodeEscapes(label)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || String(n)
  let slug = base
  for (let i = 2; ctx.usedSlugs.has(slug); i++) slug = `${base}-${String(i)}`
  ctx.usedSlugs.add(slug)
  ctx.slugs.set(key, slug)
  return slug
}

/**
 * Rendered `<sup>` reference for `[^label]`, or null when no definition
 * matches (the caller leaves the text literal). First use assigns the number
 * and slug; repeated uses share the number but get distinct `fnref-…-N` ids.
 */
export function footnoteRefHtml(ctx: FootnoteContext, label: string): string | null {
  const key = normalizeFootnoteLabel(label)
  const def = ctx.defs.get(key)
  if (!def) return null
  let n = ctx.numbers.get(key)
  let slug = ctx.slugs.get(key)
  if (n === undefined || slug === undefined) {
    n = ctx.order.length + 1
    ctx.numbers.set(key, n)
    ctx.order.push(key)
    slug = assignSlug(ctx, key, def.label, n)
  }
  // Repeated references share the number but carry distinct ids (GitHub's
  // `fnref-label-2` shape). Ids are deduplicated against every emitted ref id:
  // a slug that was itself disambiguated to `…-2` could otherwise collide with
  // another label's repeat-reference id.
  let count = (ctx.refCounts.get(key) ?? 0) + 1
  let refId = count === 1 ? `fnref-${slug}` : `fnref-${slug}-${String(count)}`
  while (ctx.usedRefIds.has(refId)) {
    count++
    refId = `fnref-${slug}-${String(count)}`
  }
  ctx.refCounts.set(key, count)
  ctx.usedRefIds.add(refId)
  if (!ctx.firstRefIds.has(key)) ctx.firstRefIds.set(key, refId)
  return `<sup class="footnote-ref"><a href="#fn-${slug}" id="${refId}">${String(n)}</a></sup>`
}

/**
 * Replace resolvable `[^label]` references in one unshielded text segment,
 * splicing the generated HTML through `emit` (the inline-pass side table) so
 * it survives `escapeHtmlTextNodes`. Backslash-escaped `\[` is already
 * PUA-encoded when this runs, so escaped brackets never match.
 */
export function renderFootnoteRefs(text: string, emit: (html: string) => string): string {
  const ctx = activeFootnotes
  if (!ctx || !text.includes('[^')) return text
  return text.replace(FOOTNOTE_REF_RE, (match, label: string) => {
    const html = footnoteRefHtml(ctx, label)
    return html === null ? match : emit(html)
  })
}

/**
 * Every `[^label]` reference in `text`, normalized, in occurrence order (repeats
 * included). A raw-source scan for the streaming footnote fast path (#133): it
 * over-approximates against code-span/escaped `[^…]`, so the caller must confirm
 * its resolved-label order matches the real render before trusting it.
 */
export function footnoteRefLabelsIn(text: string): string[] {
  if (!text.includes('[^')) return []
  const labels: string[] = []
  for (const m of text.matchAll(FOOTNOTE_REF_RE)) {
    labels.push(normalizeFootnoteLabel(m[1] as string))
  }
  return labels
}

/**
 * Streaming hold: index from which a half-open trailing `[^lab` must be
 * suppressed (cf. the strikethrough hold). Only a still-valid forming label
 * holds — once a `]` closes it, or whitespace makes the label invalid, the
 * text renders normally. `mask` flags code-span interiors, where `[^` is
 * literal and never holds.
 */
export function footnoteHoldStart(s: string, mask: boolean[]): number {
  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] !== '[' || s[i + 1] !== '^' || mask[i]) continue
    let backslashes = 0
    for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) backslashes++
    if (backslashes % 2 === 1) continue // escaped `\[` is literal
    // Forming while no `]` closed the label and no whitespace invalidated it.
    return /[\s\]]/.test(s.slice(i + 2)) ? s.length : i
  }
  return s.length
}

/**
 * Streaming: a pending line that is (or may still become) a footnote
 * DEFINITION never renders in place — hold the whole line so `[^label]: …`
 * source never flashes before committing into the trailing footnotes section.
 * Covers a forming label at line start (`[^la`), a just-closed `[^label]`
 * that may still gain its `:`, and a complete `[^label]: content` line (or
 * multi-line open definition block held pending in one piece).
 */
export function isPendingFootnoteDefLine(pending: string): boolean {
  return /^ {0,3}\[\^(?:[^\s\]]*$|[^\s\]]+\](?::|$))/.test(pending)
}
