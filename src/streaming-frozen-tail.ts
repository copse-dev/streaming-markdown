// Frozen-prefix + tail-group incremental commit rendering (#21, Layer 2).
//
// The committed prefix of a streaming message used to be fully re-rendered,
// re-sanitized and re-morphed on every block commit, making a whole stream
// O(n²) in the message length (the render/sanitize/morph layer dominated).
//
// This splits `completedEl` into two regions:
//
//   - a *frozen* region — DOM for top-level groups that can never change again.
//     Rendered and sanitized exactly once; after the freeze frame the nodes are
//     never touched again, so node identity is permanent.
//   - a *tail group* — the last still-mergeable group (open list, growing table,
//     open blockquote, or an unsettled trailing paragraph). Small and bounded;
//     the only thing re-rendered per commit.
//
// Per commit the render/sanitize/append work is O(newly-settled delta) + O(tail)
// instead of O(prefix) — this removes the render/sanitize/morph layer that
// dominated. `frozenTail.update` is constant-time per commit regardless of how
// long the committed prefix already is (with the streaming.ts pending queries
// scoped to the tail, whole-stream DOM cost grows ~2×/doubling in the bench,
// down from ~4×).
//
// Known bounds:
//   - The pure-string scans stay O(prefix) per update (issue #21 limitation K):
//     the full-string tokenize threaded in from Layer 1 and the per-commit
//     `parseLinkReferenceDefinitions` below. They keep the asymptote at Θ(n²)
//     but are a few percent of wall-clock at realistic sizes; true linearity
//     needs an incremental tokenizer + link-ref scan (out of scope for v1).
//   - A document whose trailing group never settles (one long open list or
//     blockquote) keeps the whole group in the tail, so list-shaped output
//     degrades toward the old per-commit cost. Bounding the tail for long open
//     groups is follow-up work.
//
// Every uncertainty falls back to `morphInnerHtml(sanitize(render(complete)))` —
// today's exact, correct behaviour — so the fast path is a pure optimization: a
// mishandled case degrades to slower-but-correct output, never to wrong output.
import { type BlockKind, type BlockToken } from './block-tokenizer.ts'
import { renderBlocks } from './render-blocks.ts'
import { parseLinkReferenceDefinitions, type LinkReferenceMap } from './link-references.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderMarkdown, TOP_LEVEL_RENDER_OPTS } from './renderer.ts'
import { morphInnerHtml, morphInnerHtmlFrom } from './streaming-dom-morph.ts'

// Shared with renderMarkdown (the full-morph fallback) so a frozen/tail slice
// renders byte-identically to the whole-string render — the two must not drift
// (gap A: top-level indented raw HTML follows the raw-HTML policy, not <pre>).
const RENDER_OPTS = TOP_LEVEL_RENDER_OPTS

/**
 * How a block kind behaves at the settled/tail boundary:
 *
 *  - `immutable` — a complete token of this kind can never be changed by later
 *    input (closed fence, ATX/setext heading, thematic break).
 *  - `settled-after-blank` — complete and immutable only once a complete blank
 *    follows (a paragraph can retro-convert to a setext heading; a table can
 *    still grow body rows).
 *  - `grouping` — consecutive same-kind tokens (with interleaved blanks) render
 *    as ONE top-level group that later input can still extend or restructure
 *    (lists: loose/tight; blockquotes: blank-run continuation; indented code:
 *    blank-run merging), so a trailing run stays wholly in the tail.
 *  - `separator` — renders nothing itself; a *complete* token of this kind is a
 *    stable boundary between groups.
 *
 * The switch is exhaustive over `BlockKind` with no default: adding a new block
 * kind is a COMPILE ERROR here until it is classified, so the frozen/tail
 * boundary can never silently mis-handle a kind it has not met (#32). When
 * unsure, classify a new kind as `grouping` — the walk-back only ever *grows*
 * the tail, which is conservative (more re-render, never wrong output).
 */
type SettleClass = 'immutable' | 'settled-after-blank' | 'grouping' | 'separator'

function settleClassOf(kind: BlockKind): SettleClass {
  switch (kind) {
    case 'fence':
    case 'atx_heading':
    case 'setext_heading':
    case 'thematic_break':
      return 'immutable'
    case 'paragraph':
    case 'table':
      return 'settled-after-blank'
    case 'list_item':
    case 'blockquote':
    case 'indented_code':
      return 'grouping'
    case 'blank':
    case 'link_ref_def':
      return 'separator'
  }
}

/**
 * Token index where the unsettled trailing group begins. Tokens before it form
 * complete, immutable top-level groups safe to freeze; tokens from it onward can
 * still be restructured by later input and must be re-rendered each commit.
 *
 * The boundary always lands on a top-level group boundary, and is conservative
 * by construction: when unsure it moves left (a larger tail, still correct
 * because the tail is re-rendered in full), never right.
 *
 * A trailing group is *settled* only when later input cannot change it:
 *   - fence / ATX / setext heading / thematic break — intrinsically immutable;
 *   - a paragraph or table *followed by a blank* — the blank blocks a setext
 *     retro-conversion and closes a table against further body rows.
 * Everything else trailing is unsettled: lists and blockquotes continue across
 * blanks, indented code merges across blanks, a paragraph/table with no blank
 * after it can still grow or retro-convert, and any open/ambiguous token is
 * unsettled by definition (reachable when re-tokenizing the committed prefix
 * yields a trailing open block, e.g. `"    a\n\n"` → open indented_code).
 */
export function settledTailStart(tokens: BlockToken[]): number {
  let i = tokens.length - 1
  let blankFollows = false
  while (i >= 0) {
    const token = tokens[i]
    if (!token) return tokens.length
    // Only *complete* separators are stable boundaries. An open trailing blank
    // (e.g. `" "` — spaces with no newline) can be re-absorbed into the next
    // block (`" " + "***"` → a leading-space thematic break), so it is unsettled
    // and must stay in the tail; never advance the frozen region past it.
    if (settleClassOf(token.kind) === 'separator' && token.status === 'complete') {
      blankFollows = true
      i--
      continue
    }
    break
  }
  if (i < 0) return tokens.length // nothing renders → freeze all, empty tail

  const last = tokens[i]
  if (!last) return tokens.length

  const cls = settleClassOf(last.kind)
  const settled =
    last.status === 'complete' &&
    (cls === 'immutable' || (cls === 'settled-after-blank' && blankFollows))
  if (settled) return i + 1

  // Unsettled last group. Non-grouping kinds (paragraph, table, open/ambiguous
  // singletons) start at `i`; grouping kinds can span an earlier run of
  // same-kind tokens and internal blanks.
  if (cls !== 'grouping') return i

  let s = i
  while (s - 1 >= 0) {
    const prev = tokens[s - 1]
    if (prev && (prev.kind === last.kind || prev.kind === 'blank')) {
      s--
      continue
    }
    break
  }
  // Push past leading blanks so the tail begins at the first rendering token of
  // the group; the blanks (rendering nothing) fall into the frozen delta.
  while (s < i && tokens[s]?.kind === 'blank') s++
  return s
}

/** Index of the first token with `start >= offset` (tokens sorted by `start`). */
function lowerBound(tokens: BlockToken[], offset: number): number {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const tok = tokens[mid]
    if (tok && tok.start < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * True when a token straddles `offset` (start < offset < end), i.e. `offset` is
 * no longer a top-level block boundary. `complete` is not append-only: a later
 * chunk can extend an earlier paragraph via lazy continuation (`"Foo\n"` then
 * `"Foo\n    ***"` is one paragraph), absorbing a block the previous frame froze.
 * When that happens the frozen prefix cuts a block in half and must be rebuilt.
 * Tokens are sorted by `start` and contiguous, so the only candidate is the
 * rightmost token starting before `offset`.
 */
function tokenStraddles(tokens: BlockToken[], offset: number): boolean {
  const idx = lowerBound(tokens, offset)
  const prev = idx > 0 ? tokens[idx - 1] : undefined
  return prev !== undefined && prev.end > offset
}

/**
 * Stable serialization of the committed link-reference map (invalidation guard).
 * JSON-encoded entries keep field and entry boundaries unambiguous with only
 * printable characters (raw control-byte separators would make this source file
 * binary to git and diff tooling).
 */
function serializeLinkRefs(refs: LinkReferenceMap): string {
  if (refs.size === 0) return ''
  const entries: string[] = []
  for (const [label, ref] of refs) {
    entries.push(JSON.stringify([label, ref.href, ref.title ?? '']))
  }
  return entries.sort().join('\n')
}

// The attribute-less phrasing tags the renderer passes through unescaped (see
// BENIGN_RAW_INLINE_TAG_RE in escape.ts; `br` is void so it has no balance).
const BENIGN_BALANCED_TAGS = ['b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'kbd', 'mark']

/**
 * True when `html` (unsanitized renderer output) contains an unbalanced benign
 * raw inline tag. Freezing such a fragment would diverge from the whole-string
 * render: the HTML parser's formatting-element reconstruction re-opens an
 * unclosed `<b>` into every later block when the string is parsed as one unit,
 * which per-fragment sanitization cannot reproduce. Conservative — a stray
 * close tag also trips it, which merely costs a fallback, never wrong output.
 */
function hasUnbalancedBenignRawInline(html: string): boolean {
  for (const tag of BENIGN_BALANCED_TAGS) {
    const opens = html.match(new RegExp(`<${tag}(?=[\\s/>])`, 'gi'))?.length ?? 0
    if (opens === 0) continue
    const closes = html.match(new RegExp(`</${tag}>`, 'gi'))?.length ?? 0
    if (opens !== closes) return true
  }
  return false
}

/**
 * Incremental committed-prefix renderer. Owns the frozen/tail split of a single
 * `completedEl`; call {@link reset} when that element is rebuilt (see gap D).
 */
export class FrozenTailRenderer {
  /** Source offset; DOM for `[0, frozenEnd)` is final and never re-rendered. */
  private frozenEnd = 0
  /** Exact source text of `[0, frozenEnd)` — guards non-append-only updates. */
  private frozenSource = ''
  /** Whether any frozen block rendered non-empty HTML (drives the `'\n'` seam). */
  private frozenHasHtml = false
  /** Counted number of `completedEl` children that are frozen. */
  private frozenNodeCount = 0
  /** Serialized committed link-ref map at the last commit (invalidation guard). */
  private lastLinkRefKey = ''
  /**
   * Diagnostic: cumulative count of HTML characters this renderer has produced
   * (delta + tail per commit, or the whole document on a full-morph fallback).
   * The invariant #21 protects is that this stays O(n) over a whole stream, not
   * O(n²); a deterministic, timing-free perf-regression test reads it. Never
   * consumed by production code.
   */
  renderedChars = 0

  reset(): void {
    this.frozenEnd = 0
    this.frozenSource = ''
    this.frozenHasHtml = false
    this.frozenNodeCount = 0
    this.lastLinkRefKey = ''
  }

  /**
   * Reconcile `completedEl` so it serializes byte-identically to
   * `sanitizeRenderedMarkdown(renderMarkdown(complete))`, freezing the settled
   * prefix and re-rendering only the tail group. `tokens` must be
   * `tokenizeBlocks(complete)` (threaded from the caller, Layer 1).
   */
  update(completedEl: HTMLElement, complete: string, tokens: BlockToken[]): void {
    if (complete === '') {
      if (completedEl.childNodes.length > 0) completedEl.replaceChildren()
      this.reset()
      return
    }

    const linkRefs = parseLinkReferenceDefinitions(complete)
    const linkRefKey = serializeLinkRefs(linkRefs)
    const tailStart = settledTailStart(tokens)
    const tailToken = tokens[tailStart]
    const settledOffset = tailToken ? tailToken.start : complete.length

    // Fall back to today's full-morph behaviour (then rebuild next commit) when
    // the fast path cannot safely reuse the frozen prefix:
    //  - the committed link-ref map changed, which can rewrite earlier blocks
    //    (limitation J);
    //  - the frozen source bytes are no longer a prefix of `complete` — the
    //    host rewrote or regenerated content in place, so the frozen DOM shows
    //    stale text (this also covers `complete` shrinking below `frozenEnd`);
    //  - `frozenEnd` no longer lands on a block boundary because a later chunk
    //    extended an earlier block over it (lazy paragraph continuation keeps
    //    the prefix bytes identical while merging blocks, so the byte check
    //    above cannot catch it).
    // A mere *backward jitter* of `settledOffset` is NOT a fallback: a new
    // unresolved inline in the trailing open paragraph retreats the split,
    // nudging the boundary back over a still-committed blank. The frozen prefix
    // stays valid there, so we keep it and never retreat `frozenEnd` (clamp the
    // advance below).
    if (
      linkRefKey !== this.lastLinkRefKey ||
      !complete.startsWith(this.frozenSource) ||
      tokenStraddles(tokens, this.frozenEnd)
    ) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey)
      return
    }
    // Never move the frozen boundary backward (see above).
    const advanceTo = Math.max(settledOffset, this.frozenEnd)

    // Newly-settled delta `[frozenEnd, advanceTo)` and tail `[advanceTo, end)`.
    // Tokens are sorted, so both are contiguous slices around two binary-searched
    // boundaries — never a full-array scan (the commit path must stay O(tail)).
    const deltaFrom = lowerBound(tokens, this.frozenEnd)
    const deltaTo = lowerBound(tokens, advanceTo)
    const deltaTokens = tokens.slice(deltaFrom, deltaTo)
    const tailTokens = tokens.slice(deltaTo)

    const deltaHtml = deltaTokens.length
      ? renderBlocks(complete, deltaTokens, { linkRefs, ...RENDER_OPTS })
      : ''
    // An unbalanced benign raw inline tag (`<b>` left open) makes whole-string
    // sanitization re-open the tag into every later block; per-fragment
    // sanitization cannot reproduce that, so never freeze such a delta. The
    // fallback repeats each commit (frozenEnd stays 0), degrading that stream to
    // the old full-morph behaviour — correct, just not incremental.
    if (deltaHtml !== '' && hasUnbalancedBenignRawInline(deltaHtml)) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey)
      return
    }
    const tailHtml = tailTokens.length
      ? renderBlocks(complete, tailTokens, { linkRefs, ...RENDER_OPTS })
      : ''
    this.renderedChars += deltaHtml.length + tailHtml.length

    // Reconcile everything after the frozen prefix — newly-settled delta plus
    // tail — in ONE morph. Morphing (not re-parsing) means the blocks that are
    // settling right now keep the DOM node identity they already had as last
    // frame's tail (CSS transitions, text selection, and media in a block
    // survive its freeze frame), and the trailing-child trim removes last
    // frame's leftover tail nodes and any block-level pending elements.
    // Seam rule: `renderBlocks` joins non-empty top-level blocks with '\n'
    // (gap B) — empty parts get neither a seam nor an append.
    const parts: string[] = []
    if (deltaHtml !== '') parts.push(sanitizeRenderedMarkdown(deltaHtml))
    if (tailHtml !== '') parts.push(sanitizeRenderedMarkdown(tailHtml))
    const lead = this.frozenHasHtml && parts.length > 0 ? '\n' : ''
    morphInnerHtmlFrom(
      completedEl,
      this.frozenNodeCount,
      parts.length > 0 ? lead + parts.join('\n') : '',
    )

    // Advance the frozen bookkeeping over the delta's nodes. The count comes
    // from parsing the delta fragment alone (top-level parts are elements, so
    // concatenation cannot merge text nodes across the delta/tail boundary);
    // it is O(delta), which totals O(n) over a whole stream (gap C: never
    // inferred from token indices — blanks/refs emit nothing, list/blockquote
    // runs collapse to one element).
    if (deltaHtml !== '') {
      const probe = completedEl.cloneNode(false) as HTMLElement
      probe.innerHTML = lead + (parts[0] ?? '')
      this.frozenNodeCount += probe.childNodes.length
      this.frozenHasHtml = true
    }
    this.frozenEnd = advanceTo
    this.frozenSource = complete.slice(0, advanceTo)
    this.lastLinkRefKey = linkRefKey
  }

  private fullMorph(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefKey: string,
  ): void {
    const html = sanitizeRenderedMarkdown(renderMarkdown(complete, { tokens }))
    this.renderedChars += html.length
    morphInnerHtml(completedEl, html)
    this.frozenEnd = 0
    this.frozenSource = ''
    this.frozenHasHtml = false
    this.frozenNodeCount = 0
    this.lastLinkRefKey = linkRefKey
  }
}
