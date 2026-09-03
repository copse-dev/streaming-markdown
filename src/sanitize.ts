import { activeConfig } from './config.ts'
import { applyLinkImagePolicy } from './link-image-policy.ts'
import {
  applyUrlPolicy,
  hasUrlPolicy,
  URL_POLICY_MARKER_ATTR,
} from './url-policy.ts'
import { sinkForAttribute, URL_ATTR_NAMES, URL_LIST_ATTR_NAMES } from './url-filter-markup.ts'
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
// outputs (prose + GFM tables + highlighted code + mermaid/math scaffolding —
// the math forms need only div/pre/span + class, already below). Mermaid SVG
// and KaTeX HTML are generated later, directly by their libraries, so they
// never pass through here.
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
  // GFM footnotes (#72): the trailing `<section class="footnotes">` wrapper.
  'section',
]

// `class` carries highlight.js and mermaid hooks; `target`/`rel` support the
// neutral `target="_blank"` decoration a host may opt into. Host-specific link
// routing attributes (e.g. `data-browser-link` / `data-workspace-link`) are NOT
// in the core allowlist (#146): a host that emits them via `appLinkDecorator`
// (`@copse/streaming-markdown/host/workspace`) widens the sink itself through
// `MarkdownConfig.sanitizeExtension` / `setDefaultConfig`.
const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'class',
  'data-ordered-marker',
  // GFM table column alignment (`<th align>`/`<td align>`) — presentational, no XSS surface.
  'align',
  // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
  'type',
  'checked',
  'disabled',
  // GFM footnote anchors (#72): `id="fn-…"`/`id="fnref-…"` jump targets, plus the
  // section's `id="footnote-label"` heading. The element gate below strips any id
  // outside that renderer-emitted shape, so sanitized fragments can never mint
  // arbitrary page-global names.
  'id',
  // GFM footnote / task-list accessibility hooks (#216/#217): `aria-label` on
  // task checkboxes and backrefs, `aria-describedby` linking a ref to the
  // footnotes heading, and the `data-footnote*` semantic markers GitHub emits.
  // All presentational/semantic only — no XSS surface.
  'aria-label',
  'aria-describedby',
  'data-footnotes',
  'data-footnote-ref',
  'data-footnote-backref',
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
 * Swap the backend per render via `MarkdownConfig.sanitizerBackend`, or
 * process-wide with `setDefaultConfig({ sanitizerBackend })`. The package ships
 * {@link browserSanitizerBackend} (native Sanitizer API, the default) and, behind
 * the `@copse/streaming-markdown/sanitizers/dompurify` entry point, a DOMPurify
 * backend for environments without the native API.
 *
 * **Serialization contract.** The streaming emitters splice pending-tail markup
 * into `sanitize`'s output *as a string* — inserting a forming `<li>` before the
 * trailing `</ul>`/`</ol>`, a paragraph-continuation before `</p>`, or a pending
 * row before `</tbody>` (`appendListPendingHtml`, `insertBeforeTrailingListClose`,
 * `appendParagraphContinuationHtml` in `streaming.ts`; `appendPendingTableRowHtml`
 * in `streaming-table-dom.ts`). This assumes the backend emits HTML5-standard
 * serialization: allowlisted block elements closed with their literal end tag
 * (`</ul>`, `</ol>`, `</p>`, `</tbody>`), lowercase tag names, and no gratuitous
 * whitespace or attribute reordering inside those tags. Both bundled backends
 * satisfy this. A custom backend that reserializes differently (self-closing
 * forms, uppercased tags, injected whitespace) can misplace the pending tail —
 * keep serialization HTML5-standard, or the string-surgery seams won't match.
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
   * must produce identically-serializing trees, so parse in a neutral
   * (body/div) context like {@link sanitize} does, not the target's own
   * context. Backends that omit it are fully supported: sinks fall back to the
   * string path (sanitize → bless via the Trusted Types policy → `innerHTML`).
   *
   * If you wrap a bundled backend to customize `sanitize` (e.g.
   * `{ ...dompurifyBackend, sanitize: mySanitize }`), either override
   * `sanitizeInto` consistently or omit it — a spread copies the bundled node
   * path, which sinks prefer, silently bypassing your custom `sanitize`.
   */
  sanitizeInto?(target: Element, html: string, config: SanitizerConfig): void
}

/**
 * The {@link SanitizerBackend} in effect for the current render, or `null` (the
 * native browser Sanitizer). Set it per render via `MarkdownConfig.sanitizerBackend`,
 * or process-wide via `setDefaultConfig({ sanitizerBackend })` — the "install once"
 * seam a Node/jsdom/SSR host uses (e.g. `dompurifyBackend` from
 * `@copse/streaming-markdown/sanitizers/dompurify`).
 */
export function getSanitizerBackend(): SanitizerBackend | null {
  return activeConfig().sanitizerBackend ?? null
}

/**
 * Host extension to the sanitizer's allowlist. A host that injects a
 * {@link RawImageRenderer} (or otherwise emits tags/attributes outside the core
 * renderer's output) widens the sink here so its markup survives sanitization —
 * these stay the security gate, so keep additions as narrow as the injected
 * output. `onElement` runs for every element (the core already gates the
 * task-list `<input>`), letting the host drop or lock down its own tags (e.g.
 * remove any non-artifact `<img>` and strip its `src`). Set it per render via
 * `MarkdownConfig.sanitizeExtension`.
 */
export interface SanitizeExtension {
  allowedTags?: readonly string[]
  allowedAttr?: readonly string[]
  onElement?: (node: Element, tagName: string) => void
}

// The single per-element gate the active backend runs for every kept element.
// Backend-independent so the security posture is identical across DOMPurify and
// the native Sanitizer API.
// The only ids the renderer emits: footnote jump targets (`fn-…`/`fnref-…`, each
// optionally carrying a per-render `footnoteIdPrefix`) and the section's
// `footnote-label` heading (#72/#216). Anything else is stripped so allowlisting
// `id` cannot enable DOM clobbering of arbitrary page-global names.
const FOOTNOTE_ID_RE = /^(?:fn(?:ref)?-[A-Za-z0-9_-]+|[A-Za-z0-9_-]*footnote-label)$/

// Raw-HTML passthrough is the one population of `<a>`/`<img>` the inline
// emitters never touched, so the sink is the only place its URLs can be gated.
// The two populations serialize identically, which is what the marker
// distinguishes (see URL_POLICY_MARKER_ATTR).
function gateUrlPolicy(node: Element, tagName: string): void {
  if (!hasUrlPolicy() || typeof node.getAttribute !== 'function') return
  if (node.hasAttribute(URL_POLICY_MARKER_ATTR)) {
    node.removeAttribute(URL_POLICY_MARKER_ATTR)
    return
  }
  // Every URL-bearing attribute, on any element — the same classifier the
  // post-sink walker uses. Naming `a`/`img` here instead left `srcset` and
  // `poster` unpoliced whenever a host widened the allowlist to admit them.
  for (const attr of Array.from(node.attributes)) {
    const local = (attr.localName || attr.name).toLowerCase()
    const isList = URL_LIST_ATTR_NAMES.has(local)
    if (!isList && !URL_ATTR_NAMES.has(local)) continue
    if (attr.value === '') continue
    const decided = isList
      ? filterUrlList(attr.value, tagName, local)
      : applyUrlPolicy(attr.value, sinkForAttribute(tagName, local), 'markdown', tagName, attr.name)
    if (decided === null) node.removeAttribute(attr.name)
    else if (decided !== attr.value) node.setAttribute(attr.name, decided)
  }
}

/** Comma-separated candidate list (`srcset`), policed per candidate. */
function filterUrlList(value: string, tagName: string, local: string): string | null {
  const kept: string[] = []
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const space = trimmed.search(/\s/)
    const url = space === -1 ? trimmed : trimmed.slice(0, space)
    const descriptor = space === -1 ? '' : trimmed.slice(space)
    const decided = applyUrlPolicy(url, 'image', 'markdown', tagName, local)
    if (decided !== null) kept.push(decided + descriptor)
  }
  return kept.length === 0 ? null : kept.join(', ')
}

function gateElement(node: Element, tagName: string): void {
  // The DOMPurify backend's hook also fires for text/comment nodes, which
  // carry no attributes — only real elements have an id to gate.
  if (typeof node.getAttribute === 'function') {
    const id = node.getAttribute('id')
    if (id !== null && !FOOTNOTE_ID_RE.test(id)) node.removeAttribute('id')
  }
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
  // Host URL policy (opt-in, off by default) for destinations that did NOT come
  // from the inline emitters — i.e. raw HTML passed through to the sink, which
  // never met `safeLinkHref`. Renderer-emitted links carry the marker and were
  // decided already; consume it so no attacker-visible attribute survives.
  gateUrlPolicy(node, tagName)
  // Core link/image origin policy (opt-in, off by default) — a no-op unless a
  // policy is installed. Runs before the host hook so the host sees the already
  // origin-vetted `<a>`/`<img>`, and composes with (never replaces) it.
  applyLinkImagePolicy(node, tagName)
  // Host-specific gating (e.g. a remote-artifact `<img>` policy) runs here.
  activeConfig().sanitizeExtension?.onElement?.(node, tagName)
}

function resolveBackend(): SanitizerBackend {
  const backend = getSanitizerBackend()
  if (backend) return backend
  if (isBrowserSanitizerSupported()) return browserSanitizerBackend
  throw new Error(
    'No HTML sanitizer backend is available. Pass `sanitizerBackend` in the render ' +
      'config, or install one process-wide with ' +
      '`setDefaultConfig({ sanitizerBackend })` — e.g. `import { dompurifyBackend } ' +
      'from "@copse/streaming-markdown/sanitizers/dompurify"` in Node/jsdom or older ' +
      'browsers — or run where the native Sanitizer API (Element.setHTML) exists.',
  )
}

// `#x0*a0` is the hex NBSP (U+00A0); `#x0*a` would be the LF escape `&#xa;`,
// which must NOT be rewritten (review finding on the earlier pattern).
const DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a0);/gi
// The same pattern in *decoded* DOM data: serialized `&amp;nbsp;` is the text
// (or attribute value) `&nbsp;` once parsed.
const DOUBLE_ENCODED_NBSP_DATA_RE = /&(?:nbsp|#160|#x0*a0);/gi

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
  const extension = activeConfig().sanitizeExtension
  const allowedTags = extension?.allowedTags
    ? [...ALLOWED_TAGS, ...extension.allowedTags]
    : ALLOWED_TAGS
  const extensionAttr = extension?.allowedAttr
    ? [...ALLOWED_ATTR, ...extension.allowedAttr]
    : ALLOWED_ATTR
  // The marker has to survive the backend's attribute filter long enough for the
  // gate to read it; the gate then removes it, so it never reaches the DOM.
  const allowedAttr = hasUrlPolicy() ? [...extensionAttr, URL_POLICY_MARKER_ATTR] : extensionAttr
  return { allowedTags, allowedAttr, onElement: gateElement }
}

declare const SANITIZED_HTML_BRAND: unique symbol

/**
 * HTML that is safe to hand to the presanitized sink: it came out of
 * {@link sanitizeRenderedMarkdown}, or was composed from such output plus
 * literal allowlisted markup at an audited {@link asSanitizedHtml} site.
 *
 * The brand is compile-time only (a `SanitizedHtml` IS a `string` at runtime
 * and assignable wherever a string is expected); its purpose is the reverse
 * direction — an arbitrary string cannot flow into `setPresanitizedHtml`
 * without either passing through the sanitizer or an explicit, greppable
 * `asSanitizedHtml` assertion.
 */
export type SanitizedHtml = string & { readonly [SANITIZED_HTML_BRAND]: true }

/**
 * Assert that `html` is sanitizer-equivalent without re-sanitizing. Internal
 * escape hatch for the audited composition sites — wrapping sanitized
 * fragments in literal allowlisted tags, or joining sanitized parts with
 * literal seams. Every call site must be justifiable as "sanitizer output +
 * markup this codebase wrote"; new call sites are a review flag. Not exported
 * from the package entry point.
 */
export function asSanitizedHtml(html: string): SanitizedHtml {
  return html as SanitizedHtml
}

/** Sanitize rendered-markdown HTML before it is assigned to `innerHTML`. */
export function sanitizeRenderedMarkdown(html: string): SanitizedHtml {
  const sanitized = resolveBackend().sanitize(html, buildSanitizerConfig())
  // Any path that escaped a model-emitted &nbsp; before decode would surface literal
  // "&nbsp;" text; normalize those back to real NBSP before innerHTML assignment.
  return asSanitizedHtml(sanitized.replace(DOUBLE_ENCODED_NBSP_RE, '\u00a0'))
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
  // Decoded `&nbsp;`-style text can only come from an escaped ampersand in the
  // input (`&amp;…`, `&#38;…`, …), and every escape of `&` contains a literal
  // `&` — so when the input has none, skip the whole normalization walk. This
  // keeps the per-token hot path allocation-free for ordinary prose.
  if (html.includes('&')) normalizeDoubleEncodedNbsp(target)
  return true
}
