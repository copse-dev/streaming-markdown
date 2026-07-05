import type { SanitizerBackend, SanitizerConfig } from './sanitize.ts'

// Zero-dependency sanitizer backend built on the native Sanitizer API
// (`Element.setHTML`). This is the default backend and pulls no third-party code
// into the bundle. The native call does the security-critical parse (it strips
// scripts, event-handler attributes, and unsafe URLs); a strict allowlist walk
// then narrows the result to exactly the tags/attributes the renderer produces
// and runs the core/host per-element gate — identical posture to the DOMPurify
// backend.

// `setHTML` is a recent addition and may be missing from the ambient DOM lib.
type SetHTMLElement = Element & {
  setHTML: (html: string) => void
}

/**
 * Whether the native Sanitizer API (`Element.setHTML`) is usable in the current
 * environment. The core falls back to this backend when no other is registered
 * and this returns `true`; jsdom/Node and older browsers return `false`.
 */
export function isBrowserSanitizerSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof (Element.prototype as Partial<SetHTMLElement>).setHTML === 'function'
  )
}

// Disallowed elements whose text content must be dropped rather than unwrapped
// (mirrors DOMPurify's FORBID_CONTENTS intent for the risky containers). The
// native pre-pass already removes these, but the walk drops their content too so
// it stays safe on its own.
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title'])

function unwrap(el: Element): void {
  const parent = el.parentNode
  if (parent) {
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
  }
  el.remove()
}

/**
 * Narrow an already-parsed subtree to the {@link SanitizerConfig} allowlist:
 * drop disallowed tags (keeping benign text content), strip disallowed
 * attributes, and run `onElement` for every kept element. Exported for testing;
 * the full backend runs this after the native Sanitizer parse.
 */
export function enforceSanitizerAllowlist(root: ParentNode, config: SanitizerConfig): void {
  const allowedTags = new Set(config.allowedTags.map((t) => t.toLowerCase()))
  const allowedAttr = new Set(config.allowedAttr.map((a) => a.toLowerCase()))
  // Snapshot in document order (parents before children); we mutate as we go.
  for (const el of Array.from(root.querySelectorAll('*'))) {
    // Skip nodes already detached by an earlier removal/unwrap this pass.
    if (!root.contains(el)) continue
    const tag = el.tagName.toLowerCase()
    if (!allowedTags.has(tag)) {
      if (DROP_CONTENT_TAGS.has(tag)) el.remove()
      else unwrap(el)
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      if (!allowedAttr.has(attr.name.toLowerCase())) el.removeAttribute(attr.name)
    }
    config.onElement?.(el, tag)
  }
}

export const browserSanitizerBackend: SanitizerBackend = {
  sanitize(html: string, config: SanitizerConfig): string {
    const host = document.createElement('div')
    // Safe by default: the native Sanitizer removes scripts, event handlers, and
    // unsafe URLs before we narrow to the allowlist below.
    ;(host as unknown as SetHTMLElement).setHTML(html)
    enforceSanitizerAllowlist(host, config)
    return host.innerHTML
  },
}
