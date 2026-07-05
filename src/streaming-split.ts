/**
 * Streaming split driven by block + inline tokenizer state (#475).
 */
import {
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

  return splitOpenBlockAtLastNewline(block, content)
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

  const holdStart = streamingHoldStart(blocks)
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart),
  }
}
