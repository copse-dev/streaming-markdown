import { browserSanitizerBackend, isBrowserSanitizerSupported } from './sanitize-browser.ts'

// Defense-in-depth over the hand-assembled HTML that `renderMarkdown()` emits.
// The renderer already escapes prose and validates link hrefs, but it builds
// HTML by string concatenation, which is inherently fragile. Passing every
// rendered fragment through a vetted sanitizer before it reaches `innerHTML`
// guarantees that anything outside the small, known set of tags/attributes the
// renderer is supposed to produce — including any payload that slips through the
// regex assembly — is stripped.
//
// The sanitizer itself is pluggable (see {@link SanitizerBackend}). Two backends
// ship with the package: the browser's native Sanitizer API (zero-dependency,
// the default when available) and a DOMPurify backend for Node/older browsers
// (`@copse/streaming-markdown/sanitizers/dompurify`). Keeping DOMPurify behind an
// opt-in module means hosts that use the native API never pull it into their
// bundle.
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
  // below, and the core element gate drops any non-checkbox `<input>`, so no
  // interactive/form payload can survive.
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
  // GFM table column alignment (`<th align>`/`<td align>`) — presentational, no XSS surface.
  'align',
  // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
  'type',
  'checked',
  'disabled',
]

/**
 * Normalized sanitizer request handed to a {@link SanitizerBackend}. The core
 * merges its own allowlist with any {@link SanitizeExtension} before calling the
 * backend, and folds the read-only task-list `<input>` gate and the host's
 * per-element hook into a single {@link SanitizerConfig.onElement} callback the
 * backend must invoke for every element it keeps.
 */
export interface SanitizerConfig {
  allowedTags: readonly string[]
  allowedAttr: readonly string[]
  /**
   * Runs for every element the backend keeps, after attribute filtering. It may
   * mutate the node (drop attributes) or remove it entirely; a backend must
   * honour removals. Called with the element and its lowercased tag name.
   */
  onElement?: (node: Element, tagName: string) => void
}

/**
 * Pluggable HTML sanitizer. A backend takes an untrusted HTML string and the
 * narrow {@link SanitizerConfig} allowlist and returns a sanitized HTML string,
 * dropping every tag/attribute outside the allowlist and invoking
 * {@link SanitizerConfig.onElement} for each element it keeps.
 *
 * Swap the active backend with {@link setSanitizerBackend}. The package ships
 * {@link browserSanitizerBackend} (native Sanitizer API, the default) and, behind
 * the `@copse/streaming-markdown/sanitizers/dompurify` entry point, a DOMPurify
 * backend for environments without the native API.
 */
export interface SanitizerBackend {
  sanitize(html: string, config: SanitizerConfig): string
  /**
   * Optional node path: parse and sanitize `html` directly into `target`'s
   * children, replacing whatever was there. Skips the serialize→re-parse round
   * trip of the string path (one parse per sink write instead of two) and never
   * touches an HTML injection sink, so Trusted Types enforcement needs no
   * policy on this path. Must apply the same allowlist and
   * {@link SanitizerConfig.onElement} gate as {@link sanitize} — the two paths
   * must produce identically-serializing trees. Backends that omit it are
   * fully supported: sinks fall back to the string path (sanitize → bless via
   * the Trusted Types policy → `innerHTML`).
   */
  sanitizeInto?(target: Element, html: string, config: SanitizerConfig): void
}

let sanitizerBackend: SanitizerBackend | null = null

/**
 * Swap the sanitizer implementation used by {@link sanitizeRenderedMarkdown}.
 * Pass `null` to fall back to the built-in default (the native browser Sanitizer
 * API when available). Set this once, before the first sink render — e.g. to the
 * DOMPurify backend in Node/jsdom or older browsers:
 *
 * ```ts
 * import { setSanitizerBackend } from '@copse/streaming-markdown'
 * import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'
 * setSanitizerBackend(dompurifyBackend)
 * ```
 */
export function setSanitizerBackend(backend: SanitizerBackend | null): void {
  sanitizerBackend = backend
}

/**
 * Host extension to the sanitizer's allowlist. A host that injects a
 * {@link RawImageRenderer} (or otherwise emits tags/attributes outside the core
 * renderer's output) widens the sink here so its markup survives sanitization —
 * these stay the security gate, so keep additions as narrow as the injected
 * output. `onElement` runs for every element (the core already gates the
 * task-list `<input>`), letting the host drop or lock down its own tags (e.g.
 * remove any non-artifact `<img>` and strip its `src`).
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

// The single per-element gate the active backend runs for every kept element.
// Backend-independent so the security posture is identical across DOMPurify and
// the native Sanitizer API.
function gateElement(node: Element, tagName: string): void {
  if (tagName === 'input') {
    // Only the renderer's read-only task-list checkbox is allowed; drop any
    // other `<input>` (text fields, buttons, image inputs) entirely and force
    // the checkbox read-only so it can never be a real form control.
    if (node.getAttribute('type') !== 'checkbox') {
      node.remove()
      return
    }
    node.setAttribute('disabled', '')
    return
  }
  // Host-specific gating (e.g. a remote-artifact `<img>` policy) runs here.
  sanitizeExtension?.onElement?.(node, tagName)
}

function resolveBackend(): SanitizerBackend {
  if (sanitizerBackend) return sanitizerBackend
  if (isBrowserSanitizerSupported()) return browserSanitizerBackend
  throw new Error(
    'No HTML sanitizer backend is available. Call setSanitizerBackend() before ' +
      'rendering — e.g. `import { dompurifyBackend } from ' +
      '"@copse/streaming-markdown/sanitizers/dompurify"` in Node/jsdom or older ' +
      'browsers — or run where the native Sanitizer API (Element.setHTML) exists.',
  )
}

const DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a);/gi
// The same pattern in *decoded* DOM data: serialized `&amp;nbsp;` is the text
// (or attribute value) `&nbsp;` once parsed.
const DOUBLE_ENCODED_NBSP_DATA_RE = /&(?:nbsp|#160|#x0*a);/gi

// NodeFilter.SHOW_TEXT — numeric so no NodeFilter global is required.
const SHOW_TEXT = 0x4

// Node-path equivalent of the string-path DOUBLE_ENCODED_NBSP_RE replace: the
// string version rewrites the serialized markup (text and attribute values
// alike), so walk both here to keep the two paths byte-identical.
function normalizeDoubleEncodedNbsp(root: Element): void {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as CharacterData
    const replaced = text.data.replace(DOUBLE_ENCODED_NBSP_DATA_RE, '\u00a0')
    if (replaced !== text.data) text.data = replaced
  }
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const replaced = attr.value.replace(DOUBLE_ENCODED_NBSP_DATA_RE, '\u00a0')
      if (replaced !== attr.value) el.setAttribute(attr.name, replaced)
    }
  }
}

function buildSanitizerConfig(): SanitizerConfig {
  const extension = sanitizeExtension
  const allowedTags = extension?.allowedTags
    ? [...ALLOWED_TAGS, ...extension.allowedTags]
    : ALLOWED_TAGS
  const allowedAttr = extension?.allowedAttr
    ? [...ALLOWED_ATTR, ...extension.allowedAttr]
    : ALLOWED_ATTR
  return { allowedTags, allowedAttr, onElement: gateElement }
}

/** Sanitize rendered-markdown HTML before it is assigned to `innerHTML`. */
export function sanitizeRenderedMarkdown(html: string): string {
  const sanitized = resolveBackend().sanitize(html, buildSanitizerConfig())
  // Any path that escaped a model-emitted &nbsp; before decode would surface literal
  // "&nbsp;" text; normalize those back to real NBSP before innerHTML assignment.
  return sanitized.replace(DOUBLE_ENCODED_NBSP_RE, '\u00a0')
}

/**
 * Node-path variant of {@link sanitizeRenderedMarkdown}: parse and sanitize
 * `html` directly into `target`'s children via the backend's
 * {@link SanitizerBackend.sanitizeInto}, skipping the serialize→re-parse round
 * trip (and any `innerHTML` sink). Returns `false` when the active backend does
 * not implement the node path — the caller falls back to the string path.
 */
export function sanitizeRenderedMarkdownInto(target: Element, html: string): boolean {
  const backend = resolveBackend()
  if (!backend.sanitizeInto) return false
  backend.sanitizeInto(target, html, buildSanitizerConfig())
  normalizeDoubleEncodedNbsp(target)
  return true
}
