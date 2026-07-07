/**
 * Block-level markdown tokenizer (#475). Identifies block boundaries and whether
 * each block is complete, open (unfinished), or ambiguous (needs more input).
 */
import {
  isValidReferenceLabel,
  parseLinkReferenceDefinitionAt,
  parseLinkReferenceDefinitions,
  type LinkReference,
  type LinkReferenceMap,
} from './link-references.ts'
import {
  ATX_HEADING_DETECT_RE as ATX_HEADING_RE,
  expandListPrefixTabs,
  FENCE_OPEN_RE,
  fenceCloses,
  fenceMarker,
  leadingIndentWidth,
  stripBlockquoteMarker,
} from './block-patterns.ts'

export type BlockKind =
  | 'blank'
  | 'paragraph'
  | 'indented_code'
  | 'atx_heading'
  | 'setext_heading'
  | 'thematic_break'
  | 'fence'
  | 'blockquote'
  | 'list_item'
  | 'table'
  | 'link_ref_def'

export type BlockStatus = 'complete' | 'open' | 'ambiguous'

export interface BlockToken {
  kind: BlockKind
  status: BlockStatus
  /** Inclusive start offset in the source string. */
  start: number
  /** Exclusive end offset in the source string. */
  end: number
}

export interface ScannedLine {
  text: string
  start: number
  end: number
  /** False for the final line when the source does not end with `\n`. */
  terminated: boolean
}

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
// A list marker must be followed by a space/tab or the line end (empty item,
// #281/#283). Not `\s`: that matches NBSP, which is NOT marker whitespace —
// `* a *` is a paragraph, not a list (spec 353).
const UNORDERED_LIST_ITEM_RE = /^ {0,3}[-*+](?:[ \t]|$)/
const ORDERED_LIST_MARKER_RE = /^ {0,3}(\d{1,9})([.)])(?:[ \t]|$)/
const LIST_ITEM_RE = /^ {0,3}(?:(?:[-*+])(?:[ \t]|$)|(?:\d{1,9}[.)](?:[ \t]|$)))/
const EMPTY_LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const BLOCKQUOTE_RE = /^ {0,3}> ?/
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/
export const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Parse a valid ordered-list marker (1–9 digits); returns null for invalid markers like 10-digit #266. */
export function parseOrderedListMarker(line: string): number | null {
  const m = line.match(ORDERED_LIST_MARKER_RE)
  if (!m?.[1]) return null
  return parseInt(m[1], 10)
}

export function orderedListMarkerDelimiter(line: string): '.' | ')' | null {
  const m = line.match(ORDERED_LIST_MARKER_RE)
  const d = m?.[2]
  if (d === '.' || d === ')') return d
  return null
}

export function isUnorderedListItemLine(line: string): boolean {
  return UNORDERED_LIST_ITEM_RE.test(line)
}

export function isListItemLine(line: string): boolean {
  return isUnorderedListItemLine(line) || parseOrderedListMarker(line) !== null
}

export function unorderedListMarkerChar(line: string): '-' | '*' | '+' | null {
  const m = line.match(/^ {0,3}([-*+])(?:\s|$)/)
  const ch = m?.[1]
  if (ch === '-' || ch === '*' || ch === '+') return ch
  return null
}

/** True when a list marker line has no content after the marker (empty item, #281/#283/#315). */
export function isEmptyListItemLine(line: string): boolean {
  const m = line.match(EMPTY_LIST_ITEM_RE)
  if (!m) return false
  return line.slice(m[0].length).trim() === ''
}

/**
 * Column of the first content character in a list item line (#255 vs #256, #276).
 *
 * CommonMark: content begins at the marker width plus the number of following
 * spaces N when 1 ≤ N ≤ 4. If N ≥ 5 (or the item is empty) only one space counts
 * and the rest is indented code, so the content column is markerWidth + 1
 * (#273/#274/#278).
 */
export function listItemContentColumn(line: string): number {
  const m = expandListPrefixTabs(line).match(/^( {0,3})(\d{1,9}[.)]|[-*+])( *)(.*)$/)
  if (!m) return Infinity
  const indent = m[1]?.length ?? 0
  const markerWidth = m[2]?.length ?? 0
  const spaces = m[3]?.length ?? 0
  const hasContent = (m[4]?.length ?? 0) > 0
  const n = hasContent && spaces >= 1 && spaces <= 4 ? spaces : 1
  return indent + markerWidth + n
}

/** Continuation indent in COLUMNS (tabs expand at 4-column stops, spec 4/5). */
function lazyContinuationIndent(line: string): number {
  return leadingIndentWidth(line)
}

/** Ordered marker mid-paragraph (#304): only `1` may interrupt; other markers continue. */
function orderedMarkerContinuesParagraph(prevLine: string, line: string): boolean {
  const num = parseOrderedListMarker(line)
  if (num === null) return false
  if (num === 1) return false
  return prevLine.trimEnd().length > 0
}

function isLazyUnorderedContinuation(itemStartLine: string, line: string): boolean {
  if (isListItemLine(line)) return false
  return lazyContinuationIndent(line) >= listItemContentColumn(itemStartLine)
}

/** True when `line` continues the open list item started on `itemStartLine`. */
export function isLazyListContinuation(itemStartLine: string, line: string): boolean {
  return isLazyUnorderedContinuation(itemStartLine, line)
}

function lineContainsPipeCellDelimiter(line: string): boolean {
  return line.includes('|') && line.trim() !== ''
}

/** Prose metadata lines use inline pipes as separators, not GFM table cells. */
function isProseMetadataPipeLine(line: string): boolean {
  if (!lineContainsPipeCellDelimiter(line)) return false
  const trimmed = line.trimStart()
  if (/\*\*[^*\n]+:\*\*/.test(trimmed)) return true
  if (/&nbsp;/i.test(trimmed)) return true
  return false
}

/** True when a line participates in GFM table syntax (not prose metadata with inline pipes). */
export function isGfmTableRowLine(line: string): boolean {
  if (!lineContainsPipeCellDelimiter(line)) return false
  if (isProseMetadataPipeLine(line)) return false
  const trimmed = line.trimStart()
  if (trimmed.startsWith('|')) return true
  return splitTableRow(trimmed).length >= 2
}

function isTableRow(line: string): boolean {
  return isGfmTableRowLine(line)
}

/**
 * GFM requires the header row and the delimiter row to have the same number of
 * columns; otherwise the construct is not a table at all (spec 203).
 */
export function tableColumnsMatch(headerLine: string, sepLine: string): boolean {
  return splitTableRow(headerLine).length === splitTableRow(sepLine).length
}

/**
 * A GFM table body is broken by a blank line or the start of another block-level
 * structure (spec 202); any other non-blank line — even one without pipes — is a
 * body row (rendered as a single cell, padded to the header's column count).
 */
function endsTableBody(line: string): boolean {
  if (line.trim() === '') return true
  return (
    ATX_HEADING_RE.test(line) ||
    THEMATIC_BREAK_RE.test(line) ||
    FENCE_OPEN_RE.test(line) ||
    LIST_ITEM_RE.test(line) ||
    BLOCKQUOTE_RE.test(line)
  )
}

/** Separator line still streaming (e.g. `| -` before the full `| - | - |`). */
function isPartialTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-{1,}/.test(trimmed)
}

/**
 * True when a pipe row may be the start of a GFM table that is not yet safe to
 * render (no confirmed separator). Avoids treating `| A | B |` as prose while
 * streaming.
 */
export function isPotentialTableStart(lines: ScannedLine[], i: number): boolean {
  const line = lines[i]
  if (!line || !isTableRow(line.text)) return false
  const next = lines[i + 1]
  // A terminated separator line is definitive: it's a table iff the column counts
  // match (spec 203). An unterminated one is still streaming and may yet gain
  // columns (`| - |` → `| - | - |`), so hold it as a potential table.
  if (next && TABLE_SEP_RE.test(next.text)) {
    return next.terminated ? tableColumnsMatch(line.text, next.text) : true
  }
  if (next && isPartialTableSeparatorLine(next.text)) return true
  if (next && isTableRow(next.text)) return true
  return line.text.trimStart().startsWith('|')
}

/** Scan source into lines while preserving byte offsets. */
export function scanLines(source: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let i = 0
  while (i <= source.length) {
    const start = i
    const end = source.indexOf('\n', i)
    if (end === -1) {
      if (start < source.length) {
        lines.push({ text: source.slice(start), start, end: source.length, terminated: false })
      }
      break
    }
    lines.push({ text: source.slice(start, end), start, end: end + 1, terminated: true })
    i = end + 1
  }
  return lines
}

function pushBlock(
  blocks: BlockToken[],
  kind: BlockKind,
  status: BlockStatus,
  start: number,
  end: number,
): void {
  if (end <= start) return
  blocks.push({ kind, status, start, end })
}

function tryLinkRefDefBlock(lines: ScannedLine[], i: number): number | null {
  const startLine = lines[i]
  if (!startLine || !/^ {0,3}\[/.test(startLine.text)) return null
  // A definition cannot span a blank line and its continuation lines cannot be
  // block starts, so gather the contiguous run those rules allow.
  let buf = ''
  let runLines = 0
  for (let j = i; j < lines.length; j++) {
    const line = lines[j]
    if (!line || line.text.trim() === '') break
    if (
      j > i &&
      (ATX_HEADING_RE.test(line.text) ||
        LIST_ITEM_RE.test(line.text) ||
        BLOCKQUOTE_RE.test(line.text) ||
        fenceMarker(line.text) ||
        THEMATIC_BREAK_RE.test(line.text))
    ) {
      break
    }
    buf += line.text
    if (line.terminated) buf += '\n'
    runLines++
  }
  // Consume as many consecutive definitions as parse from the start of the
  // run — a definition may span several lines (destination and title on their
  // own lines, spec 193/217) and several definitions may sit back to back.
  let offset = 0
  let consumedLines = 0
  while (offset < buf.length && consumedLines < runLines) {
    let k = offset
    let indent = 0
    while (buf[k] === ' ' && indent < 4) {
      k++
      indent++
    }
    if (indent > 3 || buf[k] !== '[') break
    const def = parseLinkReferenceDefinitionAt(buf, k)
    if (!def || !isValidReferenceLabel(def.label)) break
    const segment = buf.slice(offset, def.end)
    consumedLines += (segment.match(/\n/g)?.length ?? 0) + (segment.endsWith('\n') ? 0 : 1)
    offset = def.end
  }
  if (consumedLines === 0) return null
  return i + consumedLines
}

/**
 * Whether a block fragment's last block is a paragraph still open for lazy
 * continuation, descending through nested blockquotes and list items
 * (spec 250/251/292).
 */
function endsInOpenParagraph(fragment: string): boolean {
  const last = tokenizeBlocks(fragment).at(-1)
  if (!last) return false
  if (last.kind === 'paragraph') return true
  // The token slices keep their final newline; `split`/`join` round-trips it.
  if (last.kind === 'blockquote') {
    const inner = fragment
      .slice(last.start, last.end)
      .split('\n')
      .map((l) => stripBlockquoteMarker(l))
      .join('\n')
    return endsInOpenParagraph(inner)
  }
  if (last.kind === 'list_item') {
    const lines = fragment.slice(last.start, last.end).split('\n')
    const col = listItemContentColumn(lines[0] ?? '')
    const inner = lines
      .map((l, idx) => {
        if (idx === 0) return l.slice(Math.min(col, l.length))
        const indent = /^ */.exec(l)?.[0].length ?? 0
        return l.slice(Math.min(col, indent))
      })
      .join('\n')
    return endsInOpenParagraph(inner)
  }
  return false
}

function breaksUnorderedListItem(lines: ScannedLine[], itemStart: number, j: number): boolean {
  const itemStartLine = lines[itemStart]?.text ?? ''
  const col = listItemContentColumn(itemStartLine)
  const next = lines[j]
  if (!next) return true
  // An item that begins empty can begin with at most one blank line: a blank
  // directly after the bare marker ends the item (spec 280).
  if (next.text.trim() === '' && j === itemStart + 1 && isEmptyListItemLine(itemStartLine)) {
    return true
  }
  if (next.text.trim() === '') {
    let k = j + 1
    while (k < lines.length && lines[k]?.text.trim() === '') k++
    const after = lines[k]
    if (!after) return true
    // Indented at least to the content column → still inside this item
    // (nested list, indented code, fence, blockquote, ...).
    if (lazyContinuationIndent(after.text) >= col) return false
    if (isListItemLine(after.text)) return true
    return !isLazyUnorderedContinuation(itemStartLine, after.text)
  }
  if (lazyContinuationIndent(next.text) >= col && next.text.trim() !== '') return false
  if (isListItemLine(next.text)) return true
  if (
    ATX_HEADING_RE.test(next.text) ||
    THEMATIC_BREAK_RE.test(next.text) ||
    fenceMarker(next.text) ||
    BLOCKQUOTE_RE.test(next.text) ||
    tryLinkRefDefBlock(lines, j) !== null ||
    (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
  ) {
    return true
  }
  return false
}

/**
 * Tokenize block-level markdown. When the final line is not newline-terminated the
 * last block is marked `open` or `ambiguous` instead of `complete`.
 */
export function tokenizeBlocks(source: string): BlockToken[] {
  const lines = scanLines(source)
  const blocks: BlockToken[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line) break

    if (line.text.trim() === '') {
      pushBlock(blocks, 'blank', line.terminated ? 'complete' : 'open', line.start, line.end)
      i++
      continue
    }

    // Indented code block (4+ spaces at a block start; cannot interrupt a
    // paragraph — the paragraph collector consumes indented continuations).
    if (leadingIndentWidth(line.text) >= 4 && line.text.trim() !== '') {
      let j = i + 1
      let lastContent = i
      while (j < lines.length) {
        const next = lines[j]
        if (!next) break
        if (next.text.trim() === '') {
          j++
          continue
        }
        if (leadingIndentWidth(next.text) >= 4) {
          lastContent = j
          j++
          continue
        }
        break
      }
      const last = lines[lastContent] ?? line
      const terminatorSeen = j < lines.length && lines[j] !== undefined
      const status: BlockStatus = !last.terminated ? 'open' : terminatorSeen ? 'complete' : 'open'
      pushBlock(blocks, 'indented_code', status, line.start, last.end)
      i = lastContent + 1
      continue
    }

    const fence = fenceMarker(line.text)
    if (fence) {
      const fenceStart = line.start
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const next = lines[j]
        if (next && fenceCloses(fence.marker, fence.len, next.text)) {
          closed = true
          pushBlock(blocks, 'fence', 'complete', fenceStart, next.end)
          i = j + 1
          break
        }
        j++
      }
      if (!closed) {
        const end = lines.at(-1)?.end ?? source.length
        pushBlock(blocks, 'fence', 'open', fenceStart, end)
        break
      }
      continue
    }

    if (ATX_HEADING_RE.test(line.text)) {
      const status: BlockStatus = line.terminated ? 'complete' : 'ambiguous'
      pushBlock(blocks, 'atx_heading', status, line.start, line.end)
      i++
      continue
    }

    if (THEMATIC_BREAK_RE.test(line.text)) {
      const status: BlockStatus = line.terminated ? 'complete' : 'ambiguous'
      pushBlock(blocks, 'thematic_break', status, line.start, line.end)
      i++
      continue
    }

    const linkRefEnd = tryLinkRefDefBlock(lines, i)
    if (linkRefEnd !== null) {
      const last = lines[linkRefEnd - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'link_ref_def', status, line.start, last.end)
      i = linkRefEnd
      continue
    }

    if (isListItemLine(line.text)) {
      const isOrdered = parseOrderedListMarker(line.text) !== null
      const itemStart = line.start
      let j = i + 1
      while (j < lines.length) {
        if (isOrdered) {
          const next = lines[j]
          if (!next) break
          if (
            next.text.trim() !== '' &&
            lazyContinuationIndent(next.text) >= listItemContentColumn(line.text)
          ) {
            j++
            continue
          }
          if (isListItemLine(next.text)) break
          if (next.text.trim() === '') {
            j++
            continue
          }
          // After a blank line, a 4-column-indented line under the content
          // column cannot continue the item — `    3. c` under a content
          // column of 5 is indented code after the list (spec 313). Unindented
          // prose after a blank still folds into the item: a deliberate
          // divergence for LLM-shaped numbered lists (renderer-fixtures).
          if ((lines[j - 1]?.text.trim() ?? '') === '' && leadingIndentWidth(next.text) >= 4) {
            break
          }
          if (
            ATX_HEADING_RE.test(next.text) ||
            THEMATIC_BREAK_RE.test(next.text) ||
            fenceMarker(next.text) ||
            BLOCKQUOTE_RE.test(next.text) ||
            tryLinkRefDefBlock(lines, j) !== null ||
            (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
          ) {
            break
          }
          j++
          continue
        }
        if (breaksUnorderedListItem(lines, i, j)) break
        j++
      }
      const last = lines[j - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'list_item', status, itemStart, last.end)
      i = j
      continue
    }

    if (BLOCKQUOTE_RE.test(line.text)) {
      const bqStart = line.start
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        if (!next) break
        // A blank line always ends a blockquote (spec 242/252); consecutive
        // `>` groups separated by blanks are separate blockquotes.
        if (next.text.trim() === '') break
        if (!BLOCKQUOTE_RE.test(next.text)) {
          if (
            ATX_HEADING_RE.test(next.text) ||
            LIST_ITEM_RE.test(next.text) ||
            fenceMarker(next.text) ||
            THEMATIC_BREAK_RE.test(next.text)
          ) {
            break
          }
          // Laziness: an unmarked line continues the quote only while the
          // quote's content ends in an open paragraph — never an indented
          // code block, an open fence, or a closed-by-`>`-blank paragraph
          // (spec 236/237/249). Nested quotes recurse (spec 250/251).
          const stripped =
            lines
              .slice(i, j)
              .map((l) => stripBlockquoteMarker(l.text))
              .join('\n') + '\n'
          if (!endsInOpenParagraph(stripped)) break
        }
        j++
      }
      const last = lines[j - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'blockquote', status, bqStart, last.end)
      i = j
      continue
    }

    if (isTableRow(line.text)) {
      const nextLine = lines[i + 1]
      if (
        nextLine &&
        TABLE_SEP_RE.test(nextLine.text) &&
        tableColumnsMatch(line.text, nextLine.text)
      ) {
        const tableStart = line.start
        let j = i + 2
        while (j < lines.length) {
          const row = lines[j]
          if (!row || endsTableBody(row.text)) break
          j++
        }
        const last = lines[j - 1] ?? lines[i + 1] ?? line
        const lastRow = lines[j - 1]
        const status: BlockStatus =
          lastRow && !lastRow.terminated && j === lines.length ? 'open' : 'complete'
        pushBlock(blocks, 'table', status, tableStart, last.end)
        i = j
        continue
      }

      if (isPotentialTableStart(lines, i)) {
        const tableStart = line.start
        let j = i + 1
        while (j < lines.length) {
          const nl = lines[j]
          if (!nl) break
          // A *terminated* separator line ends the potential-table scan: the
          // header/separator pair is judged by the definitive branch above on
          // the next pass. An unterminated one is the streaming tail of this
          // forming table (`|---` may yet gain columns) — hold it here so the
          // header and its half-arrived separator stay one block.
          if (nl.terminated && TABLE_SEP_RE.test(nl.text)) break
          if (
            !isTableRow(nl.text) &&
            !isPartialTableSeparatorLine(nl.text) &&
            nl.text.trim() !== ''
          ) {
            break
          }
          j++
        }
        const last = lines[j - 1] ?? line
        const status: BlockStatus =
          last.terminated && j > i + 1 ? 'open' : last.terminated ? 'ambiguous' : 'open'
        pushBlock(blocks, 'table', status, tableStart, last.end)
        i = j
        continue
      }
    }

    // Setext heading: text line followed by === or --- on the next line.
    const nextLine = lines[i + 1]
    if (nextLine && SETEXT_UNDERLINE_RE.test(nextLine.text)) {
      if (!nextLine.terminated) {
        // While `---` / `===` is still streaming, keep the text line visible as
        // prose and hold the underline as a pending thematic candidate. Treating
        // the pair as an ambiguous setext block would hide committed paragraphs.
        pushBlock(blocks, 'paragraph', line.terminated ? 'complete' : 'open', line.start, line.end)
        pushBlock(blocks, 'thematic_break', 'ambiguous', nextLine.start, nextLine.end)
        i += 2
        continue
      }
      pushBlock(blocks, 'setext_heading', 'complete', line.start, nextLine.end)
      i += 2
      continue
    }

    // Final line without newline: open paragraph (setext text line is still open
    // until a following ===/--- line arrives, handled above).
    if (!line.terminated && i === lines.length - 1) {
      if (isPotentialTableStart(lines, i)) {
        pushBlock(blocks, 'table', 'ambiguous', line.start, line.end)
      } else {
        pushBlock(blocks, 'paragraph', 'open', line.start, line.end)
      }
      break
    }

    // Paragraph: collect consecutive non-blank lines until a block boundary.
    const paraStart = line.start
    let j = i + 1
    let setextUnderline: ScannedLine | null = null
    while (j < lines.length) {
      const next = lines[j]
      if (!next || next.text.trim() === '') break
      // A setext underline closes the WHOLE collected paragraph into a
      // heading (spec 81/95) — checked before the thematic-break test so a
      // `---` after paragraph text reads as an underline, not an <hr>.
      if (next.terminated && SETEXT_UNDERLINE_RE.test(next.text)) {
        setextUnderline = next
        break
      }
      if (
        ATX_HEADING_RE.test(next.text) ||
        THEMATIC_BREAK_RE.test(next.text) ||
        (LIST_ITEM_RE.test(next.text) &&
          // An empty list item cannot interrupt a paragraph (#285).
          !isEmptyListItemLine(next.text) &&
          !orderedMarkerContinuesParagraph(lines[j - 1]?.text ?? '', next.text)) ||
        BLOCKQUOTE_RE.test(next.text) ||
        fenceMarker(next.text) ||
        // NOTE: a link reference definition cannot interrupt a paragraph
        // (spec 213) — a `[label]: dest` line here is a lazy continuation.
        (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
      ) {
        break
      }
      j++
    }
    if (setextUnderline) {
      pushBlock(blocks, 'setext_heading', 'complete', paraStart, setextUnderline.end)
      i = j + 1
      continue
    }
    const last = lines[j - 1] ?? line
    const status: BlockStatus = last.terminated ? 'complete' : 'open'
    pushBlock(blocks, 'paragraph', status, paraStart, last.end)
    i = j
  }

  return blocks
}

/**
 * Collect link reference definitions with block context: definitions live only
 * in `link_ref_def` blocks (never inside fenced code, spec 212, or paragraph
 * continuations, spec 213) and inside blockquotes (spec 218), which are
 * unwrapped and scanned recursively. First definition wins, in source order.
 * Pass `tokens` (`tokenizeBlocks(source)`) to reuse an existing tokenization.
 */
export function collectLinkReferenceDefinitions(
  source: string,
  tokens?: BlockToken[],
): LinkReferenceMap {
  const blocks = tokens ?? tokenizeBlocks(source)
  const refs = new Map<string, LinkReference>()
  const merge = (found: LinkReferenceMap): void => {
    for (const [key, ref] of found) {
      if (!refs.has(key)) refs.set(key, ref)
    }
  }
  for (const token of blocks) {
    if (token.kind === 'link_ref_def') {
      merge(parseLinkReferenceDefinitions(source.slice(token.start, token.end)))
    } else if (token.kind === 'blockquote') {
      const inner = source
        .slice(token.start, token.end)
        .split('\n')
        .map((line) => stripBlockquoteMarker(line.trim()))
        .join('\n')
      merge(collectLinkReferenceDefinitions(inner))
    }
  }
  return refs
}

/** Index of the first character that must stay in the pending region. */
export function streamingHoldStart(blocks: BlockToken[]): number {
  let commitEnd = 0
  for (const block of blocks) {
    if (block.status !== 'complete') return block.start
    commitEnd = block.end
  }
  return commitEnd
}

/**
 * True when `complete` ends inside a GFM table that may still receive body rows.
 * Pass `tokens` (the result of `tokenizeBlocks(complete)`) to reuse an existing
 * tokenization instead of re-scanning the string (streaming hot path, #21).
 */
export function completeEndsInOpenTable(complete: string, tokens?: BlockToken[]): boolean {
  const blocks = tokens ?? tokenizeBlocks(complete)
  const last = blocks.at(-1)
  return last?.kind === 'table' && last.status === 'complete'
}

export function pendingLineBelongsInTable(
  complete: string,
  pending: string,
  completeTokens?: BlockToken[],
): boolean {
  return pending.includes('|') && completeEndsInOpenTable(complete, completeTokens)
}

/**
 * Source slice for a table block that is not yet `complete` (forming or open body).
 * Pass `tokens` (`tokenizeBlocks(content)`) to reuse an existing tokenization (#21).
 */
export function getIncompleteTableSource(content: string, tokens?: BlockToken[]): string | null {
  const blocks = tokens ?? tokenizeBlocks(content)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind === 'table' && block.status !== 'complete') {
      return content.slice(block.start, block.end)
    }
  }
  return null
}

/**
 * Source slice for a fenced code block that is not yet `complete`.
 * Pass `tokens` (`tokenizeBlocks(content)`) to reuse an existing tokenization (#21).
 */
export function getIncompleteFenceSource(content: string, tokens?: BlockToken[]): string | null {
  const blocks = tokens ?? tokenizeBlocks(content)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind === 'fence' && block.status !== 'complete') {
      return content.slice(block.start, block.end)
    }
  }
  return null
}

/** Split a GFM table row into cell strings (leading/trailing pipes optional). */
/** GFM table column alignment from the delimiter row's `:` markers. */
export type TableAlign = 'left' | 'right' | 'center' | null

/**
 * Split a GFM table row into trimmed cell strings. Splits on unescaped `|` only
 * — a backslash-escaped pipe (`\|`) is literal cell text, and its escaping
 * backslash is removed so inline parsing sees a bare `|` (spec 200) — and drops
 * the empty cells produced by an optional leading/trailing pipe.
 */
export function splitTableRow(line: string): string[] {
  const s = line.trim()
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && (s[i + 1] === '|' || s[i + 1] === '\\')) {
      // `\|` → literal pipe (drop the backslash); `\\` stays an escaped backslash
      // for inline parsing. Either way the next char can't be a delimiter.
      cur += s[i + 1] === '|' ? '|' : '\\\\'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  if (cells.length > 1 && cells[0]!.trim() === '' && s.startsWith('|')) cells.shift()
  if (cells.length > 1 && cells.at(-1)!.trim() === '' && s.endsWith('|')) cells.pop()
  return cells.map((c) => c.trim())
}

/**
 * Per-column alignment for a GFM table, parsed from its delimiter row
 * (`:--` left, `--:` right, `:-:` center, `---` none).
 */
export function parseTableAlignments(sepLine: string): TableAlign[] {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Whether the pending tail should stay escaped plain text (block not yet safe). */
export function isAmbiguousBlockLine(line: string): boolean {
  const trimmed = line.trimStart()
  if (trimmed === '') return false
  if (/^ {4}/.test(line)) return true
  if (ATX_HEADING_RE.test(line)) return true
  if (THEMATIC_BREAK_RE.test(line)) return true
  if (FENCE_OPEN_RE.test(line)) return true
  if (LIST_ITEM_RE.test(line)) return true
  if (BLOCKQUOTE_RE.test(line)) return true
  if (isGfmTableRowLine(line)) return true
  return false
}
