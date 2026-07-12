// Direct DOM lookups for the streaming hot path (#197): the `:scope > tag.cls`
// style selector queries as plain pointer walks. The per-update path must
// never enter the CSS selector engine — profiling showed it at ~20% of the
// jsdom benchmark before these replaced the query call sites — so every
// "find the forming/pending element" lookup goes through these helpers.
// Dependency-free leaf on purpose.

function childMatches(el: Element, tagName: string | null, cls: string | null): boolean {
  return (tagName === null || el.tagName === tagName) && (cls === null || el.classList.contains(cls))
}

/** First direct child matching `tagName` (upper-case) and/or `cls`, in document order. */
export function firstDirectChild(host: Element, tagName: string | null, cls: string | null): Element | null {
  for (let el = host.firstElementChild; el; el = el.nextElementSibling) {
    if (childMatches(el, tagName, cls)) return el
  }
  return null
}

/** Last direct child matching `tagName` (upper-case) and/or `cls` (backwards scan). */
export function lastDirectChild(host: Element, tagName: string | null, cls: string | null): Element | null {
  for (let el = host.lastElementChild; el; el = el.previousElementSibling) {
    if (childMatches(el, tagName, cls)) return el
  }
  return null
}

/** First descendant matching `cls` (optionally tag-restricted), document-order DFS. */
export function findDescendantByClass(root: Element, cls: string, tagName?: string): Element | null {
  for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
    if (childMatches(el, tagName ?? null, cls)) return el
    const nested = findDescendantByClass(el, cls, tagName)
    if (nested) return nested
  }
  return null
}
