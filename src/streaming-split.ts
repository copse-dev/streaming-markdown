/**
 * Streaming split driven by block + inline tokenizer state (#475).
 */
import {
  lastLinkRefDefStart,
  streamingHoldStart,
  TABLE_SEP_RE,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import { emphasisSpansNewline, pendingHoldIndex } from './inline-emphasis.ts'

export interface StreamingSplit {
  complete: string
  pending: string
  /** First line of the open list item when `pending` continues it. */
  openListItemFirstLine?: string
  /**
   * `pending` is a later line of the open trailing paragraph — a lazy
   * continuation. The tokenizer kept the line inside the paragraph precisely
   * because it cannot interrupt one (not a heading/list/quote/fence/table
   * start), so on commit it is guaranteed to join the trailing committed
   * `<p>` after a soft break. Emitters use this to render the pending tail
   * *inside* that `<p>` instead of as a separate block that would visibly
   * merge upward on commit (#11).
   */
  paragraphContinuation?: boolean
}

/**
 * A `StreamingSplit` that also carries the `tokenizeBlocks(content)` result
 * computed while deciding the commit boundary. Callers thread these tokens back
 * into the block helpers so a single `update()` tokenizes `content` once (#21).
 */
export interface StreamingSplitWithTokens extends StreamingSplit {
  /** `tokenizeBlocks(content)` — the tokens of the *full* streamed content. */
  blocks: BlockToken[]
}

/** Split streamed content at the last newline (legacy helper). */
export function splitAtLastNewline(content: string): StreamingSplit {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
}

function splitOpenBlockAtLastNewline(
  block: BlockToken,
  content: string,
  extras: Partial<Omit<StreamingSplit, 'complete' | 'pending'>> = {},
): StreamingSplit {
  const openText = content.slice(block.start)
  const { complete: lineComplete, pending } = splitAtLastNewline(openText)
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
    ...extras,
  }
}

function splitOpenParagraph(block: BlockToken, content: string): StreamingSplit {
  const openText = content.slice(block.start)
  const inlineHold = pendingHoldIndex(openText)

  if (emphasisSpansNewline(openText) && inlineHold >= openText.length) {
    return {
      complete: content.slice(0, block.start),
      pending: content.slice(block.start),
    }
  }

  if (inlineHold < openText.length) {
    const cut = block.start + inlineHold
    return { complete: content.slice(0, cut), pending: content.slice(cut) }
  }

  const split = splitOpenBlockAtLastNewline(block, content)
  // Committed lines of this same open paragraph exist, so the pending line is
  // a lazy continuation of the trailing committed <p>. (The inline-hold paths
  // above are excluded: there the cut can land mid-line, where a soft-break
  // join would be wrong.)
  if (split.pending !== '' && split.complete.length > block.start) {
    split.paragraphContinuation = true
  }
  return split
}

function openListItemFirstLine(block: BlockToken, content: string): string {
  const slice = content.slice(block.start)
  const nl = slice.indexOf('\n')
  return nl === -1 ? slice : slice.slice(0, nl)
}

function splitOpenListItem(block: BlockToken, content: string): StreamingSplit {
  return splitOpenBlockAtLastNewline(block, content, {
    openListItemFirstLine: openListItemFirstLine(block, content),
  })
}

/**
 * Split an OPEN blank-free run of link reference definitions (ADR 0004
 * Phase 2): commit the leading, already-settled definitions and hold only the
 * run's final definition — the one part later input can still change (a
 * next-line title/destination continuation, or its still-streaming last line).
 * Holding the whole run instead made `complete` retreat past every committed
 * definition each time a new definition line started streaming and return when
 * it terminated — flipping the committed link-reference map back and forth and
 * degrading definition-heavy documents (keepachangelog shape) to a bounded
 * full-morph fallback per flip.
 */
function splitOpenLinkRefRun(block: BlockToken, content: string): StreamingSplit {
  const cut = block.start + lastLinkRefDefStart(content.slice(block.start, block.end))
  return {
    complete: content.slice(0, cut),
    pending: content.slice(cut),
  }
}

function splitOpenTable(block: BlockToken, content: string): StreamingSplit {
  const openText = content.slice(block.start)
  const lines = openText.split('\n')
  const sepLine = lines[1]
  if (!sepLine || !TABLE_SEP_RE.test(sepLine)) {
    return {
      complete: content.slice(0, block.start),
      pending: openText,
    }
  }

  const headerSepEnd = (lines[0]?.length ?? 0) + 1 + sepLine.length
  const afterSep = openText.slice(headerSepEnd)
  // Hold header + separator until the separator line is newline-terminated.
  if (!afterSep.startsWith('\n') && lines.length <= 2) {
    return {
      complete: content.slice(0, block.start),
      pending: openText,
    }
  }

  return splitOpenBlockAtLastNewline(block, content)
}

/**
 * Split streaming content at a tokenizer-safe commit boundary. Completed blocks
 * are committed; open, ambiguous, or partially-resolved inline regions stay pending.
 *
 * The result deliberately carries `blocks` — the `tokenizeBlocks(content)` array
 * computed while deciding the boundary — so per-frame callers tokenize once
 * (#21). Callers that snapshot/`deepEqual`/serialize the result should compare
 * the `StreamingSplit` fields and ignore `blocks` (it is derived, O(document),
 * and fully determined by `content`).
 *
 * @experimental Low-level streaming-boundary helper used by the renderer internals;
 * not part of the stable v1 surface (#147). Prefer `renderStreamingMarkdown` /
 * `StreamingMarkdownRenderer`. May move behind a subpath or be removed in a minor
 * release.
 */
export function splitForStreaming(content: string): StreamingSplitWithTokens {
  return splitForStreamingFrom(content, tokenizeBlocks(content))
}

/**
 * `splitForStreaming` with the tokenization supplied by the caller — the entry
 * point for incremental tokenization (#30), where `blocks` comes from an
 * `IncrementalSourceScanner` instead of a fresh full-string scan. `blocks` must
 * equal `tokenizeBlocks(content)`.
 */
export function splitForStreamingFrom(
  content: string,
  blocks: BlockToken[],
): StreamingSplitWithTokens {
  return { ...splitForStreamingCore(content, blocks), blocks }
}

/** Commit-boundary decision, given the already-computed `content` tokens (#21). */
function splitForStreamingCore(content: string, blocks: BlockToken[]): StreamingSplit {
  const firstOpen = blocks.find((b) => b.status !== 'complete')

  if (!firstOpen) {
    return splitAtLastNewline(content)
  }

  if (firstOpen.kind === 'paragraph') {
    return splitOpenParagraph(firstOpen, content)
  }

  if (firstOpen.kind === 'list_item') {
    return splitOpenListItem(firstOpen, content)
  }

  if (firstOpen.kind === 'table') {
    return splitOpenTable(firstOpen, content)
  }

  if (firstOpen.kind === 'link_ref_def') {
    return splitOpenLinkRefRun(firstOpen, content)
  }

  if (firstOpen.kind === 'blockquote') {
    // Commit the quote's terminated lines and keep only the partial last line
    // pending. Holding the whole open quote would re-expose committed lines as
    // raw `>`-marked pending text on every later line — and let a committed
    // `> [!NOTE]` alert flash back to its literal marker (#72).
    return splitOpenBlockAtLastNewline(firstOpen, content)
  }

  const holdStart = streamingHoldStart(blocks)
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart),
  }
}
