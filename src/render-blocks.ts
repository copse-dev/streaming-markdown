import { alertBlockquoteClass, alertTitle, alertTypeFromMarker } from './alerts.ts'
import {
  ATX_HEADING_CAPTURE_RE as ATX_HEADING_RE,
  BLOCKQUOTE_DETECT_RE,
  dropTrailingNewline,
  expandLeadingTabs,
  expandListPrefixTabs,
  parseFenceSlice,
  stripAtxClosingHashes,
  stripBlockquoteMarker,
  stripFourColumnIndent,
} from './block-patterns.ts'
import {
  type BlockToken,
  isAmbiguousBlockLine,
  listItemContentColumn,
  orderedListMarkerDelimiter,
  parseOrderedListMarker,
  parseTableAlignments,
  splitTableRow,
  type TableAlign,
  TABLE_SEP_RE,
  tokenizeBlocks,
  unorderedListMarkerChar,
} from './block-tokenizer.ts'
import { escapeHtml } from './escape.ts'
import { getFenceHandler } from './fence-handlers.ts'
import { type FootnoteContext } from './footnotes.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { dedentBlock, isIndentedHtmlBlock } from './indented-html.ts'
import { type LinkReferenceMap } from './link-references.ts'
import { mathBlockHtml, parseMathBlockSlice } from './math-block.ts'
import { renderProseBlock } from './render-prose-inline.ts'

export interface RenderBlocksOptions {
  linkRefs?: LinkReferenceMap
  /** Tight list items render top-level paragraphs bare (no <p>, space soft breaks). */
  tightParagraphs?: boolean
  /**
   * Reclassify top-level `indented_code` blocks that are really raw HTML as prose
   * (#616). Only the top-level `renderMarkdown` entry sets this; recursive
   * list/blockquote rendering leaves nested indented code as CommonMark code.
   */
  htmlFromIndent?: boolean
  /**
   * Recognize `indented_code` blocks as code (default `true`). When `false`, the
   * top-level `renderMarkdown` opt-out renders them as prose paragraphs instead —
   * an intentional CommonMark divergence (#9). Not threaded into recursive
   * list/blockquote rendering, which keeps indented code semantics.
   */
  indentedCode?: boolean
}


function renderFencedBlock(lang: string, code: string): string {
  const handler = getFenceHandler(lang)
  if (handler) return handler.render(code, lang)
  const body = highlightFenceCode(code, lang)
  return `<pre><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

function renderIndentedCode(slice: string): string {
  const lines = dropTrailingNewline(slice).split('\n')
  while (lines.length && (lines.at(-1) ?? '').trim() === '') lines.pop()
  const code = lines.map((l) => stripFourColumnIndent(l)).join('\n')
  if (code.trim() === '') return ''
  return `<pre><code>${escapeHtml(code)}\n</code></pre>`
}

/** Strip up to three leading spaces per line (CommonMark paragraph normalization). */
function stripParagraphIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^ {0,3}(?=\S)/, ''))
    .join('\n')
}

// One shared marker stripper (block-patterns) keeps the tokenizer's laziness
// checks and the renderer's unwrapping byte-identical, tab handling included.
const stripBlockquoteLine = stripBlockquoteMarker

/** A GFM task-list checkbox at the very start of an item's content (#614). */
const TASK_LIST_MARKER_RE = /^\[([ xX])\](?=\s|$)/

interface TaskListMarker {
  checked: boolean
  /** Item content with the `[ ]`/`[x]` marker (and one following space) removed. */
  rest: string
}

/** Match a leading task-list checkbox on the first content line of an item. */
function parseTaskListMarker(inner: string): TaskListMarker | null {
  const m = TASK_LIST_MARKER_RE.exec(inner)
  if (!m) return null
  const checked = (m[1] ?? '') !== ' '
  let rest = inner.slice(m[0].length)
  // Drop a single separating space so `[ ] foo` → `foo`; keep further indent.
  if (rest.startsWith(' ')) rest = rest.slice(1)
  return { checked, rest }
}

function taskCheckboxHtml(checked: boolean): string {
  return `<input type="checkbox" disabled${checked ? ' checked' : ''}>`
}

interface RenderedListItem {
  html: string
  task: TaskListMarker | null
}

/** Item content with the marker/indent columns removed (lazy lines merged). */
function dedentListItemContent(slice: string): string {
  const lines = dropTrailingNewline(slice).split('\n')
  const first = lines.find((l) => l.trim() !== '') ?? ''
  const col = listItemContentColumn(first)
  const dedented: string[] = []
  lines.forEach((rawLine, index) => {
    // Tabs in the marker prefix / leading whitespace expand at absolute
    // 4-column stops (spec 4/5/7/9), so slicing by column offset is exact.
    const line = index === 0 ? expandListPrefixTabs(rawLine) : expandLeadingTabs(rawLine)
    if (index === 0) {
      dedented.push(line.slice(Math.min(col, line.length)))
      return
    }
    const indent = line.match(/^ */)?.[0].length ?? 0
    if (indent >= col) {
      dedented.push(line.slice(col))
      return
    }
    const stripped = line.slice(indent)
    const prev = dedented.at(-1)
    // A lazy (under-indented) continuation can only extend the open paragraph;
    // it can never open a new block inside the item (CommonMark #312).
    if (
      stripped.trim() !== '' &&
      prev !== undefined &&
      prev.trim() !== '' &&
      isAmbiguousBlockLine(stripped)
    ) {
      dedented[dedented.length - 1] = `${prev} ${stripped}`
      return
    }
    dedented.push(stripped)
  })
  return dedented.join('\n')
}

function renderListItemContent(
  slice: string,
  listLoose: boolean,
  linkRefs: LinkReferenceMap,
): RenderedListItem {
  let inner = dedentListItemContent(slice)
  if (inner.trim() === '') return { html: '', task: null }
  // A checkbox marker only counts on the item's first content line; strip it
  // before recursive tokenization so the box never lands inside prose.
  const task = parseTaskListMarker(inner)
  if (task) inner = task.rest
  // Item content is a block fragment in its own right: recursive tokenization
  // handles nested lists, fences, blockquotes, and indented code (#595).
  const html = renderBlocks(inner, tokenizeBlocks(inner), {
    linkRefs,
    tightParagraphs: !listLoose,
  })
  return { html, task }
}

/** Wrap rendered item content in an `<li>`, prepending a checkbox for task items. */
function renderListItem(item: RenderedListItem): string {
  if (item.task) {
    const box = taskCheckboxHtml(item.task.checked)
    const gap = item.html === '' ? '' : ' '
    return `<li class="task-list-item">${box}${gap}${item.html}</li>`
  }
  return `<li>${item.html}</li>`
}

function renderParagraph(slice: string, linkRefs: LinkReferenceMap, tight = false): string {
  const body = stripParagraphIndent(dropTrailingNewline(slice))
  const rendered = renderProseBlock(body, linkRefs, tight ? 'space' : 'newline')
  if (rendered === '') return ''
  return tight ? rendered : `<p>${rendered}</p>`
}

function renderAtxHeading(slice: string, linkRefs: LinkReferenceMap): string {
  const line = dropTrailingNewline(slice).split('\n')[0] ?? ''
  const m = line.match(ATX_HEADING_RE)
  if (!m?.[1]) return renderParagraph(slice, linkRefs)
  const level = m[1].length
  const text = stripAtxClosingHashes((m[2] ?? '').trimEnd())
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`
}

// A setext underline slice (only `=` or `-` runs). Mirrors the tokenizer's
// `SETEXT_UNDERLINE_RE`, tolerating a trailing newline on the slice. A `***`
// thematic break never matches, so it keeps rendering as an `<hr>` (#105).
const SETEXT_UNDERLINE_SLICE_RE = /^ {0,3}(?:=+|-+)[ \t]*\n?$/

function renderSetextHeading(slice: string, linkRefs: LinkReferenceMap): string {
  const lines = dropTrailingNewline(slice).split('\n')
  // All lines above the underline are heading content (spec 81/95).
  const text = lines
    .slice(0, -1)
    .map((l) => l.trim())
    .join('\n')
  const underline = lines.at(-1) ?? ''
  const level = underline.trim().startsWith('=') ? 1 : 2
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`
}

function alignAttr(align: TableAlign): string {
  return align ? ` align="${align}"` : ''
}

function renderTable(slice: string, linkRefs: LinkReferenceMap): string {
  const lines = dropTrailingNewline(slice)
    .split('\n')
    .filter((l) => l.trim() !== '')
  const header = lines[0]
  if (!header) return ''
  const headerCells = splitTableRow(header)
  const colCount = headerCells.length
  const aligns = lines[1] ? parseTableAlignments(lines[1]) : []
  const alignOf = (col: number): TableAlign => aligns[col] ?? null

  const thead = `<thead><tr>${headerCells
    .map((c, col) => `<th${alignAttr(alignOf(col))}>${renderProseBlock(c, linkRefs)}</th>`)
    .join('')}</tr></thead>`

  // GFM: body rows are padded with empty cells / truncated to the header's
  // column count (spec 204); a header-only table emits no <tbody> (spec 205).
  const bodyRows = lines.slice(2)
  if (bodyRows.length === 0) return `<table>${thead}</table>`
  const tbody = `<tbody>${bodyRows
    .map((row) => {
      const cells = splitTableRow(row)
      const normalized = Array.from({ length: colCount }, (_unused, col) => cells[col] ?? '')
      return `<tr>${normalized
        .map((c, col) => `<td${alignAttr(alignOf(col))}>${renderProseBlock(c, linkRefs)}</td>`)
        .join('')}</tr>`
    })
    .join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

function stripBlockquoteSource(slice: string): string {
  // Lazy (unmarked) continuation lines are paragraph TEXT: merge them into
  // the previous line so the recursive parse cannot reinterpret them as a
  // block start — `    - bar` stays prose (spec 238) and a lazy `===` cannot
  // underline a setext heading (spec 93).
  const out: string[] = []
  for (const line of slice.split('\n')) {
    if (BLOCKQUOTE_DETECT_RE.test(line)) {
      out.push(stripBlockquoteLine(line))
      continue
    }
    const prev = out.at(-1)
    if (line.trim() !== '' && prev !== undefined && prev.trim() !== '') {
      out[out.length - 1] = `${prev} ${line.trim()}`
      continue
    }
    out.push(line)
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * Body of an alert blockquote: `innerSource` minus its leading `[!TYPE]`
 * marker. A lazy continuation merged into the marker line by
 * {@link stripBlockquoteSource} stays as the first content line (the SOURCE
 * marker line was still exactly the marker, so the quote classifies).
 */
function stripAlertMarker(innerSource: string): string {
  const nl = innerSource.indexOf('\n')
  const first = nl === -1 ? innerSource : innerSource.slice(0, nl)
  const rest = nl === -1 ? '' : innerSource.slice(nl + 1)
  const afterMarker = first.trimStart().replace(/^\[![A-Za-z]+\]/, '').trimStart()
  if (afterMarker === '') return rest
  return rest === '' ? afterMarker : `${afterMarker}\n${rest}`
}

function renderBlockquote(slice: string, linkRefs: LinkReferenceMap): string {
  // GitHub alerts (#72): a quote whose first SOURCE line is exactly `[!NOTE]`
  // (or tip/important/warning/caution) renders with alert classes and a title
  // paragraph; the marker line itself never renders as content.
  const firstLine = slice.split('\n')[0] ?? ''
  const alertType = alertTypeFromMarker(stripBlockquoteMarker(firstLine))
  const innerSource = stripBlockquoteSource(slice)
  if (alertType) {
    const body = stripAlertMarker(innerSource)
    const title = `<p class="markdown-alert-title">${alertTitle(alertType)}</p>`
    const content = body.trim() === '' ? '' : `\n${renderBlocksFromSource(body, linkRefs)}`
    return `<blockquote class="${alertBlockquoteClass(alertType)}">${title}${content}</blockquote>`
  }
  // A quote with no content still renders (`>` alone, spec 239/240).
  if (innerSource.trim() === '') return '<blockquote></blockquote>'
  return `<blockquote>${renderBlocksFromSource(innerSource, linkRefs)}</blockquote>`
}

function isOrderedListSlice(slice: string): boolean {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return parseOrderedListMarker(first) !== null
}

function sliceUnorderedMarkerChar(slice: string): '-' | '*' | '+' | null {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return unorderedListMarkerChar(first)
}

function orderedListStart(slice: string): number {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return parseOrderedListMarker(first) ?? 1
}

function orderedListDelimiter(slice: string): '.' | ')' | null {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return orderedListMarkerDelimiter(first)
}

/**
 * Identity of a top-level list group, fixed by its first item. Two adjacent
 * items belong to the same rendered `<ul>`/`<ol>` iff their signatures agree
 * (same ordered-ness, same marker char or delimiter). Exported for the
 * streaming frozen/tail path (#29), which freezes settled items of a still-open
 * trailing list and must group items exactly the way rendering does.
 */
export interface ListGroupSignature {
  ordered: boolean
  markerChar: '-' | '*' | '+' | null
  delimiter: '.' | ')' | null
  /** Ordered-list start number (1 for unordered). */
  start: number
}

/** Signature of the list group opened by `firstSlice` (its first item). */
export function listGroupSignature(firstSlice: string): ListGroupSignature {
  const ordered = isOrderedListSlice(firstSlice)
  return {
    ordered,
    markerChar: ordered ? null : sliceUnorderedMarkerChar(firstSlice),
    delimiter: ordered ? orderedListDelimiter(firstSlice) : null,
    start: ordered ? orderedListStart(firstSlice) : 1,
  }
}

/** Whether an item slice continues the group identified by `sig`. */
export function listSliceContinuesGroup(sig: ListGroupSignature, slice: string): boolean {
  if (isOrderedListSlice(slice) !== sig.ordered) return false
  if (sig.ordered) return orderedListDelimiter(slice) === sig.delimiter
  return sliceUnorderedMarkerChar(slice) === sig.markerChar
}

/**
 * Loose evidence carried by one item slice: the item DIRECTLY contains two
 * block-level elements with a blank line between them (CommonMark looseness).
 * Blank lines inside a nested construct — a fenced block or a deeper list,
 * which tokenize as a single token — do not count (spec 307/318/319).
 */
export function listItemSliceIsMultiParagraph(slice: string): boolean {
  const tokens = tokenizeBlocks(dedentListItemContent(slice))
  let seenBlock = false
  let blankSince = false
  for (const token of tokens) {
    if (token.kind === 'blank') {
      if (seenBlock) blankSince = true
      continue
    }
    if (seenBlock && blankSince) return true
    seenBlock = true
  }
  return false
}

/**
 * The `list_item` tokens of one top-level list group, plus the group facts
 * rendering needs: the signature, whether the group renders loose, and the
 * token index just past the group.
 */
export interface ListGroupScan {
  sig: ListGroupSignature
  itemTokens: BlockToken[]
  loose: boolean
  /** Token index of the first token NOT in the group. */
  next: number
}

/**
 * Walk the list group starting at `tokens[start]` (must be a `list_item`).
 * Single source of truth for group membership and looseness — rendering
 * (`collectListGroup`) and streaming intra-list freezing (#29) both use it.
 */
export function scanListGroup(source: string, tokens: BlockToken[], start: number): ListGroupScan {
  const firstToken = tokens[start]
  const firstSlice = firstToken ? source.slice(firstToken.start, firstToken.end) : ''
  const sig = listGroupSignature(firstSlice)
  const itemTokens: BlockToken[] = []
  let loose = false
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      // Skip any run of blank lines; the list continues if the next non-blank
      // token is a same-type list item, even across multiple blanks (#306).
      let k = i + 1
      while (tokens[k]?.kind === 'blank') k++
      const next = tokens[k]
      if (next?.kind === 'list_item' && listSliceContinuesGroup(sig, source.slice(next.start, next.end))) {
        loose = true
        i = k
        continue
      }
      break
    }
    if (token.kind !== 'list_item') break
    const slice = source.slice(token.start, token.end)
    if (!listSliceContinuesGroup(sig, slice)) break
    if (listItemSliceIsMultiParagraph(slice)) loose = true
    // Blank lines swallowed into an item's tail still separate it from the
    // NEXT item (spec 311/313); a trailing blank on the group's last item
    // does not count.
    if (/\n[ \t]*\n$/.test(slice)) {
      const after = tokens[i + 1]
      if (
        after?.kind === 'list_item' &&
        listSliceContinuesGroup(sig, source.slice(after.start, after.end))
      ) {
        loose = true
      }
    }
    itemTokens.push(token)
    i++
  }
  return { sig, itemTokens, loose, next: i }
}

export interface RenderedListSlice {
  /** Concatenated `<li>…</li>` HTML — no separators between items. */
  itemsHtml: string
  /** Whether any item in the slice is a task-list item (drives the `<ul>` class). */
  anyTask: boolean
}

/**
 * Render a contiguous slice of a list group's items with a FIXED looseness.
 * Byte-identical to the corresponding items of a whole-group render with the
 * same `loose` — the property the streaming frozen/tail path relies on (#29).
 */
export function renderListItemsSlice(
  source: string,
  itemTokens: BlockToken[],
  loose: boolean,
  linkRefs: LinkReferenceMap,
): RenderedListSlice {
  const items = itemTokens.map((t) =>
    renderListItemContent(source.slice(t.start, t.end), loose, linkRefs),
  )
  return {
    itemsHtml: items.map(renderListItem).join(''),
    anyTask: items.some((it) => it.task !== null),
  }
}

/** The exact open tag a whole-group render would emit for this group. */
export function listGroupOpenTag(sig: ListGroupSignature, anyTask: boolean): string {
  if (sig.ordered) {
    return `<ol${sig.start === 1 ? '' : ` start="${String(sig.start)}"`}>`
  }
  // GitHub flags lists that hold checkboxes so their bullets can be hidden.
  return `<ul${anyTask ? ' class="contains-task-list"' : ''}>`
}

export function listGroupCloseTag(sig: ListGroupSignature): string {
  return sig.ordered ? '</ol>' : '</ul>'
}

function collectListGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
  linkRefs: LinkReferenceMap,
): { html: string; next: number } {
  const scan = scanListGroup(source, tokens, start)
  const { itemsHtml, anyTask } = renderListItemsSlice(source, scan.itemTokens, scan.loose, linkRefs)
  return {
    html: `${listGroupOpenTag(scan.sig, anyTask)}${itemsHtml}${listGroupCloseTag(scan.sig)}`,
    next: scan.next,
  }
}

function collectBlockquoteGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
  linkRefs: LinkReferenceMap,
): { html: string; next: number } {
  // A blank line ends a blockquote (spec 242/252), and the tokenizer never
  // emits two directly-adjacent blockquote tokens, so a group is one token.
  const token = tokens[start]
  if (!token || token.kind !== 'blockquote') return { html: '', next: start + 1 }
  return {
    html: renderBlockquote(source.slice(token.start, token.end), linkRefs),
    next: start + 1,
  }
}

function renderSingleBlock(
  source: string,
  token: BlockToken,
  linkRefs: LinkReferenceMap,
  tightParagraphs: boolean,
  htmlFromIndent: boolean,
  indentedCode: boolean,
): string {
  const slice = source.slice(token.start, token.end)
  switch (token.kind) {
    case 'indented_code':
      // Opt-out (#9): render indented lines as prose instead of a code block.
      if (!indentedCode) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false)
      }
      // A top-level indented block that is really raw HTML follows the raw-HTML
      // policy (escaped/benign prose), not a <pre><code> dump (#616).
      if (htmlFromIndent && isIndentedHtmlBlock(dropTrailingNewline(slice))) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false)
      }
      return renderIndentedCode(slice)
    case 'fence': {
      const { lang, code } = parseFenceSlice(slice)
      return renderFencedBlock(lang, code)
    }
    // Display math (#70): `$$ … $$` / `\[ … \]` emits the same inert pending
    // scaffolding as a ```math fence; `hydratePendingMath` upgrades it after
    // the sink sanitizer (the mermaid two-phase shape).
    case 'math_block':
      return mathBlockHtml(parseMathBlockSlice(slice).trim())
    case 'atx_heading':
      return renderAtxHeading(slice, linkRefs)
    case 'setext_heading':
      return renderSetextHeading(slice, linkRefs)
    case 'thematic_break':
      return '<hr>'
    case 'table':
      return renderTable(slice, linkRefs)
    /* c8 ignore start -- unreachable in practice: renderBlocks routes
       blockquote / list_item groups and skips blank / link_ref_def tokens before
       ever calling renderSingleBlock, and every BlockToken kind is enumerated
       above, so `default` never runs. Kept so the dispatch is total. */
    case 'blockquote':
      return renderBlockquote(slice, linkRefs)
    case 'list_item':
      return renderListItem(renderListItemContent(slice, false, linkRefs))
    case 'link_ref_def':
    case 'footnote_def':
    case 'blank':
      return ''
    /* c8 ignore stop */
    case 'paragraph':
      return renderParagraph(slice, linkRefs, tightParagraphs)
    /* c8 ignore next 2 -- unreachable: all kinds are enumerated above */
    default:
      return renderParagraph(slice, linkRefs, tightParagraphs)
  }
}

/**
 * One rendered top-level block (or grouped block run) with the source range it
 * covers. `start`/`end` are source offsets of the first/last token in the unit,
 * so a caller can map a rendered node back to its source slice (#110 footnote
 * incremental rendering: detect which committed blocks a new footnote definition
 * actually changed). Blank / link-ref / footnote-def tokens render nothing and
 * are absorbed into the following unit rather than emitted as their own part.
 */
export interface RenderedPart {
  start: number
  end: number
  html: string
}

/**
 * Like {@link renderBlocks} but returns each non-empty top-level unit separately
 * (#110). `renderBlocks` is exactly the parts' `html` joined with '\n', so the
 * concatenation is byte-identical; the per-unit split lets the streaming
 * footnote path re-render and re-morph only the blocks whose footnote-reference
 * numbering changed instead of the whole committed prefix.
 */
export function renderBlocksToParts(
  source: string,
  tokens: BlockToken[],
  options: RenderBlocksOptions = {},
): RenderedPart[] {
  const linkRefs = options.linkRefs ?? new Map()
  const tightParagraphs = options.tightParagraphs ?? false
  const htmlFromIndent = options.htmlFromIndent ?? false
  const indentedCode = options.indentedCode ?? true
  const parts: RenderedPart[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank' || token.kind === 'link_ref_def' || token.kind === 'footnote_def') {
      // Footnote definitions never render in place — they render in the
      // trailing footnotes section (renderFootnoteSection, #72).
      i++
      continue
    }
    if (token.kind === 'list_item') {
      const group = collectListGroup(source, tokens, i, linkRefs)
      const end = tokens[group.next - 1]?.end ?? token.end
      if (group.html) parts.push({ start: token.start, end, html: group.html })
      i = group.next
      continue
    }
    if (token.kind === 'blockquote') {
      const group = collectBlockquoteGroup(source, tokens, i, linkRefs)
      const end = tokens[group.next - 1]?.end ?? token.end
      if (group.html) parts.push({ start: token.start, end, html: group.html })
      i = group.next
      continue
    }
    // At rest, a paragraph immediately followed by an unterminated setext
    // underline (`Heading\n===` at EOF) is a heading, not `<p>` + `<hr>` (#105).
    // The tokenizer emits `thematic_break:ambiguous` for that underline as a
    // streaming compromise — the pending underline is held out of the committed
    // region, so this adjacency only ever surfaces when the whole document is
    // rendered at rest. Resolve it to the setext heading its terminated form
    // would produce; a `=` underline must never invent an `<hr>`.
    const underline = tokens[i + 1]
    if (
      token.kind === 'paragraph' &&
      underline &&
      underline.kind === 'thematic_break' &&
      underline.status === 'ambiguous' &&
      SETEXT_UNDERLINE_SLICE_RE.test(source.slice(underline.start, underline.end))
    ) {
      parts.push(renderSetextHeading(source.slice(token.start, underline.end), linkRefs))
      i += 2
      continue
    }
    const html = renderSingleBlock(
      source,
      token,
      linkRefs,
      tightParagraphs,
      htmlFromIndent,
      indentedCode,
    )
    if (html) parts.push({ start: token.start, end: token.end, html })
    i++
  }
  return parts
}

/** Render tokenized block-level markdown to HTML (#475 phase 2). */
export function renderBlocks(
  source: string,
  tokens: BlockToken[],
  options: RenderBlocksOptions = {},
): string {
  const parts = renderBlocksToParts(source, tokens, options)
  const htmls = new Array<string>(parts.length)
  for (let i = 0; i < parts.length; i++) htmls[i] = parts[i]?.html ?? ''
  return htmls.join('\n')
}

/** Tokenize and render a markdown fragment (used for blockquote recursion). */
export function renderBlocksFromSource(
  source: string,
  linkRefs: LinkReferenceMap = new Map(),
): string {
  return renderBlocks(source, tokenizeBlocks(source), { linkRefs })
}

/** Splice the backref link into a definition's last paragraph (GitHub shape). */
function appendFootnoteBackref(bodyHtml: string, backref: string): string {
  if (bodyHtml === '') return `<p>${backref}</p>`
  if (bodyHtml.endsWith('</p>')) {
    return `${bodyHtml.slice(0, -'</p>'.length)} ${backref}</p>`
  }
  return `${bodyHtml}\n<p>${backref}</p>`
}

/**
 * The trailing footnotes section (#72): referenced definitions in first-use
 * order, each ending with a backref to the reference site. Definitions never
 * referenced are dropped (GitHub behavior). Content renders through the normal
 * block pipeline WHILE the context is still active, so references inside a
 * footnote's own content resolve too (the `order` walk picks up labels first
 * used there).
 */
export function renderFootnoteSection(ctx: FootnoteContext, linkRefs: LinkReferenceMap): string {
  const items = renderFootnoteSectionItems(ctx, linkRefs)
  if (items.length === 0) return ''
  return `<section class="footnotes"><ol>${items.join('')}</ol></section>`
}

/**
 * The per-`<li>` HTML of the footnotes section, in first-use order (#110). Split
 * out so the streaming footnote path can freeze settled items and re-morph only
 * the growing tail of the `<ol>` instead of re-parsing the whole section each
 * commit. An item's HTML is a pure function of its definition content and its
 * first reference id — both fixed once committed — so a settled item is stable.
 */
export function renderFootnoteSectionItems(
  ctx: FootnoteContext,
  linkRefs: LinkReferenceMap,
): string[] {
  const items: string[] = []
  // `ctx.order` may grow while items render (a footnote referencing another
  // footnote first used inside the section) — iterate by index, not snapshot.
  for (let i = 0; i < ctx.order.length; i++) {
    const key = ctx.order[i]
    const def = key === undefined ? undefined : ctx.defs.get(key)
    const slug = key === undefined ? undefined : ctx.slugs.get(key)
    const refId = key === undefined ? undefined : ctx.firstRefIds.get(key)
    /* c8 ignore next -- unreachable: order entries are only pushed with a
       matching def, slug, and first ref id (footnoteRefHtml). Defensive guard. */
    if (def === undefined || slug === undefined || refId === undefined) continue
    const body = renderBlocksFromSource(def.content, linkRefs)
    const backref = `<a href="#${refId}" class="footnote-backref">↩</a>`
    items.push(`<li id="fn-${slug}">${appendFootnoteBackref(body, backref)}</li>`)
  }
  return items
}

/** Whether a line is a GFM table separator (exported for tests that need it). */
export function isTableSeparatorLine(line: string): boolean {
  return TABLE_SEP_RE.test(line)
}
