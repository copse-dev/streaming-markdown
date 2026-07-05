// Incremental block tokenization + link-reference scanning (#30).
//
// Streaming re-runs two pure-string scans on every update: `tokenizeBlocks`
// over the full content, and `parseLinkReferenceDefinitions` over the committed
// prefix on every commit. Both are O(prefix) per call, which keeps total
// streaming cost Θ(n²) even after the DOM layer became O(tail) per commit
// (issue #21 limitation K).
//
// `IncrementalSourceScanner` makes both scans resume from a saved offset. The
// stream is append-only in the common case, so everything before a *safe
// boundary* can never re-tokenize differently:
//
//   A safe boundary sits at the end of a COMPLETE `blank` token whose nearest
//   preceding non-blank token is not a `list_item`, `indented_code`, or
//   `blockquote` — the three kinds whose single token can extend backward
//   across blank lines (an indented continuation joins the previous list item;
//   indented code merges across blanks; blockquote tokens continue across
//   blank runs). Every other kind is sealed by a blank at the tokenizer level:
//   lazy paragraph continuation, setext underlines, and table rows cannot
//   cross a blank line, and an open fence swallows blank lines into its own
//   token so no blank *token* can exist inside one.
//
// Tokenizing the suffix from a safe boundary therefore yields byte-identical
// tokens to tokenizing the whole string and slicing — verified exhaustively by
// the equivalence tests. Link-reference definitions cannot span a blank line
// either (CommonMark), and `parseLinkReferenceDefinitions` treats slice start
// as a line start, so the definition map is the cached prefix map merged
// first-definition-wins (#544) with a suffix scan.
//
// Rewrites (message regeneration/edit) are caught the same way the frozen DOM
// guards them: the retained safe prefix must remain a byte prefix of the new
// source (a memcmp), else the cache resets and the scan starts over — correct,
// just not incremental for that update.
import { tokenizeBlocks, type BlockToken } from './block-tokenizer.ts'
import {
  parseLinkReferenceDefinitions,
  type LinkReference,
  type LinkReferenceMap,
} from './link-references.ts'

/** Kinds whose token can absorb later lines across a blank run (see header). */
function canExtendAcrossBlank(kind: BlockToken['kind']): boolean {
  return kind === 'list_item' || kind === 'indented_code' || kind === 'blockquote'
}

/**
 * Walk `tokens` from `fromIdx`, returning the furthest safe boundary found:
 * the token count and source offset just past a qualifying complete blank.
 * Returns the input position when no further safe boundary exists.
 */
function advanceSafeBoundary(
  tokens: BlockToken[],
  fromIdx: number,
  fromOffset: number,
  lastNonBlankKind: BlockToken['kind'] | null,
): { tokenCount: number; offset: number; lastNonBlankKind: BlockToken['kind'] | null } {
  let tokenCount = fromIdx
  let offset = fromOffset
  let lastKind = lastNonBlankKind
  for (let i = fromIdx; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      if (token.status === 'complete' && (lastKind === null || !canExtendAcrossBlank(lastKind))) {
        tokenCount = i + 1
        offset = token.end
      }
      continue
    }
    lastKind = token.kind
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
      tokens,
      this.safeTokenCount,
      this.safeOffset,
      this.lastNonBlankKind,
    )
    if (advanced.offset > this.safeOffset) {
      const newlySafe = parseLinkReferenceDefinitions(source.slice(this.safeOffset, advanced.offset))
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
   * `parseLinkReferenceDefinitions(source)`. Must be called with the same
   * string as the latest {@link tokenize} call (the cache is keyed to it);
   * anything else falls back to a full scan.
   */
  linkRefs(source: string): LinkReferenceMap {
    if (!source.startsWith(this.safePrefix)) {
      return parseLinkReferenceDefinitions(source)
    }
    const merged = new Map(this.refs)
    const suffixRefs = parseLinkReferenceDefinitions(source.slice(this.safeOffset))
    for (const [label, ref] of suffixRefs) {
      if (!merged.has(label)) merged.set(label, ref)
    }
    return merged
  }
}
