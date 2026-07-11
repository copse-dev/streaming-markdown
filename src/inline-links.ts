import { decodeEscapedPunctuationRaw } from './backslash-escapes.ts'
import { decodeEscapedHref, escapeHtml } from './escape.ts'
import { isWorkspaceMarkdownLinkHref } from './workspace-link-href.ts'
import {
  decodeEscapes,
  decodeHtmlCharRefs,
  isValidReferenceLabel,
  lookupLinkReference,
  normalizeReferenceLabel,
  type LinkReference,
  type LinkReferenceMap,
  parseInlineLinkDestination,
  parseReferenceLabel,
  percentEncodeHref,
} from './link-references.ts'

export type LinkLabelRenderer = (label: string, refs: LinkReferenceMap) => string

/**
 * Applies the inline passes that run BEFORE link rendering (escapes, code,
 * autolinks, emphasis, strikethrough) to a raw string — see
 * {@link lookupWithRenderedLabels}. Supplied by inline-spans.ts so the pipeline
 * stays defined in one place.
 */
export type LabelMatchRenderer = (label: string) => string

/** Per-reference-map cache of the rendered-label index (maps are per render). */
const renderedLabelIndexCache = new WeakMap<object, Map<string, LinkReference>>()

/**
 * Reference lookup that tolerates labels already carrying rendered inline HTML.
 * Emphasis runs before links in the string pipeline, so `[*foo* bar]` reaches
 * the link pass as `[<em>foo</em> bar]` and misses the raw-label map (spec
 * 554/558/585). Fallback: index every definition label through the same
 * pre-link pipeline and match the observed label against that form.
 */
function lookupWithRenderedLabels(
  refs: LinkReferenceMap,
  label: string,
  renderForMatch: LabelMatchRenderer | undefined,
): LinkReference | undefined {
  const direct = lookupLinkReference(refs, label)
  if (direct || !renderForMatch || !label.includes('<') || !isValidReferenceLabel(label)) {
    return direct
  }
  let index = renderedLabelIndexCache.get(refs)
  if (!index) {
    index = new Map()
    for (const [key, ref] of refs) {
      const renderedKey = normalizeReferenceLabel(decodeEscapes(renderForMatch(key)))
      if (!index.has(renderedKey)) index.set(renderedKey, ref)
    }
    renderedLabelIndexCache.set(refs, index)
  }
  return index.get(normalizeReferenceLabel(decodeEscapes(label)))
}

/**
 * Default URL schemes permitted on a link/image destination. Anything carrying
 * a scheme outside the active set — `javascript:`, `data:`, `vbscript:`,
 * `file:`, and every unknown scheme — is rejected. An allowlist fails *closed*:
 * a new dangerous scheme is blocked by default, unlike a denylist that only
 * knows the three it was told about. Relative/absolute paths, fragments, and
 * query-only destinations carry no scheme and are always allowed.
 */
export const DEFAULT_SAFE_HREF_SCHEMES: readonly string[] = [
  'http',
  'https',
  'mailto',
  'tel',
  'sms',
  'ftp',
  'ftps',
]

const HREF_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

let activeSafeHrefSchemes: ReadonlySet<string> = new Set(DEFAULT_SAFE_HREF_SCHEMES)

/**
 * Override the scheme allowlist {@link safeLinkHref} enforces; pass `null` to
 * restore {@link DEFAULT_SAFE_HREF_SCHEMES}. Scheme names are matched
 * case-insensitively (normalized on the way in), so `['HTTPS']` allows
 * `https:`.
 *
 * This allowlist is the security gate against `javascript:`/`data:` XSS in link
 * destinations. Narrowing it (e.g. `['https', 'mailto']`) is always safe;
 * widening it re-opens that class of attack, so add only schemes that are inert
 * as an `href` — never `javascript`, `data`, `vbscript`, or `file`.
 */
export function setSafeHrefSchemes(schemes: Iterable<string> | null): void {
  activeSafeHrefSchemes =
    schemes === null
      ? new Set(DEFAULT_SAFE_HREF_SCHEMES)
      : new Set(Array.from(schemes, (scheme) => scheme.toLowerCase()))
}

/** The scheme allowlist currently enforced by {@link safeLinkHref}. */
export function getSafeHrefSchemes(): string[] {
  return [...activeSafeHrefSchemes]
}

/** True when `href` is a relative destination or carries an allowlisted scheme. */
function isAllowedHref(href: string): boolean {
  const scheme = HREF_SCHEME_RE.exec(href)?.[1]
  return scheme === undefined || activeSafeHrefSchemes.has(scheme.toLowerCase())
}

/** Allowed link destinations: http(s), mailto, and relative/path forms. Rejects dangerous schemes. */
export function safeLinkHref(raw: string): string | null {
  // Resolve to the exact string the browser will act on *before* validating:
  // undo source HTML-escaping and PUA-escaped punctuation, then decode HTML
  // character references. Checking the raw string first let `&#x6a;avascript:`
  // slip past the scheme test and only decode to a live `javascript:` URL when
  // percent-encoding ran afterwards. Validate the decoded form, then encode it
  // directly (no second entity-decode pass) so nothing re-hides a scheme.
  const href = decodeHtmlCharRefs(decodeEscapedPunctuationRaw(decodeEscapedHref(raw))).trim()
  if (!isAllowedHref(href)) return null
  return percentEncodeHref(href)
}

/** Resolved link the {@link LinkDecorator} decorates. `href` is already safe/encoded. */
export interface LinkDecoration {
  href: string
  /** True when the destination is an in-workspace path (not http/mailto). */
  isWorkspace: boolean
  title?: string
}

/**
 * Host hook that returns the attribute string appended after `href` on a
 * rendered `<a>` (e.g. ` target="_blank" rel="…" data-browser-link="true"`).
 * Keeps app-specific link decoration out of the parser core so the package can
 * be hosted elsewhere (#601). Install with {@link setLinkDecorator}.
 */
export type LinkDecorator = (link: LinkDecoration) => string

/**
 * Built-in default decorator — neutral, host-agnostic output (#112). It emits
 * only a `title` attribute when the link carries one and nothing else: no
 * `target`, no `rel`, no `class`, and no `data-*` routing hooks. A general
 * "just render this" consumer gets plain CommonMark-shaped anchors and opts into
 * host semantics explicitly via {@link setLinkDecorator}.
 */
export const neutralLinkDecorator: LinkDecorator = ({ title }) =>
  title ? ` title="${escapeHtml(title)}"` : ''

/**
 * Copse app's workspace/browser routing decorator (#112). `data-workspace-link`
 * / `data-browser-link` flag links for `workspace-links.ts` / `browser-links.ts`
 * and external links open in a new context. This is host-specific and lives
 * behind the `@copse/streaming-markdown/host/workspace` entry; a host that wants
 * the pre-0.10 in-app behaviour restores it with a single call:
 * `setLinkDecorator(appLinkDecorator)`.
 */
export const appLinkDecorator: LinkDecorator = ({ isWorkspace, title }) => {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return isWorkspace
    ? ` class="workspace-markdown-link" data-workspace-link="true"${titleAttr}`
    : ` target="_blank" rel="noopener noreferrer" data-browser-link="true"${titleAttr}`
}

let activeLinkDecorator: LinkDecorator = neutralLinkDecorator

/**
 * Inject a host {@link LinkDecorator}; pass `null` to restore the neutral
 * built-in default ({@link neutralLinkDecorator}).
 *
 * Note: rendered `<a>` output still passes the escape allowlist
 * (`SAFE_OUTER_TAG_RE` in `escape.ts`) and, at the host sink, DOMPurify
 * (`sanitize.ts`). A decorator that emits attribute *names* outside those
 * allowlists will have them stripped/escaped — widen both allowlists to match a
 * custom decorator's vocabulary (they are the security gate, by design).
 */
export function setLinkDecorator(decorator: LinkDecorator | null): void {
  activeLinkDecorator = decorator ?? neutralLinkDecorator
}

/** Render an `<a>` for a resolved link, applying the active {@link LinkDecorator}. */
export function renderAnchor(label: string, href: string, title?: string): string {
  // Compute `isWorkspace` lazily (#146): it is workspace-host-specific residue in
  // the neutral core — the built-in `neutralLinkDecorator` never reads it, so the
  // per-anchor `isWorkspaceMarkdownLinkHref` URL scan runs only when a host
  // decorator (e.g. `appLinkDecorator`) actually consults it. Memoized so a
  // decorator reading it twice still scans once.
  let workspace: boolean | undefined
  const decoration: LinkDecoration = {
    href,
    get isWorkspace(): boolean {
      return (workspace ??= isWorkspaceMarkdownLinkHref(href))
    },
    // `exactOptionalPropertyTypes`: omit `title` rather than pass an explicit undefined.
    ...(title === undefined ? {} : { title }),
  }
  const attrs = activeLinkDecorator(decoration)
  return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`
}

function renderedLink(label: string, href: string, title?: string): string {
  return renderAnchor(label, href, title)
}

/**
 * Image `alt` is the plain-text content of the label, not markup. The label is
 * already rendered inline HTML here, so pull nested `<img>` alts through and
 * drop every other tag (`![foo *bar*]` → `foo bar`, spec 574/575/577). The
 * decode/re-escape keeps a single level of entity encoding on nested alts.
 */
function imageAltText(renderedLabel: string): string {
  return renderedLabel
    .replace(/<img\b[^>]*?\salt="([^"]*)"[^>]*>/gi, (_match, nested: string) =>
      decodeEscapedHref(nested),
    )
    .replace(/<[^>]*>/g, '')
}

function renderedImage(alt: string, src: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltText(alt))}"${titleAttr} data-md-rendered="1" />`
}

function renderLinkLabel(
  label: string,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
): string {
  // Label text stays PUA-encoded through nested rendering (inert to all
  // passes); the outer decode pass restores the literal punctuation.
  return renderLabel(label, refs)
}

/** A complete rendered anchor — an autolink that already became `<a>…</a>`. */
const RENDERED_ANCHOR_RE = /<a\b[\s\S]*?<\/a>/i

/** Nested `[` link (not image) inside link label text — forbidden by CommonMark. */
function labelContainsNestedLink(label: string, refs: LinkReferenceMap): boolean {
  // Autolinks render before this pass, so an inner autolink shows up as a
  // rendered `<a>` in the label; the inner link wins over the outer bracket.
  if (RENDERED_ANCHOR_RE.test(label)) return true
  let i = 0
  while (i < label.length) {
    if (label[i] === '!' && label[i + 1] === '[') {
      const image = tryParseLinkOrImage(label, i, refs, (inner) => inner)
      if (image) {
        i = image.end
        continue
      }
    }
    if (label[i] === '[') {
      const parsed = tryParseLinkOrImage(label, i, refs, (inner) => inner, { linksOnly: true })
      if (parsed) return true
    }
    i++
  }
  return false
}

/** True when `!`+`[` or `[` begins a link/image that beats emphasis grouping (#521). */
export function linkOrImageStartsAt(
  text: string,
  start: number,
  refs: LinkReferenceMap = new Map(),
): boolean {
  return tryParseLinkOrImage(text, start, refs, (label) => label) !== null
}

/**
 * End offset (exclusive) of the link/image starting at `start`, or null when
 * none parses there. Used by the emphasis pass to mask whole link spans so
 * delimiters can never pair across a link boundary (spec 474/522/535).
 */
export function linkOrImageEndAt(
  text: string,
  start: number,
  refs: LinkReferenceMap = new Map(),
): number | null {
  return tryParseLinkOrImage(text, start, refs, (label) => label)?.end ?? null
}

/**
 * Bracketed label parse for post-`renderInlineCode`/autolink text: a `]`
 * inside rendered `<code>` (#342, #525, #537) or inside a rendered `<a>`/
 * `<img>` (an autolink whose URL swallowed the `](…)`, spec 526/538) must not
 * close the label.
 */
function parseBracketedLabelOutsideInlineCode(
  text: string,
  start: number,
): { label: string; end: number } | null {
  if (text[start] !== '[') return null
  const shieldRanges = inlineShieldRanges(text)
  let i = start + 1
  let depth = 1
  while (i < text.length && depth > 0) {
    const shieldRange = rangeAt(i, shieldRanges)
    if (shieldRange) {
      i = shieldRange.end
      continue
    }
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') depth--
    i++
  }
  if (depth !== 0) return null
  return { label: text.slice(start + 1, i - 1), end: i }
}

function tryParseLinkOrImage(
  text: string,
  start: number,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
  options: { linksOnly?: boolean; renderForMatch?: LabelMatchRenderer | undefined } = {},
): { html: string; end: number } | null {
  const image = !options.linksOnly && text[start] === '!' && text[start + 1] === '['
  const bracketStart = image ? start + 1 : start
  if (text[bracketStart] !== '[') return null

  const labelPart = parseBracketedLabelOutsideInlineCode(text, bracketStart)
  if (!labelPart) return null

  const j = labelPart.end
  if (text[j] === '(') {
    const dest = parseInlineLinkDestination(text, j)
    if (dest) {
      const href = safeLinkHref(dest.href)
      if (href === null) return null
      if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
      const label = renderLinkLabel(labelPart.label, refs, renderLabel)
      const html = image
        ? renderedImage(label, href, dest.title)
        : renderedLink(label, href, dest.title)
      return { html, end: dest.end }
    }
    // A `(` that is not a valid inline destination does not disqualify the
    // label; fall through and try to resolve it as a shortcut reference so
    // `[foo](not a link)` still links `[foo]` and keeps the parens as text (#568).
  }

  if (text[j] === '[') {
    const refLabel = parseReferenceLabel(text, j, labelPart.label)
    if (!refLabel) return null
    const ref = lookupWithRenderedLabels(refs, refLabel.label, options.renderForMatch)
    if (!ref) return null
    const href = safeLinkHref(ref.href)
    if (href === null) return null
    if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
    const label = renderLinkLabel(labelPart.label, refs, renderLabel)
    const html = image
      ? renderedImage(label, href, ref.title)
      : renderedLink(label, href, ref.title)
    return { html, end: refLabel.end }
  }

  // Shortcut reference: `[label]` only when the whole label resolves.
  const ref = lookupWithRenderedLabels(refs, labelPart.label, options.renderForMatch)
  if (!ref) return null
  const href = safeLinkHref(ref.href)
  if (href === null) return null
  if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
  const label = renderLinkLabel(labelPart.label, refs, renderLabel)
  const html = image ? renderedImage(label, href, ref.title) : renderedLink(label, href, ref.title)
  return { html, end: labelPart.end }
}

/** Render markdown inline links and images, respecting code-span/anchor boundaries. */
export function renderInlineLinks(
  text: string,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
  renderForMatch?: LabelMatchRenderer,
): string {
  const shieldRanges = inlineShieldRanges(text)
  let out = ''
  let i = 0
  while (i < text.length) {
    const shieldRange = rangeAt(i, shieldRanges)
    if (shieldRange) {
      out += text.slice(i, shieldRange.end)
      i = shieldRange.end
      continue
    }
    const imageAt = text[i] === '!' && text[i + 1] === '['
    const linkAt = text[i] === '['
    if (imageAt || linkAt) {
      const parsed = tryParseLinkOrImage(text, i, refs, renderLabel, { renderForMatch })
      if (parsed) {
        out += parsed.html
        i = parsed.end
        continue
      }
    }
    out += text[i] ?? ''
    i++
  }
  return out
}

/** Rendered inline HTML the link scanner treats as opaque (mirrors INLINE_HTML_SHIELD_RE). */
const INLINE_SHIELD_RE = /<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>/g

function inlineShieldRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const match of text.matchAll(INLINE_SHIELD_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function rangeAt(
  index: number,
  ranges: { start: number; end: number }[],
): { start: number; end: number } | undefined {
  return ranges.find((range) => index >= range.start && index < range.end)
}

/** Strip app-specific image attributes for CommonMark conformance comparison. */
export function stripAppImageAttributes(html: string): string {
  return html.replace(/ data-md-rendered="1"/g, '')
}

/** Strip app-specific anchor attributes for CommonMark conformance comparison. */
export function stripAppLinkAttributes(html: string): string {
  return html.replace(/<a\b([^>]*?)>/gi, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s+target\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+rel\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+data-browser-link\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+data-workspace-link\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+class\s*=\s*"workspace-markdown-link"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned ? `<a ${cleaned}>` : '<a>'
  })
}
