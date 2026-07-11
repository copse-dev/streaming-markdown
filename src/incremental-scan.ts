// Incremental block tokenization + link-reference scanning (#30).
//
// Streaming re-runs two pure-string scans on every update: `tokenizeBlocks`
// over the full content, and `collectLinkReferenceDefinitions` over the committed
// prefix on every commit. Both are O(prefix) per call, which keeps total
// streaming cost Θ(n²) even after the DOM layer became O(tail) per commit
// (issue #21 limitation K).
//
// `IncrementalSourceScanner` makes both scans resume from a saved offset. The
// stream is append-only in the common case, so everything before a *safe
// boundary* can never re-tokenize differently:
//
//   A safe boundary sits at the end of a COMPLETE `blank` token. When the
//   nearest preceding non-blank token is not a `list_item`, `indented_code`,
//   `blockquote`, or `footnote_def` — the kinds whose single token can extend
//   backward across blank lines (an indented continuation joins the previous
//   list item; indented code merges across blanks; blockquote/footnote tokens
//   continue across blank runs) — the blank is sealed by the tokenizer and safe
//   immediately: lazy paragraph continuation, setext underlines, and table rows
//   cannot cross a blank line, and an open fence swallows blank lines into its
//   own token so no blank *token* can exist inside one.
//
//   After one of those extendable kinds the blank is only safe once a later
//   COMPLETE (newline-terminated) non-blank token appears (#111). While the
//   extendable container is still the open tail, an append can retroactively
//   pull the blank into it (a loose-list interior blank, a lazy continuation,
//   an indented-code gap), so freezing there would diverge from a fresh scan.
//   A terminated block downstream freezes every earlier break decision, proving
//   the blank a real separator — so long lists/quotes stop re-tokenizing from
//   their container top on every update while interior blanks stay correct.
//
// Tokenizing the suffix from a safe boundary therefore yields byte-identical
// tokens to tokenizing the whole string and slicing — verified exhaustively by
// the equivalence tests. Link-reference definitions cannot span a blank line
// either (CommonMark), and `collectLinkReferenceDefinitions` tokenizes its
// input from a line start, so the definition map is the cached prefix map
// merged first-definition-wins (#544) with a suffix scan.
//
// Rewrites (message regeneration/edit) are caught the same way the frozen DOM
// guards them: the retained safe prefix must remain a byte prefix of the new
// source (a memcmp), else the cache resets and the scan starts over — correct,
// just not incremental for that update.
import {
  collectLinkReferenceDefinitions,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import { type LinkReference, type LinkReferenceMap } from './link-references.ts'

/** Kinds whose token can absorb later lines across a blank run (see header). */
function canExtendAcrossBlank(kind: BlockToken['kind']): boolean {
  // A footnote definition (#72) continues across a blank via a 4-column-
  // indented line (multi-paragraph content), like a list item.
  return (
    kind === 'list_item' ||
    kind === 'indented_code' ||
    kind === 'blockquote' ||
    kind === 'footnote_def'
  )
}

/**
 * Whether `source[start, end)` (a complete token) ends on a blank line — i.e. the
 * text just before its final newline is empty or all whitespace. Ordered/loose
 * list items (and footnote defs) swallow their trailing blank line into their own
 * token instead of leaving a separate `blank` token (the LLM-shaped numbered-list
 * divergence), so their end still sits on a blank-line boundary that no link-
 * reference definition or lazy continuation can span.
 */
function endsWithBlankLine(source: string, start: number, end: number): boolean {
  if (end <= start || source[end - 1] !== '\n') return false
  let p = end - 2
  while (p >= start && source[p] !== '\n') p--
  for (let k = p + 1; k < end - 1; k++) {
    const c = source[k]
    if (c !== ' ' && c !== '\t' && c !== '\r') return false
  }
  return true
}

/**
 * Walk `tokens` from `fromIdx`, returning the furthest safe boundary found:
 * the token count and source offset just past a qualifying complete blank.
 * Returns the input position when no further safe boundary exists.
 *
 * A complete `blank` whose nearest preceding non-blank kind cannot extend across
 * blanks is sealed at the tokenizer level and is safe immediately (paragraphs,
 * setext, tables, fences — see the header). A complete `blank` after an
 * *extendable* kind (`list_item`/`indented_code`/`blockquote`/`footnote_def`) is
 * only *provisionally* safe (#111): that container can still grow backward across
 * the blank as long as the line after it is absent or unfrozen (an all-whitespace
 * tail can gain indentation and become an indented continuation; nothing has yet
 * proved the blank a real separator). Such a blank is promoted to a real boundary
 * only once a later **complete** (newline-terminated) non-blank token appears: a
 * terminated line downstream freezes every break decision up to it — the
 * container's extent can no longer change under append — so the intervening blank
 * is provably a separator. Only the final token of a scan can be incomplete, so
 * "a complete non-blank token follows" is exactly "the extendable container is no
 * longer the open tail". This keeps list-/blockquote-shaped streams O(n): once an
 * item/quote is followed by the next completed block it freezes, instead of
 * re-tokenizing the whole container from its top on every update.
 */
function advanceSafeBoundary(
  source: string,
  tokens: BlockToken[],
  fromIdx: number,
  fromOffset: number,
  lastNonBlankKind: BlockToken['kind'] | null,
): { tokenCount: number; offset: number; lastNonBlankKind: BlockToken['kind'] | null } {
  let tokenCount = fromIdx
  let offset = fromOffset
  let lastKind = lastNonBlankKind
  // Furthest provisional boundary (a blank-line boundary after an extendable
  // kind) not yet confirmed by a downstream terminated block. Promoted in full
  // when one is seen.
  let pending: { tokenCount: number; offset: number } | null = null
  for (let i = fromIdx; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      if (token.status !== 'complete') continue
      if (lastKind === null || !canExtendAcrossBlank(lastKind)) {
        // Tokenizer-sealed: safe immediately, and it supersedes any pending
        // extendable boundary before it.
        tokenCount = i + 1
        offset = token.end
        pending = null
      } else {
        // Provisionally safe: remember the furthest such blank; a later
        // complete non-blank token promotes it.
        pending = { tokenCount: i + 1, offset: token.end }
      }
      continue
    }
    // A terminated non-blank token freezes everything before it, so any pending
    // extendable boundary is now a proven separator.
    if (pending && token.status === 'complete') {
      tokenCount = pending.tokenCount
      offset = pending.offset
      pending = null
    }
    lastKind = token.kind
    // A complete extendable token can swallow its own trailing blank line
    // (ordered / loose list items, footnote defs) instead of leaving a separate
    // `blank` token. Its end sits on a blank-line boundary, so it is provisionally
    // safe on the same terms as a blank token — promoted once a later complete
    // token proves the container stopped there rather than folding onward.
    if (
      token.status === 'complete' &&
      canExtendAcrossBlank(token.kind) &&
      endsWithBlankLine(source, token.start, token.end)
    ) {
      pending = { tokenCount: i + 1, offset: token.end }
    }
  }
  return { tokenCount, offset, lastNonBlankKind: lastKind }
}

/**
 * Incremental tokenizer + link-reference scanner for one growing source string
 * (the raw stream, or the committed prefix). Feed it monotonically growing
 * snapshots via {@link tokenize}; non-append-only snapshots are detected and
 * reset the cache.
 */
export class IncrementalSourceScanner {
  private tokens: BlockToken[] = []
  /** Cached tokens `[0, safeTokenCount)` are final for any future suffix. */
  private safeTokenCount = 0
  /** Source offset of the safe boundary; scans resume here. */
  private safeOffset = 0
  /** The exact source bytes of `[0, safeOffset)` — the rewrite guard. */
  private safePrefix = ''
  /** Nearest non-blank kind before the safe boundary (boundary-rule input). */
  private lastNonBlankKind: BlockToken['kind'] | null = null
  /** Link-reference definitions found in `[0, safeOffset)` (first-wins). */
  private refs = new Map<string, LinkReference>()
  /**
   * Diagnostic: total characters actually re-tokenized across all calls. The
   * #30 invariant is that this stays O(n) over a whole append-only stream —
   * a deterministic, timing-free regression test reads it.
   */
  scannedChars = 0

  private resetCache(): void {
    this.tokens = []
    this.safeTokenCount = 0
    this.safeOffset = 0
    this.safePrefix = ''
    this.lastNonBlankKind = null
    this.refs = new Map()
  }

  /**
   * Discard the cached tokens and safe boundary so the next `tokenize` re-scans
   * from the start. Used when tokenization-affecting config changed mid-stream
   * (#145) and the byte-prefix cache validation can no longer be trusted.
   */
  reset(): void {
    this.resetCache()
  }

  /**
   * Tokenize `source`, reusing every token before the safe boundary. The
   * result is byte-identical to `tokenizeBlocks(source)`.
   */
  tokenize(source: string): BlockToken[] {
    if (!source.startsWith(this.safePrefix)) this.resetCache()

    const suffix = source.slice(this.safeOffset)
    this.scannedChars += suffix.length
    const suffixTokens = tokenizeBlocks(suffix)
    const shifted =
      this.safeOffset === 0
        ? suffixTokens
        : suffixTokens.map((t) => ({
            kind: t.kind,
            status: t.status,
            start: t.start + this.safeOffset,
            end: t.end + this.safeOffset,
          }))
    const tokens =
      this.safeTokenCount === 0 ? shifted : this.tokens.slice(0, this.safeTokenCount).concat(shifted)

    // Advance the safe boundary for the NEXT call, folding the newly-safe
    // region's link-reference definitions into the cached map (first-wins;
    // both cut points are blank boundaries, which no definition can span).
    const advanced = advanceSafeBoundary(
      source,
      tokens,
      this.safeTokenCount,
      this.safeOffset,
      this.lastNonBlankKind,
    )
    if (advanced.offset > this.safeOffset) {
      const newlySafe = collectLinkReferenceDefinitions(
        source.slice(this.safeOffset, advanced.offset),
      )
      for (const [label, ref] of newlySafe) {
        if (!this.refs.has(label)) this.refs.set(label, ref)
      }
    }
    this.safeTokenCount = advanced.tokenCount
    this.safeOffset = advanced.offset
    this.lastNonBlankKind = advanced.lastNonBlankKind
    this.safePrefix = source.slice(0, this.safeOffset)
    this.tokens = tokens
    return tokens
  }

  /**
   * Link-reference definitions of `source`, equal to
   * `collectLinkReferenceDefinitions(source)`. Must be called with the same
   * string as the latest {@link tokenize} call (the cache is keyed to it);
   * anything else falls back to a full scan.
   */
  linkRefs(source: string): LinkReferenceMap {
    if (!source.startsWith(this.safePrefix)) {
      return collectLinkReferenceDefinitions(source)
    }
    const merged = new Map(this.refs)
    const suffixRefs = collectLinkReferenceDefinitions(source.slice(this.safeOffset))
    for (const [label, ref] of suffixRefs) {
      if (!merged.has(label)) merged.set(label, ref)
    }
    return merged
  }
}
