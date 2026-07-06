import { renderMarkdown } from './renderer.ts'
import { alertBlockquoteClass, pendingBlockquoteAlertType } from './alerts.ts'
import {
  getIncompleteFenceSource,
  getIncompleteMathSource,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  pendingLineBelongsInTable,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import {
  isListContinuationPending,
  isPendingBlockquoteLine,
  listPendingIndent,
  pendingAtxHeadingLevel,
  pendingListMarkerLength,
  pendingListOrderedMarker,
  renderPendingLine,
} from './render-pending-line.ts'
import { splitForStreaming, splitForStreamingFrom, type StreamingSplit } from './streaming-split.ts'
import { IncrementalSourceScanner } from './incremental-scan.ts'
export type { StreamingSplitWithTokens } from './streaming-split.ts'
import { escapeHtml } from './escape.ts'
import { asSanitizedHtml, sanitizeRenderedMarkdown, type SanitizedHtml } from './sanitize.ts'
import { setPresanitizedHtml } from './html-sink.ts'
import {
  appendPendingTableRowHtml,
  buildFormingTableHtml,
  clearFormingTableDom,
  removePendingTableRow,
  syncFormingTableDom,
  syncPendingTableRowDom,
} from './streaming-table-dom.ts'
import {
  buildFormingFenceHtml,
  clearFormingFenceDom,
  syncFormingFenceDom,
} from './streaming-fence-dom.ts'
import { buildFormingMathHtml, syncFormingMathDom } from './streaming-math-dom.ts'
import { FrozenTailRenderer } from './streaming-frozen-tail.ts'

export { pendingHoldIndex } from './inline-emphasis.ts'
export { splitAtLastNewline, splitForStreaming } from './streaming-split.ts'
export type { StreamingSplit } from './streaming-split.ts'
export {
  completeEndsInOpenTable,
  getIncompleteFenceSource,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  isPotentialTableStart,
  pendingLineBelongsInTable,
  splitTableRow,
  tokenizeBlocks,
} from './block-tokenizer.ts'

const BLOCK_PENDING_CLASS = 'stream-pending-block'
const LIST_CONTINUATION_CLASS = 'stream-pending-list-continuation'
const PARAGRAPH_CONTINUATION_CLASS = 'stream-pending-paragraph-continuation'
const TRAILING_OPEN_LI_CLOSE_RE = /(<li(?:\s[^>]*)?>)([\s\S]*?)(<\/li>\s*<\/(?:ul|ol)>)\s*$/

// Pending tail elements always live at the very end of `stream-complete`: a
// pending block is appended as the last direct child, and a pending list item /
// continuation span lives inside the trailing list (the last element child).
// Every clear runs *before* the next pending element is appended, so the target
// is always within the last element child at query time. Scoping the pending
// queries there instead of `querySelector`-ing the whole committed subtree turns
// an O(prefix)-per-frame DOM scan into O(tail) — the dominant residual cost of a
// long stream once the committed prefix is frozen (#21 follow-up). jsdom's
// `:scope >`/descendant selectors still walk the full subtree, so this matters.

/** A pending descendant (continuation span, pending `<li>`) inside the trailing list. */
function tailPendingDescendant(completedEl: HTMLElement, selector: string): Element | null {
  return completedEl.lastElementChild?.querySelector(selector) ?? null
}

/** A pending block element attached directly to `completedEl` (always the last child). */
function tailDirectPendingBlock(completedEl: HTMLElement, excludeLi: boolean): Element | null {
  const last = completedEl.lastElementChild
  if (!last || !last.classList.contains(BLOCK_PENDING_CLASS)) return null
  if (excludeLi && last.tagName === 'LI') return null
  return last
}

function insertBeforeTrailingListClose(rendered: string, insertHtml: string): string | null {
  const liClose = rendered.match(TRAILING_OPEN_LI_CLOSE_RE)?.[3]
  if (!liClose) return null
  return `${rendered.slice(0, -liClose.length)}${insertHtml}${liClose}`
}

type BlockPendingCleanup =
  | 'continuation'
  | 'paragraph-continuation'
  | 'list-items'
  | 'direct-blocks'
  | 'non-list-direct'

function clearBlockPendingDom(completedEl: HTMLElement, parts: BlockPendingCleanup[]): void {
  if (parts.includes('continuation')) clearListContinuationDom(completedEl)
  if (parts.includes('paragraph-continuation')) clearParagraphContinuationDom(completedEl)
  if (parts.includes('list-items')) {
    tailPendingDescendant(completedEl, `li.${BLOCK_PENDING_CLASS}`)?.remove()
  }
  if (parts.includes('direct-blocks')) {
    tailDirectPendingBlock(completedEl, false)?.remove()
  }
  if (parts.includes('non-list-direct')) {
    tailDirectPendingBlock(completedEl, true)?.remove()
  }
}

function renderPendingInlineMarkdown(pending: string, openListItemFirstLine?: string): string {
  if (openListItemFirstLine === undefined) return renderPendingLine(pending)
  return renderPendingLine(pending, { openListItemFirstLine })
}

/** Block-level pending tail (open paragraph or list line) — rendered inside stream-complete. */
export function isBlockLevelPending(pending: string, openListItemFirstLine?: string): boolean {
  if (!pending.trim() || pending.includes('\n')) return false
  if (pendingListMarkerLength(pending) !== null) return true
  if (pendingAtxHeadingLevel(pending) !== null) return true
  if (isPendingBlockquoteLine(pending)) return true
  if (isListContinuationPending(pending, openListItemFirstLine)) return true
  return !isAmbiguousBlockLine(pending)
}

function blockPendingTag(
  pending: string,
  openListItemFirstLine?: string,
): 'p' | 'div' | 'span' | 'blockquote' | 'li' {
  if (isListContinuationPending(pending, openListItemFirstLine)) return 'span'
  if (pendingListMarkerLength(pending) !== null) return 'li'
  if (pendingAtxHeadingLevel(pending) !== null) return 'div'
  if (isPendingBlockquoteLine(pending)) return 'blockquote'
  return 'p'
}

function pendingListTag(pending: string): 'ul' | 'ol' {
  return pendingListOrderedMarker(pending) !== null ? 'ol' : 'ul'
}

function blockPendingLiHtml(
  pending: string,
  pendingInner: SanitizedHtml | '',
  openListItemFirstLine?: string,
): string {
  const inner = wrapBlockPendingInner(pending, pendingInner)
  return `<li class="${blockPendingClassName(pending, openListItemFirstLine)}"${blockPendingAttrs(pending)}>${inner}</li>`
}

function appendListPendingHtml(
  rendered: string,
  pending: string,
  pendingInner: SanitizedHtml | '',
  openListItemFirstLine?: string,
): string {
  const listTag = pendingListTag(pending)
  const liHtml = blockPendingLiHtml(pending, pendingInner, openListItemFirstLine)
  const indent = listPendingIndent(pending)

  if (indent > 0) {
    const nested = insertBeforeTrailingListClose(rendered, `<${listTag}>${liHtml}</${listTag}>`)
    if (nested) return nested
  }

  // When the committed HTML ends with the trailing footnotes section (#72),
  // its own `</ol>` would be found by the lastIndexOf below and the pending
  // item would land inside the section — append a fresh list instead (the DOM
  // path's trailing-list lookup rejects the <section> the same way).
  if (!rendered.endsWith('</section>')) {
    const close = `</${listTag}>`
    const closeIndex = rendered.lastIndexOf(close)
    if (closeIndex !== -1) {
      const openNeedle = `<${listTag}`
      const beforeClose = rendered.slice(0, closeIndex)
      if (beforeClose.lastIndexOf(openNeedle) !== -1) {
        return `${beforeClose}${liHtml}${rendered.slice(closeIndex)}`
      }
    }
  }

  const ordered = pendingListOrderedMarker(pending)
  const startAttr = ordered !== null && listTag === 'ol' ? ` start="${escapeHtml(ordered)}"` : ''
  return `${rendered}<${listTag}${startAttr}>${liHtml}</${listTag}>`
}

function findTrailingListHost(completedEl: HTMLElement, listTag: 'ul' | 'ol'): HTMLElement | null {
  const last = completedEl.lastElementChild
  if (last instanceof Element && last.tagName === listTag.toUpperCase()) {
    return last as HTMLElement
  }
  return null
}

function syncListPendingDom(
  completedEl: HTMLElement,
  pending: string,
  pendingInner: SanitizedHtml | '',
  active: boolean,
  openListItemFirstLine?: string,
): void {
  clearBlockPendingDom(completedEl, ['continuation', 'paragraph-continuation', 'non-list-direct'])

  const listTag = pendingListTag(pending)
  const indent = listPendingIndent(pending)
  const existingPendingLi = tailPendingDescendant(completedEl, `li.${BLOCK_PENDING_CLASS}`)

  /* c8 ignore start -- unreachable defensive guard: the only caller (update)
     enters the block-pending path solely when `pendingVisible`, and
     renderPendingTail sets `pendingVisible` only when `pendingInner !== ''`;
     `active` is always passed `true`. Kept so this helper stays correct if ever
     driven directly. */
  if (!active || !pendingInner) {
    existingPendingLi?.remove()
    const last = completedEl.lastElementChild
    if (last && last.tagName === listTag.toUpperCase() && last.childNodes.length === 0) {
      last.remove()
    }
    return
  }
  /* c8 ignore stop */

  let list: HTMLElement | null = null
  if (indent > 0) {
    const hostLi = findOpenListItemHost(completedEl)
    if (hostLi) {
      const existingNested = hostLi.querySelector(`:scope > ${listTag}:last-of-type`)
      if (existingNested instanceof Element && existingNested.tagName === listTag.toUpperCase()) {
        list = existingNested as HTMLElement
      } else {
        list = document.createElement(listTag)
        hostLi.append(list)
      }
    }
    // No committed item to nest under (e.g. the previous block is a paragraph):
    // fall through to the trailing top-level list, which reuses the wrapper this
    // pending item created on an earlier frame instead of appending a fresh
    // empty list every frame.
  }
  if (!list) {
    const trailing = findTrailingListHost(completedEl, listTag)
    list =
      trailing ??
      ((): HTMLElement => {
        const created = document.createElement(listTag)
        const ordered = pendingListOrderedMarker(pending)
        if (ordered !== null && listTag === 'ol') created.setAttribute('start', ordered)
        completedEl.append(created)
        return created
      })()
  }

  let li: HTMLElement
  if (existingPendingLi instanceof HTMLElement && existingPendingLi.parentElement === list) {
    li = existingPendingLi
  } else {
    existingPendingLi?.remove()
    li = document.createElement('li')
    list.append(li)
  }

  li.className = blockPendingClassName(pending, openListItemFirstLine)
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (ordered !== null) li.setAttribute('data-ordered-marker', ordered)
  else li.removeAttribute('data-ordered-marker')
  if (headingLevel !== null) li.setAttribute('data-heading-level', String(headingLevel))
  else li.removeAttribute('data-heading-level')
  setPresanitizedHtml(li, wrapBlockPendingInner(pending, pendingInner))
}

function blockPendingClassName(pending: string, openListItemFirstLine?: string): string {
  if (isListContinuationPending(pending, openListItemFirstLine)) {
    return `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`
  }
  if (pendingListMarkerLength(pending) !== null) {
    const ordered = pendingListOrderedMarker(pending)
    return ordered
      ? `stream-pending stream-pending-list-item stream-pending-ordered-item ${BLOCK_PENDING_CLASS}`
      : `stream-pending stream-pending-list-item ${BLOCK_PENDING_CLASS}`
  }
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (headingLevel !== null) {
    return `stream-pending stream-pending-heading stream-pending-h${String(headingLevel)} ${BLOCK_PENDING_CLASS}`
  }
  if (isPendingBlockquoteLine(pending)) {
    // A complete `[!NOTE]` marker line classifies the pending quote as an alert
    // (#72) so promotion to the committed alert blockquote is class-stable.
    const alertType = pendingBlockquoteAlertType(pending)
    if (alertType) {
      return `stream-pending stream-pending-blockquote ${alertBlockquoteClass(alertType)} ${BLOCK_PENDING_CLASS}`
    }
    return `stream-pending stream-pending-blockquote ${BLOCK_PENDING_CLASS}`
  }
  return `stream-pending stream-pending-paragraph ${BLOCK_PENDING_CLASS}`
}

function blockPendingAttrs(pending: string): string {
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  let attrs = ''
  if (ordered) attrs += ` data-ordered-marker="${escapeHtml(ordered)}"`
  if (headingLevel !== null) attrs += ` data-heading-level="${String(headingLevel)}"`
  return attrs
}

function wrapBlockPendingInner(
  pending: string,
  pendingInner: SanitizedHtml | '',
): SanitizedHtml | '' {
  if (isPendingBlockquoteLine(pending)) {
    // Sanitized inner wrapped in a literal allowlisted <p> — sanitizer-equivalent.
    // An alert marker line's inner is its title text (#72), wrapped in the
    // committed render's title paragraph so promotion is class-only.
    if (pendingBlockquoteAlertType(pending) !== null) {
      return pendingInner ? asSanitizedHtml(`<p class="markdown-alert-title">${pendingInner}</p>`) : ''
    }
    return pendingInner ? asSanitizedHtml(`<p>${pendingInner}</p>`) : ''
  }
  return pendingInner
}

function blockPendingHtml(
  pending: string,
  pendingInner: SanitizedHtml | '',
  openListItemFirstLine?: string,
): string {
  const tag = blockPendingTag(pending, openListItemFirstLine)
  const innerRaw = wrapBlockPendingInner(pending, pendingInner)
  const inner =
    tag === 'span' && innerRaw !== '' && !innerRaw.startsWith(' ') ? ` ${innerRaw}` : innerRaw
  return `<${tag} class="${blockPendingClassName(pending, openListItemFirstLine)}"${blockPendingAttrs(pending)}>${inner}</${tag}>`
}

function inlinePendingSpanHtml(pendingInner: string): string {
  return `<span class="stream-pending">${pendingInner}</span>`
}

function findOpenListItemHost(completedEl: HTMLElement): HTMLElement | null {
  // The open list item that a pending line continues is the last item of the
  // trailing list; the callers clear any trailing pending block first, so that
  // list is the last element child (scoped lookup instead of an O(prefix) scan).
  const last = completedEl.lastElementChild
  if (!(last instanceof HTMLElement) || (last.tagName !== 'UL' && last.tagName !== 'OL')) {
    return null
  }
  // The host must be a *committed* item. When the trailing list is the wrapper
  // holding the pending <li> itself, skip it — returning the pending item here
  // would make it its own nesting host and detach it (#21 review finding).
  let li = last.lastElementChild
  if (li instanceof HTMLElement && li.classList.contains(BLOCK_PENDING_CLASS)) {
    li = li.previousElementSibling
  }
  return li instanceof HTMLElement && li.tagName === 'LI' ? li : null
}

function clearListContinuationDom(completedEl: HTMLElement): void {
  tailPendingDescendant(completedEl, `li .${LIST_CONTINUATION_CLASS}`)?.remove()
}

/**
 * `pending` should render inside the trailing committed `<p>` (as a lazy
 * paragraph continuation) rather than as a standalone pending block.
 */
function isParagraphContinuationPending(split: StreamingSplit): boolean {
  const { pending, openListItemFirstLine } = split
  return (
    split.paragraphContinuation === true &&
    blockPendingTag(pending, openListItemFirstLine) === 'p' &&
    isBlockLevelPending(pending, openListItemFirstLine)
  )
}

function paragraphContinuationSpanHtml(pendingInner: string): string {
  return `<span class="stream-pending ${PARAGRAPH_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}">${pendingInner}</span>`
}

/**
 * Insert the pending continuation inside the trailing `</p>`. The soft-break
 * `\n` lives OUTSIDE the span, as paragraph text, so it displays exactly like
 * the committed soft break will in the host theme (a space under collapsing
 * white-space, a line break under `white-space: pre-wrap`).
 */
function appendParagraphContinuationHtml(rendered: string, pendingInner: string): string | null {
  if (!rendered.endsWith('</p>')) return null
  return `${rendered.slice(0, -'</p>'.length)}\n${paragraphContinuationSpanHtml(pendingInner)}</p>`
}

/** The trailing committed paragraph a pending continuation renders into. */
function findTrailingParagraphHost(completedEl: HTMLElement): HTMLElement | null {
  const last = completedEl.lastElementChild
  if (!(last instanceof HTMLElement) || last.tagName !== 'P') return null
  // A pending paragraph *block* is also a trailing <p> — never nest into it.
  if (last.classList.contains(BLOCK_PENDING_CLASS)) return null
  return last
}

/** Remove a continuation span together with its preceding soft-break text node. */
function removeParagraphContinuationNode(el: Element | null): void {
  if (!el) return
  const prev = el.previousSibling
  if (prev !== null && prev.nodeType === 3 /* TEXT_NODE */ && prev.textContent === '\n') {
    prev.remove()
  }
  el.remove()
}

function clearParagraphContinuationDom(completedEl: HTMLElement): void {
  removeParagraphContinuationNode(
    tailPendingDescendant(completedEl, `.${PARAGRAPH_CONTINUATION_CLASS}`),
  )
}

function syncParagraphContinuationDom(
  completedEl: HTMLElement,
  pendingInner: SanitizedHtml | '',
  active: boolean,
): boolean {
  const host = findTrailingParagraphHost(completedEl)
  if (!host) return false

  const existing = host.querySelector(`:scope > .${PARAGRAPH_CONTINUATION_CLASS}`)
  /* c8 ignore start -- unreachable defensive guard: `active` is always `true`
     here and `pendingInner` is non-empty whenever this path runs (see the note
     in syncListPendingDom). */
  if (!active || !pendingInner) {
    removeParagraphContinuationNode(existing)
    return true
  }
  /* c8 ignore stop */

  let el: Element | null = existing
  if (!el) {
    // Soft break as a real text node in the <p> (see appendParagraphContinuationHtml).
    host.append(document.createTextNode('\n'))
    el = document.createElement('span')
    host.append(el)
  }
  el.className = `stream-pending ${PARAGRAPH_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`
  setPresanitizedHtml(el, pendingInner)
  return true
}

function syncListContinuationDom(
  completedEl: HTMLElement,
  pendingInner: SanitizedHtml | '',
  active: boolean,
): boolean {
  const li = findOpenListItemHost(completedEl)
  if (!li) return false

  const existing = li.querySelector(`:scope > .${LIST_CONTINUATION_CLASS}`)
  /* c8 ignore start -- unreachable defensive guard: `active` is always `true`
     here and `pendingInner` is non-empty whenever this path runs (see the note
     in syncListPendingDom). */
  if (!active || !pendingInner) {
    existing?.remove()
    return true
  }
  /* c8 ignore stop */

  let el: Element | null = existing
  if (!el) {
    el = document.createElement('span')
    li.append(el)
  }
  el.className = `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`
  // Literal leading-space seam on sanitized inner — sanitizer-equivalent.
  setPresanitizedHtml(
    el,
    pendingInner.startsWith(' ') ? pendingInner : asSanitizedHtml(` ${pendingInner}`),
  )
  return true
}

function syncBlockPendingDom(
  completedEl: HTMLElement,
  split: StreamingSplit,
  pendingInner: SanitizedHtml | '',
  active: boolean,
): void {
  const { pending, openListItemFirstLine } = split

  if (isParagraphContinuationPending(split)) {
    clearBlockPendingDom(completedEl, ['continuation', 'list-items', 'non-list-direct'])
    if (syncParagraphContinuationDom(completedEl, pendingInner, active)) return
    // No trailing <p> host — fall through to a standalone pending block.
  }

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    clearBlockPendingDom(completedEl, [
      'continuation',
      'paragraph-continuation',
      'list-items',
      'non-list-direct',
    ])
    syncListContinuationDom(completedEl, pendingInner, active)
    return
  }

  if (pendingListMarkerLength(pending) !== null) {
    syncListPendingDom(completedEl, pending, pendingInner, active, openListItemFirstLine)
    return
  }

  clearBlockPendingDom(completedEl, ['continuation', 'paragraph-continuation', 'list-items'])
  const existing = tailDirectPendingBlock(completedEl, false)
  /* c8 ignore start -- unreachable defensive guard: `active` is always `true`
     here and `pendingInner` is non-empty whenever this path runs (see the note
     in syncListPendingDom). */
  if (!active || !pendingInner) {
    existing?.remove()
    return
  }
  /* c8 ignore stop */
  const tag = blockPendingTag(pending, openListItemFirstLine)
  let el: Element | null = existing
  if (!el || el.tagName.toLowerCase() !== tag) {
    existing?.remove()
    el = document.createElement(tag)
    completedEl.append(el)
  }
  el.className = blockPendingClassName(pending, openListItemFirstLine)
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (ordered !== null) el.setAttribute('data-ordered-marker', ordered)
  else el.removeAttribute('data-ordered-marker')
  if (headingLevel !== null) el.setAttribute('data-heading-level', String(headingLevel))
  else el.removeAttribute('data-heading-level')
  setPresanitizedHtml(el, wrapBlockPendingInner(pending, pendingInner))
}

function syncInlinePendingDom(
  pendingEl: HTMLSpanElement,
  pendingInner: SanitizedHtml | '',
  active: boolean,
): void {
  setPresanitizedHtml(pendingEl, pendingInner)
  pendingEl.hidden = !active
  pendingEl.className = 'stream-pending'
  delete pendingEl.dataset['orderedMarker']
}

function renderPendingTail(
  split: StreamingSplit,
  complete: string,
  formingActive: boolean,
  completeTokens?: BlockToken[],
): { pendingInner: SanitizedHtml | ''; pendingVisible: boolean } {
  const { pending, openListItemFirstLine } = split
  const pendingInTable = pendingLineBelongsInTable(complete, pending, completeTokens)
  const pendingInner =
    pending && !pendingInTable && !formingActive
      ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine))
      : ''
  const pendingVisible = pending !== '' && !pendingInTable && !formingActive && pendingInner !== ''
  return { pendingInner, pendingVisible }
}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 */
export function renderStreamingMarkdown(content: string): string {
  const split = splitForStreaming(content)
  const { complete, pending, openListItemFirstLine, blocks } = split
  // Tokenize `complete` at most once and reuse it for the render and the
  // table checks (Layer 1, #21). `blocks` is `tokenizeBlocks(content)`.
  let completeTokensCache: BlockToken[] | null = null
  const completeTokens = (): BlockToken[] => (completeTokensCache ??= tokenizeBlocks(complete))
  const completeTokensForPending = pending.includes('|') ? completeTokens() : undefined
  const rendered = complete
    ? sanitizeRenderedMarkdown(renderMarkdown(complete, { tokens: completeTokens() }))
    : ''
  const fenceSource = formingFenceSource(content, blocks)
  const mathSource = fenceSource ? null : getIncompleteMathSource(content, blocks)
  const tableSource =
    fenceSource || mathSource
      ? null
      : formingTableSource(complete, content, pending, blocks, completeTokensForPending)
  const formingHtml = fenceSource
    ? buildFormingFenceHtml(fenceSource)
    : mathSource
      ? buildFormingMathHtml(mathSource)
      : tableSource
        ? buildFormingTableHtml(tableSource)
        : ''

  if (formingHtml) {
    return `${rendered}${formingHtml}`
  }
  if (!pending) return rendered
  if (pendingLineBelongsInTable(complete, pending, completeTokensForPending)) {
    return appendPendingTableRowHtml(rendered, pending)
  }
  const pendingInner = sanitizeRenderedMarkdown(
    renderPendingInlineMarkdown(pending, openListItemFirstLine),
  )
  if (!pendingInner) return rendered

  if (isParagraphContinuationPending(split)) {
    const inserted = appendParagraphContinuationHtml(rendered, pendingInner)
    if (inserted) return inserted
  }

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    const contHtml = blockPendingHtml(pending, pendingInner, openListItemFirstLine)
    const inserted = insertBeforeTrailingListClose(rendered, contHtml)
    if (inserted) return inserted
  }

  if (pendingListMarkerLength(pending) !== null) {
    return appendListPendingHtml(rendered, pending, pendingInner, openListItemFirstLine)
  }

  const pendingHtml = isBlockLevelPending(pending, openListItemFirstLine)
    ? blockPendingHtml(pending, pendingInner, openListItemFirstLine)
    : inlinePendingSpanHtml(pendingInner)
  return `${rendered}${pendingHtml}`
}

/**
 * Incremental streaming renderer.
 *
 * Committed markdown is re-rendered when the safe prefix grows. Forming tables
 * and in-progress table rows are updated via forward-pass DOM appends (no full
 * re-parse of the table skeleton on each token).
 */
export class StreamingMarkdownRenderer {
  private completedEl: HTMLElement | null = null
  private formingEl: HTMLElement | null = null
  private pendingEl: HTMLSpanElement | null = null
  private lastComplete = ''
  /** `tokenizeBlocks(lastComplete)` — cached so pending-only frames stay O(tail). */
  private committedTokens: BlockToken[] = []
  /** Whether `lastComplete` contains `|` — cached for the same reason. */
  private committedHasPipe = false
  private readonly frozenTail = new FrozenTailRenderer()
  // Incremental scanners (#30): re-tokenize / re-scan only past the last safe
  // boundary instead of the whole string every update. One per source stream —
  // the raw content and the committed prefix advance differently.
  private readonly contentScanner = new IncrementalSourceScanner()
  private readonly completeScanner = new IncrementalSourceScanner()
  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
  }

  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content: string): void {
    const split = splitForStreamingFrom(content, this.contentScanner.tokenize(content))
    const { complete, pending, openListItemFirstLine, blocks } = split
    const { completedEl, formingEl, pendingEl } = this.ensureNodes()

    if (complete !== this.lastComplete) {
      // Tokenize `complete` once per COMMIT — incrementally (#30) — and cache
      // on the instance so pending-only frames (the vast majority) never
      // re-scan at all (#21). When the split committed everything, `blocks`
      // already is `tokenizeBlocks(complete)`; still feed the scanner so its
      // link-ref cache and safe boundary advance with it.
      this.committedTokens = this.completeScanner.tokenize(complete)
      this.committedHasPipe = complete.includes('|')
      // Freeze the settled prefix and re-render only the tail group (#21). Blocks
      // that can never change again keep their node identity permanently; the
      // fast path degrades to a full in-place morph on any uncertainty, so output
      // is byte-identical to re-rendering the whole committed prefix.
      this.frozenTail.update(
        completedEl,
        complete,
        this.committedTokens,
        this.completeScanner.linkRefs(complete),
      )
      this.lastComplete = complete
    }
    const completeTokensForPending = pending.includes('|') ? this.committedTokens : undefined

    // A committed GFM table always contains `|`; without one there is no table
    // to sync or clean up, so skip the whole-subtree `querySelectorAll('table')`
    // scan `findLastCommittedTable` would otherwise run on every update — the
    // last O(prefix)-per-commit DOM cost after the frozen/tail split (#21).
    const mayHaveCommittedTable = this.committedHasPipe
    const fenceSource = formingFenceSource(content, blocks)
    const mathSource = fenceSource ? null : getIncompleteMathSource(content, blocks)
    const tableSource =
      fenceSource || mathSource
        ? null
        : formingTableSource(complete, content, pending, blocks, completeTokensForPending)
    if (fenceSource || mathSource || tableSource) {
      if (fenceSource) syncFormingFenceDom(formingEl, fenceSource)
      else if (mathSource) syncFormingMathDom(formingEl, mathSource)
      else if (tableSource) syncFormingTableDom(formingEl, tableSource)
      formingEl.hidden = false
      const committed = mayHaveCommittedTable ? this.findLastCommittedTable() : null
      if (committed) removePendingTableRow(committed)
    } else {
      clearFormingDom(formingEl)
      formingEl.hidden = true
      if (mayHaveCommittedTable) this.syncCommittedTableRow(complete, pending, completeTokensForPending)
    }

    const formingActive = fenceSource !== null || mathSource !== null || tableSource !== null
    const { pendingInner, pendingVisible } = renderPendingTail(
      split,
      complete,
      formingActive,
      completeTokensForPending,
    )

    if (pendingVisible && isBlockLevelPending(pending, openListItemFirstLine)) {
      syncBlockPendingDom(completedEl, split, pendingInner, true)
      syncInlinePendingDom(pendingEl, '', false)
    } else {
      clearBlockPendingDom(completedEl, ['continuation', 'paragraph-continuation', 'direct-blocks'])
      syncInlinePendingDom(pendingEl, pendingInner, pendingVisible)
    }
  }

  private syncCommittedTableRow(
    complete: string,
    pending: string,
    completeTokens?: BlockToken[],
  ): void {
    const table = this.findLastCommittedTable()
    if (!table) return

    if (pendingLineBelongsInTable(complete, pending, completeTokens)) {
      syncPendingTableRowDom(table, pending)
      return
    }
    removePendingTableRow(table)
  }

  private findLastCommittedTable(): HTMLTableElement | null {
    const tables = this.completedEl?.querySelectorAll('table')
    const last = tables?.[tables.length - 1]
    if (last instanceof Element && last.tagName === 'TABLE') {
      return last
    }
    return null
  }

  private ensureNodes(): {
    completedEl: HTMLElement
    formingEl: HTMLElement
    pendingEl: HTMLSpanElement
  } {
    if (
      this.completedEl &&
      this.formingEl &&
      this.pendingEl &&
      this.host.contains(this.completedEl)
    ) {
      return {
        completedEl: this.completedEl,
        formingEl: this.formingEl,
        pendingEl: this.pendingEl,
      }
    }
    this.host.replaceChildren()
    const completedEl = document.createElement('div')
    completedEl.className = 'stream-complete'
    const formingEl = document.createElement('div')
    formingEl.className = 'stream-forming'
    formingEl.hidden = true
    const pendingEl = document.createElement('span')
    pendingEl.className = 'stream-pending'
    pendingEl.hidden = true
    this.host.append(completedEl, formingEl, pendingEl)
    this.completedEl = completedEl
    this.formingEl = formingEl
    this.pendingEl = pendingEl
    this.lastComplete = ''
    this.committedTokens = []
    this.committedHasPipe = false
    // The committed subtree was just rebuilt, so any frozen bookkeeping now
    // dangles against a fresh element (gap D) — start it over.
    this.frozenTail.reset()
    return { completedEl, formingEl, pendingEl }
  }
}

function formingTableSource(
  complete: string,
  content: string,
  pending: string,
  contentTokens?: BlockToken[],
  completeTokens?: BlockToken[],
): string | null {
  if (getIncompleteFenceSource(content, contentTokens)) return null
  if (pendingLineBelongsInTable(complete, pending, completeTokens)) return null
  const fromTokens = getIncompleteTableSource(content, contentTokens)
  if (fromTokens) return fromTokens
  const trimmed = pending.trimStart()
  if (trimmed.startsWith('|') && trimmed.includes('|', 1)) return pending
  return null
}

function formingFenceSource(content: string, contentTokens?: BlockToken[]): string | null {
  return getIncompleteFenceSource(content, contentTokens)
}

function clearFormingDom(container: HTMLElement): void {
  clearFormingFenceDom(container)
  clearFormingTableDom(container)
}
