import { renderMarkdownUnsafe } from './renderer.ts'
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
  isPlainParagraphPendingLine,
  listPendingIndent,
  pendingAtxHeadingLevel,
  pendingListMarkerLength,
  pendingListOrderedMarker,
  renderPendingLine,
  revealFormingLink,
  stripParagraphIndent,
} from './render-pending-line.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { getInlinePasses } from './inline-passes.ts'
import { splitForStreaming, splitForStreamingFrom, type StreamingSplit } from './streaming-split.ts'
import { IncrementalSourceScanner } from './incremental-scan.ts'
import { findDescendantByClass, firstDirectChild, lastDirectChild } from './dom-scan.ts'
export type { StreamingSplitWithTokens } from './streaming-split.ts'
import { escapeHtml } from './escape.ts'
import { type MarkdownConfig, withConfig } from './config.ts'
import { hydratePendingMath, type HydrateMathOptions } from './math.ts'
import { hydratePendingDiagrams, type HydrateDiagramsOptions } from './mermaid.ts'
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
import { FrozenTailRenderer, hasOpenDetailsElement } from './streaming-frozen-tail.ts'

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

// Pending tail elements live at the very end of `stream-complete` — the last
// direct child, or the child immediately before a trailing footnotes section
// (#220): the committed section is pinned at the very bottom, so a pending
// block is inserted before it, and a pending list item / continuation span
// lives inside the trailing content element. Every clear runs *before* the
// next pending element is attached, so the target is always within the tail
// content element at query time. Scoping the pending queries there instead of
// `querySelector`-ing the whole committed subtree turns an O(prefix)-per-frame
// DOM scan into O(tail) — the dominant residual cost of a long stream once the
// committed prefix is frozen (#21 follow-up). jsdom's `:scope >`/descendant
// selectors still walk the full subtree, so this matters.

/** The trailing committed footnotes section, when it is the last element child. */
function trailingFootnotesSection(completedEl: HTMLElement): Element | null {
  const last = completedEl.lastElementChild
  return last && last.tagName === 'SECTION' && last.classList.contains('footnotes') ? last : null
}

/**
 * The element the pending-tail machinery treats as the tail: the last element
 * child, or — when the committed output ends with the footnotes section — the
 * element immediately before it (#220). The section itself is never a
 * pending-tail host, and it grows with the document (N `<li>`), so it is
 * skipped by construction rather than walked per update (#133).
 */
function tailContentElement(completedEl: HTMLElement): Element | null {
  const section = trailingFootnotesSection(completedEl)
  return section ? section.previousElementSibling : completedEl.lastElementChild
}

/** Attach a pending tail element: before a trailing footnotes section, else appended (#220). */
function appendPendingTail(completedEl: HTMLElement, el: Element): void {
  const section = trailingFootnotesSection(completedEl)
  if (section) completedEl.insertBefore(el, section)
  else completedEl.append(el)
}

/** A pending descendant (continuation span, pending `<li>`) inside the trailing element. */
function tailPendingDescendant(completedEl: HTMLElement, cls: string, tagName?: string): Element | null {
  const last = tailContentElement(completedEl)
  if (!last) return null
  return findDescendantByClass(last, cls, tagName)
}

/** A pending block element attached directly to `completedEl` (the tail content element). */
function tailDirectPendingBlock(completedEl: HTMLElement, excludeLi: boolean): Element | null {
  const last = tailContentElement(completedEl)
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
    const pendingLi = tailPendingDescendant(completedEl, BLOCK_PENDING_CLASS, 'LI')
    const wrapper = pendingLi?.parentElement
    pendingLi?.remove()
    // The wrapper <ul>/<ol> may have been created solely to host this pending
    // item; once the item is swept, a now-empty wrapper is stale content that
    // diverges from the fresh render (an empty document, not `<ul></ul>`), so
    // drop it too. A wrapper that still holds committed items stays. Mirrors the
    // inactive-branch cleanup in syncListPendingDom.
    if (
      wrapper &&
      (wrapper.tagName === 'UL' || wrapper.tagName === 'OL') &&
      wrapper.childNodes.length === 0
    ) {
      wrapper.remove()
    }
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

  // Splice into the trailing list only when it is the TOP-LEVEL trailing list —
  // i.e. its close tag ends the rendered output. A list nested inside a
  // blockquote (or other container) ends the string with the container's close
  // (e.g. `</blockquote>`), so a pending top-level bullet must become a new
  // sibling list rather than being injected into the quote (#109). This mirrors
  // the DOM emitter's `findTrailingListHost`, which reuses the trailing list
  // only when it is the tail content element of `stream-complete`. The caller
  // passes the committed BODY — a trailing footnotes section (#72) is already
  // split off, and the returned HTML is re-joined above it (#220).
  const close = `</${listTag}>`
  if (rendered.endsWith(close)) {
    const closeIndex = rendered.length - close.length
    const beforeClose = rendered.slice(0, closeIndex)
    if (beforeClose.lastIndexOf(`<${listTag}`) !== -1) {
      return `${beforeClose}${liHtml}${close}`
    }
  }

  const ordered = pendingListOrderedMarker(pending)
  const startAttr = ordered !== null && listTag === 'ol' ? ` start="${escapeHtml(ordered)}"` : ''
  return `${rendered}<${listTag}${startAttr}>${liHtml}</${listTag}>`
}

function findTrailingListHost(completedEl: HTMLElement, listTag: 'ul' | 'ol'): HTMLElement | null {
  const last = tailContentElement(completedEl)
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
  const existingPendingLi = tailPendingDescendant(completedEl, BLOCK_PENDING_CLASS, 'LI')

  /* c8 ignore start -- unreachable defensive guard: the only caller (update)
     enters the block-pending path solely when `pendingVisible`, and
     renderPendingTail sets `pendingVisible` only when `pendingInner !== ''`;
     `active` is always passed `true`. Kept so this helper stays correct if ever
     driven directly. */
  if (!active || !pendingInner) {
    existingPendingLi?.remove()
    const last = tailContentElement(completedEl)
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
      // `:scope > ul:last-of-type` as a direct backwards child scan.
      const existingNested = lastDirectChild(hostLi, listTag.toUpperCase(), null)
      if (existingNested instanceof HTMLElement) {
        list = existingNested
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
        appendPendingTail(completedEl, created)
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
  // list is the tail content element (scoped lookup instead of an O(prefix) scan).
  const last = tailContentElement(completedEl)
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
  // The continuation span is only ever appended inside a list item (see
  // syncListContinuationDom), so the class alone identifies it.
  tailPendingDescendant(completedEl, LIST_CONTINUATION_CLASS)?.remove()
}

/**
 * `pending` should render inside the trailing committed `<p>` (as a lazy
 * paragraph continuation) rather than as a standalone pending block.
 */
function isParagraphContinuationPending(split: StreamingSplit): boolean {
  const { pending, openListItemFirstLine } = split
  return (
    (split.inlineCodeContinuation === true ||
      (split.paragraphContinuation === true &&
        isBlockLevelPending(pending, openListItemFirstLine))) &&
    blockPendingTag(pending, openListItemFirstLine) === 'p' &&
    pending !== ''
  )
}

/** Inline-code holds continue the same source line; ordinary continuations add a soft break. */
function paragraphContinuationSeam(split: StreamingSplit): string {
  return split.inlineCodeContinuation === true ? '' : '\n'
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
function appendParagraphContinuationHtml(
  rendered: string,
  pendingInner: string,
  seam: string,
): string | null {
  if (!rendered.endsWith('</p>')) return null
  return `${rendered.slice(0, -'</p>'.length)}${seam}${paragraphContinuationSpanHtml(pendingInner)}</p>`
}

/** The trailing committed paragraph a pending continuation renders into. */
function findTrailingParagraphHost(completedEl: HTMLElement): HTMLElement | null {
  const last = tailContentElement(completedEl)
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
    tailPendingDescendant(completedEl, PARAGRAPH_CONTINUATION_CLASS),
  )
}

function syncParagraphContinuationDom(
  completedEl: HTMLElement,
  pendingInner: SanitizedHtml | '',
  active: boolean,
  seam: string,
): boolean {
  const host = findTrailingParagraphHost(completedEl)
  if (!host) return false

  const existing = firstDirectChild(host, null, PARAGRAPH_CONTINUATION_CLASS)
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
    // Ordinary continuations carry a real soft-break text node; an inline-code
    // hold starts in the same source line and therefore has no seam.
    if (seam) host.append(document.createTextNode(seam))
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

  const existing = firstDirectChild(li, null, LIST_CONTINUATION_CLASS)
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
    if (
      syncParagraphContinuationDom(
        completedEl,
        pendingInner,
        active,
        paragraphContinuationSeam(split),
      )
    ) {
      return
    }
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
    appendPendingTail(completedEl, el)
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
  formingActive: boolean,
  pendingInTable: boolean,
): { pendingInner: SanitizedHtml | ''; pendingVisible: boolean } {
  const { pending, openListItemFirstLine } = split
  const pendingInner =
    pending && !pendingInTable && !formingActive
      ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine))
      : ''
  const pendingVisible = pending !== '' && !pendingInTable && !formingActive && pendingInner !== ''
  return { pendingInner, pendingVisible }
}

// ---------------------------------------------------------------------------
// Pending-line plain-text fast path.
//
// For real LLM streams (~5-char deltas) the dominant per-update cost is
// re-rendering the pending line's inline markdown and swapping it into the DOM
// via an innerHTML parse — even though most deltas merely extend a plain prose
// sentence. When an update provably cannot change any prior rendering
// decision, the new characters are appended to the pending element's trailing
// text node directly and the whole render → sanitize → innerHTML pipeline is
// skipped. On ANY doubt the frame falls back to the full re-render, so output
// stays byte-identical to the slow path.
//
// The proof obligations, and where each is discharged:
// - The appended characters must be inert to the inline grammar: they cannot
//   begin, close, extend, or re-flank any construct, and they are identity
//   under HTML escaping at the DOM level. `PENDING_FAST_PATH_INERT_RE` is the
//   conservative allowlist; everything the grammar cares about (`` ` `` `*`
//   `_` `~` `[` `]` `(` `)` `<` `>` `&` `\` `$` `@` `:` `/` `=` `^` `|` `#`
//   `{` `}` `+` `%`, tabs, newlines, all non-ASCII) is excluded.
// - The pending line must be on `renderPendingLine`'s plain-paragraph branch
//   both frames (`isPlainParagraphPendingLine`, recomputed per frame — inert
//   appends CAN flip a branch predicate, e.g. ` ` → ` -` becomes a list
//   marker, so recomputation rather than stability is the guarantee).
// - Nothing may be held either frame (`pendingHoldIndex === length`), so the
//   visible text is the whole pending line and half-open constructs
//   (emphasis, entities, math, footnote refs, raw tags, inline-pass holds)
//   never sit at the boundary.
// - The paragraph-normalization and forming-link transforms must both be pure
//   extensions: `stripParagraphIndent` / `revealFormingLink` of the new line
//   must equal the old transform plus the appended characters. This is what
//   rejects appends that would vanish into a dropped `](url…` tail.
// - Extended autolinks are the one construct made of inert characters
//   (letters + `.`): a word that contains `@`, `www.` or `://` could absorb
//   previously-plain text retroactively (`a@b.` + `c` → mailto anchor), so
//   the region an append may have touched — from the last whitespace of the
//   OLD revealed text — must be free of all three.
// - The previous render must have ended in top-level plain text: the target
//   element's last child is a text node whose data ends with the trailing
//   inert run of the old revealed text. This rejects frames where the tail
//   was consumed by an element (autolink, emphasis, raw passthrough tag) or
//   rewritten (stripped `&nbsp` prefix), where an append could not land where
//   a fresh render would put it.
// - Any `<` in the revealed text disables arming: rawtext/RCDATA elements
//   (`<plaintext>`, `<xmp>`, `<textarea>`, …) flip the HTML parser state for
//   all text after them, so the sanitizer can strip appended characters
//   together with the element even though the pending DOM ends in a text node
//   (found by differential fuzzing under the passthrough policy).
// - Registered inline passes have arbitrary grammars, so their presence
//   disables the fast path entirely.
// ---------------------------------------------------------------------------

/**
 * Characters that cannot affect any inline rendering decision. ASCII-only on
 * purpose: non-ASCII (CJK punctuation classes, emoji, combining marks,
 * surrogate halves split across deltas) always takes the full render.
 */
const PENDING_FAST_PATH_INERT_RE = /^[0-9A-Za-z !?.,;'"-]+$/

/** Trailing run of fast-path-inert characters (possibly the whole string). */
function trailingInertRun(s: string): string {
  let i = s.length
  while (i > 0 && PENDING_FAST_PATH_INERT_RE.test(s[i - 1] ?? '')) i--
  return s.slice(i)
}

/** Index of the last space/tab in a single-line string, or -1. */
function lastWhitespaceIndex(s: string): number {
  return Math.max(s.lastIndexOf(' '), s.lastIndexOf('\t'))
}

/**
 * The extended-autolink absorption guard: a word containing `@`, `www.` or
 * `://` can retroactively swallow neighboring plain text into an `<a>` once
 * one more inert character arrives, so no fast-path append may touch one.
 */
function hasAutolinkAbsorptionRisk(region: string): boolean {
  const lower = region.toLowerCase()
  return lower.includes('@') || lower.includes('://') || lower.includes('www.')
}

interface PendingFastPathState {
  /** The pending source text the DOM currently reflects. */
  pending: string
  /** `stripParagraphIndent(pending)` at the last sync. */
  stripped: string
  /** `revealFormingLink(stripped)` — the text the inline renderer actually saw. */
  revealed: string
  /** Element hosting the rendered pending inline HTML (`<p>` or continuation span). */
  el: Element
  /** The trailing text node appended characters land in. */
  text: Text
  /** Expected `text.data` — a mismatch means something else touched the DOM. */
  textData: string
  /** Whether the pending renders as a paragraph-continuation span. */
  paragraphContinuation: boolean
  openListItemFirstLine: string | undefined
}

/**
 * Capture fast-path state after a full pending sync, or null when the frame
 * does not qualify. Cheap rejections run first: the extra `pendingHoldIndex`
 * scan only happens for single-line plain-prose tails ending in inert text.
 */
function armPendingFastPath(
  completedEl: HTMLElement,
  split: StreamingSplit,
  paragraphContinuation: boolean,
): PendingFastPathState | null {
  const { pending, openListItemFirstLine } = split
  if (!PENDING_FAST_PATH_INERT_RE.test(pending[pending.length - 1] ?? '')) return null
  if (pending.includes('\n')) return null
  if (getInlinePasses().length > 0) return null
  if (!isPlainParagraphPendingLine(pending, openListItemFirstLine)) return null
  if (pendingHoldIndex(pending) !== pending.length) return null
  const stripped = stripParagraphIndent(pending)
  const revealed = revealFormingLink(stripped)
  // Any `<` disables the fast path outright: HTML rawtext/RCDATA elements
  // (`<plaintext>`, `<xmp>`, `<textarea>`, …) flip the parser state for
  // everything AFTER them, so the sanitizer can strip appended trailing text
  // together with the element — the source tail no longer corresponds to the
  // DOM's trailing text node. Appends can never introduce `<`/`>` (non-inert),
  // so this one arm-time check covers every later fast frame.
  if (revealed.includes('<')) return null
  const inertTail = trailingInertRun(revealed)
  if (inertTail === '') return null
  if (hasAutolinkAbsorptionRisk(revealed.slice(lastWhitespaceIndex(revealed) + 1))) return null

  let el: Element | null = null
  if (paragraphContinuation) {
    const host = findTrailingParagraphHost(completedEl)
    if (host) el = firstDirectChild(host, null, PARAGRAPH_CONTINUATION_CLASS)
  }
  if (!el) {
    // Standalone pending paragraph block — the tail content element (#220).
    const last = tailContentElement(completedEl)
    if (
      last &&
      last.tagName === 'P' &&
      last.classList.contains(BLOCK_PENDING_CLASS) &&
      last.classList.contains('stream-pending-paragraph')
    ) {
      el = last
    }
  }
  if (!el) return null

  const text = el.lastChild
  if (!text || text.nodeType !== 3 /* TEXT_NODE */) return null
  const textData = (text as Text).data
  if (!textData.endsWith(inertTail)) return null
  return {
    pending,
    stripped,
    revealed,
    el,
    text: text as Text,
    textData,
    paragraphContinuation,
    openListItemFirstLine,
  }
}

/**
 * Handle a pending-only frame by extending the previous frame's DOM in place.
 * Returns true when the frame was handled (state updated); false demands the
 * full re-render. Caller guarantees: no commit this frame, no forming
 * construct, pending not in a table.
 */
function tryPendingFastPath(
  st: PendingFastPathState,
  split: StreamingSplit,
  completedEl: HTMLElement,
  paragraphContinuation: boolean,
): boolean {
  const { pending, openListItemFirstLine } = split
  if (openListItemFirstLine !== st.openListItemFirstLine) return false
  if (paragraphContinuation !== st.paragraphContinuation) return false
  if (!pending.startsWith(st.pending)) return false
  // DOM integrity: the node this state points at must still be exactly what
  // the last frame left behind, or the append would land in the wrong place
  // (host scripts may mutate the pending element between updates).
  if (!completedEl.contains(st.el)) return false
  if (st.el.lastChild !== st.text || st.text.data !== st.textData) return false
  const appended = pending.slice(st.pending.length)
  // Byte-identical frame: the DOM already reflects this exact pending text.
  if (appended === '') return true
  if (!PENDING_FAST_PATH_INERT_RE.test(appended)) return false
  if (getInlinePasses().length > 0) return false
  if (!isPlainParagraphPendingLine(pending, openListItemFirstLine)) return false
  if (pendingHoldIndex(pending) !== pending.length) return false
  const stripped = stripParagraphIndent(pending)
  if (stripped !== st.stripped + appended) return false
  const revealed = revealFormingLink(stripped)
  if (revealed !== st.revealed + appended) return false
  if (hasAutolinkAbsorptionRisk(revealed.slice(lastWhitespaceIndex(st.revealed) + 1))) {
    return false
  }

  st.text.data = st.textData + appended
  st.pending = pending
  st.stripped = stripped
  st.revealed = revealed
  st.textData = st.textData + appended
  return true
}

/**
 * Options shared by the streaming emitters. Extends the per-render policy
 * overrides (#137) — `htmlPolicy`, `safeHrefSchemes`, `sanitizeExtension`,
 * `linkImagePolicy`, `trustedTypesPolicy` — each optional and inheriting the
 * process-wide default when omitted. For `StreamingMarkdownRenderer` the
 * overrides are captured at construction and re-applied around every `update()`.
 */
export interface StreamingMarkdownOptions extends MarkdownConfig {}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 *
 * Returns {@link SanitizedHtml}, matching {@link renderMarkdown}: the output is
 * `sanitizeRenderedMarkdown` parts joined by literal allowlisted seams (forming
 * fence/math/table scaffolding, pending inline/block wrappers — every one built
 * with `asSanitizedHtml`), so the whole string carries the sanitized brand.
 * Hosts assigning it to `innerHTML` keep the compile-time protection and the
 * Trusted Types story instead of dropping to an unbranded `string` (#140).
 */
export function renderStreamingMarkdown(
  content: string,
  options: StreamingMarkdownOptions = {},
): SanitizedHtml {
  return withConfig(options, () => asSanitizedHtml(renderStreamingMarkdownCore(content)))
}

/**
 * Split committed rendered HTML into the body and a trailing footnotes
 * section (with its preceding block-seam newline), so pending-tail HTML can be
 * spliced between them — the section stays pinned at the very bottom with the
 * pending tail above it (#220), mirroring the DOM emitter's
 * {@link appendPendingTail}. `body + section` is byte-identical to the input.
 */
function splitTrailingFootnoteSection(rendered: string): { body: string; section: string } {
  if (rendered.endsWith('</section>')) {
    // Matches both the raw and sanitizer-serialized forms of the open tag
    // emitted by `wrapFootnoteSection` (`data-footnotes` / `data-footnotes=""`).
    let idx = rendered.lastIndexOf('<section class="footnotes" data-footnotes')
    if (idx !== -1) {
      // Keep the between-blocks `\n` seam with the section, so body-anchored
      // splices (`…</p>$`, `…</ol>$`) still see the block close at the end.
      if (rendered[idx - 1] === '\n') idx--
      return { body: rendered.slice(0, idx), section: rendered.slice(idx) }
    }
  }
  return { body: rendered, section: '' }
}

function renderStreamingMarkdownCore(content: string): string {
  const split = splitForStreaming(content)
  const { complete, pending, openListItemFirstLine, blocks } = split
  // Tokenize `complete` at most once and reuse it for the render and the
  // table checks (Layer 1, #21). `blocks` is `tokenizeBlocks(content)`.
  let completeTokensCache: BlockToken[] | null = null
  const completeTokens = (): BlockToken[] => (completeTokensCache ??= tokenizeBlocks(complete))
  const completeTokensForPending = pending.includes('|') ? completeTokens() : undefined
  const renderedRaw = complete ? renderMarkdownUnsafe(complete, { tokens: completeTokens() }) : ''
  const rendered = renderedRaw ? sanitizeRenderedMarkdown(renderedRaw) : ''
  // Inside a still-forming `<details>` the committed children render inside the
  // (collapsed) element; a pending sibling would flash the collapsed body, so
  // hold the whole tail until the element closes (#600).
  if (hasOpenDetailsElement(renderedRaw)) return rendered
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
  // Block-level pending tails splice against the body, ABOVE a trailing
  // footnotes section (#220) — matching the DOM emitter, where the pending
  // element is inserted before the committed `section.footnotes`.
  const { body, section } = splitTrailingFootnoteSection(rendered)
  if (pendingLineBelongsInTable(complete, pending, completeTokensForPending)) {
    return `${appendPendingTableRowHtml(body, pending)}${section}`
  }
  const pendingInner = sanitizeRenderedMarkdown(
    renderPendingInlineMarkdown(pending, openListItemFirstLine),
  )
  if (!pendingInner) return rendered

  if (isParagraphContinuationPending(split)) {
    const inserted = appendParagraphContinuationHtml(
      body,
      pendingInner,
      paragraphContinuationSeam(split),
    )
    if (inserted) return `${inserted}${section}`
  }

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    const contHtml = blockPendingHtml(pending, pendingInner, openListItemFirstLine)
    const inserted = insertBeforeTrailingListClose(body, contHtml)
    if (inserted) return `${inserted}${section}`
  }

  if (pendingListMarkerLength(pending) !== null) {
    return `${appendListPendingHtml(body, pending, pendingInner, openListItemFirstLine)}${section}`
  }

  // The inline (non-block-level) pending span stays after the whole committed
  // output: the DOM emitter renders it in the host-level `stream-pending`
  // element, which follows `.stream-complete` (and any section inside it).
  if (!isBlockLevelPending(pending, openListItemFirstLine)) {
    return `${rendered}${inlinePendingSpanHtml(pendingInner)}`
  }
  return `${body}${blockPendingHtml(pending, pendingInner, openListItemFirstLine)}${section}`
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
  /**
   * The table currently hosting a pending body row, held by reference so its
   * cleanup never needs a DOM search (the backstop for the trailing-chain
   * table walk). Null whenever no pending row is attached.
   */
  private pendingRowTable: HTMLTableElement | null = null
  /**
   * State for the pending-line plain-text fast path (see the block comment
   * above {@link armPendingFastPath}); null whenever the last frame was not a
   * qualifying plain-prose pending sync.
   */
  private pendingFast: PendingFastPathState | null = null
  /**
   * Diagnostic: pending-only frames handled by the fast path (a direct text
   * append, or a byte-identical no-op) instead of a full inline re-render.
   * Mirrors `FrozenTailRenderer.renderedChars` as an observable for tests.
   */
  pendingFastPathHits = 0
  private readonly frozenTail = new FrozenTailRenderer()

  /**
   * Timing-free work-shape counters, summed across this renderer's scanners
   * and commit path (ADR 0004 Phase 3). These are what the long-document
   * doubling guards assert on: totals that must stay ~O(new bytes) over an
   * append-only stream (`scannedChars`, `suffixTokensScanned`, `renderedChars`,
   * `parsedChars`), and the rewrite-guard comparison count (`prefixChecks`),
   * which must stay ~one per scanner call — a second O(prefix) memcmp per
   * update was a measured super-linear term on multi-hundred-kB streams.
   * @internal Diagnostics for tests/benchmarks, not a stable API (#147).
   */
  diagnostics(): {
    scannedChars: number
    suffixTokensScanned: number
    prefixChecks: number
    prefixBytesCompared: number
    renderedChars: number
    parsedChars: number
    pendingFastPathHits: number
  } {
    return {
      scannedChars: this.contentScanner.scannedChars + this.completeScanner.scannedChars,
      suffixTokensScanned:
        this.contentScanner.suffixTokensScanned + this.completeScanner.suffixTokensScanned,
      prefixChecks: this.contentScanner.prefixChecks + this.completeScanner.prefixChecks,
      prefixBytesCompared:
        this.contentScanner.prefixBytesCompared + this.completeScanner.prefixBytesCompared,
      renderedChars: this.frozenTail.renderedChars,
      parsedChars: this.frozenTail.parsedChars,
      pendingFastPathHits: this.pendingFastPathHits,
    }
  }
  // Incremental scanners (#30): re-tokenize / re-scan only past the last safe
  // boundary instead of the whole string every update. One per source stream —
  // the raw content and the committed prefix advance differently.
  private readonly contentScanner = new IncrementalSourceScanner()
  private readonly completeScanner = new IncrementalSourceScanner()
  private readonly host: HTMLElement
  /**
   * Full {@link MarkdownConfig} captured at construction and re-applied around
   * every commit — so this instance renders under its own policy *and* grammar
   * config (html/scheme/origin/sanitize, plus math syntax, link decorator, fence
   * handlers) regardless of the process-wide defaults. Two renderers with
   * different config coexist without an epoch or cache invalidation.
   */
  private readonly config: MarkdownConfig

  constructor(host: HTMLElement, options: StreamingMarkdownOptions = {}) {
    this.host = host
    // Snapshot the config so it is frozen at construction (#153, option b): a
    // shallow copy is enough because every field is replaced wholesale, never
    // deep-mutated. Holding `options` by reference would let a host that mutates
    // its object mid-stream leak the old mid-stream-config-flip failure class
    // into the already-frozen prefix / cached tokens; the copy severs that.
    this.config = { ...options }
  }

  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content: string): void {
    withConfig(this.config, () => {
      this.updateWithPolicy(content)
    })
  }

  /**
   * Hydrate the pending math / diagram scaffolding this renderer has emitted into
   * its host, using the `mathRenderer` / `diagramRenderer` from the config passed
   * at construction. This is the config-injected replacement for the old global
   * `setMathRenderer` / `setDiagramRenderer` + free-function `hydratePendingMath`
   * dance: obtain the backends from `loadKatex()` / `loadMermaid()`, pass them in
   * the constructor config, then call `hydrate()` after `update()`. A no-op for a
   * tier whose renderer is not configured. Returns the counts rendered.
   *
   * `transformHtml` / `transformSvg` forward to the underlying hydrators (required
   * under Trusted Types enforcement — see {@link HydrateMathOptions}).
   */
  async hydrate(
    options: {
      transformHtml?: HydrateMathOptions['transformHtml']
      transformSvg?: HydrateDiagramsOptions['transformSvg']
    } = {},
  ): Promise<{ math: number; diagrams: number }> {
    let math = 0
    const mathRenderer = this.config.mathRenderer
    if (mathRenderer) {
      const mathOptions: HydrateMathOptions = { renderer: mathRenderer }
      if (options.transformHtml) mathOptions.transformHtml = options.transformHtml
      // Hydration runs outside the render's config scope, so the policy has to
      // travel with the options rather than be read from ambient config.
      if (this.config.urlPolicy != null) mathOptions.urlPolicy = this.config.urlPolicy
      math = await hydratePendingMath(this.host, mathOptions)
    }
    let diagrams = 0
    const diagramRenderer = this.config.diagramRenderer
    if (diagramRenderer) {
      const diagramOptions: HydrateDiagramsOptions = { renderer: diagramRenderer }
      if (options.transformSvg) diagramOptions.transformSvg = options.transformSvg
      if (this.config.urlPolicy != null) diagramOptions.urlPolicy = this.config.urlPolicy
      diagrams = await hydratePendingDiagrams(this.host, diagramOptions)
    }
    // Hydration rewrites scaffold elements in place — an out-of-band mutation
    // the frozen-tail DOM memo must not trust across (ADR 0004 Phase 2).
    if (math > 0 || diagrams > 0) this.frozenTail.invalidateDomMemo()
    return { math, diagrams }
  }

  private updateWithPolicy(content: string): void {
    const split = splitForStreamingFrom(content, this.contentScanner.tokenize(content))
    const { complete, pending, openListItemFirstLine, blocks } = split
    const { completedEl, formingEl, pendingEl } = this.ensureNodes()

    if (complete !== this.lastComplete) {
      // Sweep the pending-tail artifacts attached since the last commit — a
      // pending block element, a pending `<li>` (and its wrapper) inside the
      // trailing list, a continuation span inside the trailing `<p>`/open
      // `<li>`, the pending table row — BEFORE the commit morphs run. The
      // morphs used to absorb them as ordinary diff noise; the frozen-tail
      // DOM memos (ADR 0004 Phase 2) instead require the committed subtree to
      // be exactly what the last commit left, so remove them up front (they
      // are rebuilt from `pending` after the commit either way — at most one
      // kind exists at a time, each sync clears the others). O(tail), and
      // byte-equivalent to the old morph-side removal.
      clearBlockPendingDom(completedEl, [
        'continuation',
        'paragraph-continuation',
        'list-items',
        'direct-blocks',
      ])
      if (this.pendingRowTable) {
        removePendingTableRow(this.pendingRowTable)
        this.pendingRowTable = null
      }
      // Tokenize `complete` once per COMMIT — incrementally (#30), consuming
      // the full ScanAdvance (ADR 0004 Phase 2): the sealed-event stream's
      // append-only verification (`reset`/`verifiedUpTo`) replaces the commit
      // path's own O(prefix) byte re-check, and the sealed definition deltas
      // already feed the cached maps below. Cache the tokens on the instance
      // so pending-only frames (the vast majority) never re-scan at all (#21).
      const advance = this.completeScanner.advance(complete)
      this.committedTokens = advance.tokens
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
        this.completeScanner.footnoteDefs(complete),
        advance,
      )
      this.lastComplete = complete
      // A commit restructures the committed subtree, so the fast-path node
      // bookkeeping (and its "no prior decision can change" premise) is void.
      this.pendingFast = null
    }

    // Inside a still-forming `<details>`: its committed children already render
    // inside the (collapsed) element, and a pending sibling here would flash the
    // collapsed body as a visible tail. Hold the whole tail — forming and
    // pending — until the element closes (#600).
    if (this.frozenTail.committedHasOpenDetails) {
      clearFormingDom(formingEl)
      formingEl.hidden = true
      clearBlockPendingDom(completedEl, ['continuation', 'paragraph-continuation', 'direct-blocks'])
      syncInlinePendingDom(pendingEl, '', false)
      this.pendingFast = null
      return
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
      const committed = this.pendingRowTable ?? (mayHaveCommittedTable ? this.findLastCommittedTable() : null)
      if (committed) removePendingTableRow(committed)
      this.pendingRowTable = null
    } else {
      clearFormingDom(formingEl)
      formingEl.hidden = true
      if (mayHaveCommittedTable) this.syncCommittedTableRow(complete, pending, completeTokensForPending)
    }

    const formingActive = fenceSource !== null || mathSource !== null || tableSource !== null
    const pendingInTable = pendingLineBelongsInTable(complete, pending, completeTokensForPending)

    // Plain-text fast path: extend the previous frame's pending text node in
    // place when the delta provably changes nothing else (see the invariant
    // block above armPendingFastPath). Everything up to here — forming DOM
    // sync/cleanup, committed table-row sync — already ran for this frame.
    if (
      !formingActive &&
      !pendingInTable &&
      this.pendingFast &&
      tryPendingFastPath(
        this.pendingFast,
        split,
        completedEl,
        isParagraphContinuationPending(split),
      )
    ) {
      this.pendingFastPathHits++
      return
    }
    this.pendingFast = null

    const { pendingInner, pendingVisible } = renderPendingTail(split, formingActive, pendingInTable)

    if (
      pendingVisible &&
      (isBlockLevelPending(pending, openListItemFirstLine) ||
        isParagraphContinuationPending(split))
    ) {
      syncBlockPendingDom(completedEl, split, pendingInner, true)
      syncInlinePendingDom(pendingEl, '', false)
      this.pendingFast = armPendingFastPath(
        completedEl,
        split,
        isParagraphContinuationPending(split),
      )
    } else {
      // Include `list-items`: when a pending list tail becomes fully held on a
      // later frame (`- ~~` → `- ~~[`, the tildes now held), the pending `<li>`
      // (and its wrapper `<ul>`) from the prior frame must be swept, or it
      // persists as stale content that diverges from a fresh render (#108).
      clearBlockPendingDom(completedEl, [
        'continuation',
        'paragraph-continuation',
        'list-items',
        'direct-blocks',
      ])
      syncInlinePendingDom(pendingEl, pendingInner, pendingVisible)
    }
  }

  private syncCommittedTableRow(
    complete: string,
    pending: string,
    completeTokens?: BlockToken[],
  ): void {
    // The direct reference to the row-hosting table is the cleanup backstop:
    // even if the trailing walk no longer reaches that table, the stale
    // pending row it hosts is still removed.
    const table = this.findLastCommittedTable() ?? this.pendingRowTable
    if (!table) return

    if (pendingLineBelongsInTable(complete, pending, completeTokens)) {
      syncPendingTableRowDom(table, pending)
      this.pendingRowTable = table
      return
    }
    removePendingTableRow(table)
    this.pendingRowTable = null
  }

  /**
   * The trailing committed `<table>`, found by walking the last-element-child
   * chain — never the selector engine. A pending body row only ever targets
   * the TRAILING table (`pendingLineBelongsInTable` gates on the last block
   * token being a table), and a stale pending row can only live in a table
   * that was trailing when the row was attached (a frozen table never hosts
   * one, and the tail morph sweeps rows when the table settles) — so the old
   * whole-subtree `querySelectorAll('table')`, which ran on EVERY update of a
   * pipe-bearing stream and cost ~20% of the jsdom benchmark inside the
   * selector engine, is replaced by an O(depth) walk. The chain descends so a
   * table inside a re-rooted open container (ADR 0004 Phase 2) is still
   * found; a trailing footnotes section is skipped (the content precedes it).
   */
  private findLastCommittedTable(): HTMLTableElement | null {
    let el: Element | null = this.completedEl ? tailContentElement(this.completedEl) : null
    for (; el; el = el.lastElementChild) {
      if (el.tagName === 'TABLE') return el as HTMLTableElement
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
    this.pendingFast = null
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
