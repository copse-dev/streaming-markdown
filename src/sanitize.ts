import DOMPurify from 'dompurify'

// Defense-in-depth over the hand-assembled HTML that `renderMarkdown()` emits.
// The renderer already escapes prose and validates link hrefs, but it builds
// HTML by string concatenation, which is inherently fragile. Passing every
// rendered fragment through DOMPurify (a vetted, fuzzed sanitizer) before it
// reaches `innerHTML` guarantees that anything outside the small, known set of
// tags/attributes the renderer is supposed to produce — including any payload
// that slips through the regex assembly — is stripped.
//
// The allowlist is intentionally narrow: it mirrors exactly what the renderer
// outputs (prose + GFM tables + highlighted code + mermaid scaffolding). Mermaid
// SVG is generated later, directly by the mermaid library, so it never passes
// through here.
const ALLOWED_TAGS = [
  'a',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'code',
  'pre',
  'span',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  // Benign raw inline HTML the renderer passes through unescaped (see
  // BENIGN_RAW_INLINE_TAG_RE in escape.ts) — attribute-less phrasing tags only.
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'kbd',
  'mark',
  // GFM task-list checkboxes (#614). The renderer only ever emits the fixed,
  // read-only form `<input type="checkbox" disabled [checked]>` inside an
  // `<li class="task-list-item">`. Only `type`/`checked`/`disabled` are allowed
  // below, and the `uponSanitizeElement` hook drops any non-checkbox `<input>`,
  // so no interactive/form payload can survive.
  'input',
]

// `data-browser-link` flags links the renderer routes through the in-app browser
// (see `browser-links.ts`); `class` carries highlight.js and mermaid hooks.
const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'class',
  'data-browser-link',
  'data-workspace-link',
  'data-ordered-marker',
  // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
  'type',
  'checked',
  'disabled',
]

/**
 * Host extension to the sanitizer's allowlist. A host that injects a
 * {@link RawImageRenderer} (or otherwise emits tags/attributes outside the core
 * renderer's output) widens the sink here so its markup survives sanitization —
 * these stay the security gate, so keep additions as narrow as the injected
 * output. `onElement` runs in DOMPurify's `uponSanitizeElement` for every element
 * (the core already gates the task-list `<input>`), letting the host drop or lock
 * down its own tags (e.g. remove any non-artifact `<img>` and strip its `src`).
 */
export interface SanitizeExtension {
  allowedTags?: readonly string[]
  allowedAttr?: readonly string[]
  onElement?: (node: Element, tagName: string) => void
}

let sanitizeExtension: SanitizeExtension | null = null

/** Inject a host {@link SanitizeExtension}; pass `null` to restore the core allowlist. */
export function setSanitizeExtension(extension: SanitizeExtension | null): void {
  sanitizeExtension = extension
}

let elementHookInstalled = false

function installElementHook(): void {
  if (elementHookInstalled) return
  elementHookInstalled = true
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    const el = node as Element
    if (data.tagName === 'input') {
      // Only the renderer's read-only task-list checkbox is allowed; drop any
      // other `<input>` (text fields, buttons, image inputs) entirely and force
      // the checkbox read-only so it can never be a real form control.
      if (el.getAttribute('type') !== 'checkbox') {
        el.remove()
        return
      }
      el.setAttribute('disabled', '')
      return
    }
    // Host-specific gating (e.g. a remote-artifact `<img>` policy) runs here.
    sanitizeExtension?.onElement?.(el, data.tagName)
  })
}

const DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a);/gi

/** Sanitize rendered-markdown HTML before it is assigned to `innerHTML`. */
export function sanitizeRenderedMarkdown(html: string): string {
  installElementHook()
  const extension = sanitizeExtension
  const allowedTags = extension?.allowedTags
    ? [...ALLOWED_TAGS, ...extension.allowedTags]
    : ALLOWED_TAGS
  const allowedAttr = extension?.allowedAttr
    ? [...ALLOWED_ATTR, ...extension.allowedAttr]
    : ALLOWED_ATTR
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttr,
  })
  // Any path that escaped a model-emitted &nbsp; before decode would surface literal
  // "&nbsp;" text; normalize those back to real NBSP before innerHTML assignment.
  return sanitized.replace(DOUBLE_ENCODED_NBSP_RE, '\u00A0')
}
