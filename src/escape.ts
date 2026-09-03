import { decodeEscapedPunctuationRaw } from './backslash-escapes.ts'
import { getHtmlPolicy, type HtmlPolicy } from './html-policy.ts'
import { decodeHtmlCharRefs } from './link-references.ts'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Order-independent HTML text encoder. A single pass over a character class
 * (with `&` handled by the same regex) avoids the escape-ordering coupling that
 * an earlier `.replace('&').replace('<')...` chain depended on, and also encodes
 * quotes so untrusted text can never break out into an attribute context.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/**
 * Renderer-generated tags that survive the text-escaping pass, matched by SHAPE.
 * The `<a>` arm admits any `data-*` attribute (value optional, as in the
 * renderer's own valueless `data-footnote-ref`) rather than a list of names:
 * #146 evicted the host-specific `data-browser-link` / `data-workspace-link`
 * from both allowlists but gave only the sink a replacement hook, so a host
 * `linkDecorator` emitting them had its whole `<a …>` escaped to literal text
 * while the matching `</a>` (a separate arm) survived, leaving a stray close
 * tag. `isSanctionedRendererTag` re-validates content either way, and anything
 * this misses degrades through {@link narrowAnchor} instead of being destroyed.
 */
// Regex *literals*, not `new RegExp` over a shared source string: this module is
// pulled in by entries that want only `escapeHtml` (the shiki highlighter, say),
// and a literal tree-shakes out of those bundles where a constructed one does
// not. `data-attributes.test.ts` pins these against `DATA_ATTR_NAME_SOURCE` so
// the duplicated `data-*` shape still cannot drift.
const SAFE_OUTER_TAG_RE =
  /^(?:<a(?:\s+href="[^"]*")(?:\s+(?:(?:title|target|rel|class)="[^"]*"|data-[a-z0-9-]+(?:="[^"]*")?))*\s*>|<\/(?:a|code|em|strong)>|<(?:code|em|strong)\b[^>]*>|<img\b[^>]*\bdata-md-rendered="1"[^>]*\/?>)$/i

/**
 * Benign raw inline HTML models emit in prose (strikethrough, sub/superscript,
 * keyboard keys, explicit breaks). Attribute-less phrasing tags only — anything
 * with attributes, and all block/structural tags, stays escaped. The DOMPurify
 * sink allowlist (`sanitize.ts`) mirrors this set.
 */
const BENIGN_RAW_INLINE_TAG_RE = /^<\/?(?:b|i|u|s|del|ins|sub|sup|kbd|mark|br)\s*\/?>$/i

/**
 * The only raw tag `'escape-all'` keeps: an explicit line break. Void, so it
 * can never unbalance anything — which is what lets that policy skip the raw
 * tag-balance machinery entirely (and it is the one tag smd passes through).
 */
const BR_TAG_RE = /^<br\s*\/?>$/i

/** An event-handler attribute (`onclick=`, `onerror=`, …); never in renderer output. */
const EVENT_HANDLER_ATTR_RE = /\son[a-z]+\s*=/i

/** First `href="…"`/`src="…"` value in a tag, or null. */
const URL_ATTR_RE = /\b(?:href|src)\s*=\s*"([^"]*)"/i

/**
 * Schemes that are dangerous as an `href`/`src`. Mirrors the autolink renderer's
 * denylist (`autolinkHref` in inline-autolinks.ts) rather than the stricter link
 * allowlist (`safeLinkHref`), so this pass preserves the same uncommon-but-inert
 * schemes autolinks legitimately produce (`<ftp://…>`, `<foo://…>`).
 */
const DANGEROUS_HREF_SCHEME_RE = /^(?:javascript|data|vbscript):/i

/**
 * `SAFE_OUTER_TAG_RE` matches renderer-generated tags by SHAPE, but a raw tag a
 * model typed into prose can wear the same shape — a forged `data-md-rendered="1"`
 * marker, or an attributed `<em onmouseover=…>`. Re-validate CONTENT here so those
 * never pass unescaped: reject any event-handler attribute, and any `href`/`src`
 * whose scheme is dangerous (decoding entity/escape obfuscation first, the way
 * `safeLinkHref` does, so `&#x6a;avascript:` can't slip through). The renderer's
 * own anchors/images already satisfy this, so legitimate output is untouched.
 */
function isSanctionedRendererTag(tag: string): boolean {
  if (EVENT_HANDLER_ATTR_RE.test(tag)) return false
  const rawUrl = URL_ATTR_RE.exec(tag)?.[1]
  if (rawUrl === undefined) return true
  const url = decodeHtmlCharRefs(decodeEscapedPunctuationRaw(decodeEscapedHref(rawUrl))).trim()
  return !DANGEROUS_HREF_SCHEME_RE.test(url)
}

/**
 * A single well-formed HTML open/self-closing/close tag (`<div>`, `<br/>`,
 * `<a href="…">`, `</section>`). Under the passthrough policy this is the whole
 * keep/escape test: a syntactically-valid tag is emitted verbatim and the sink
 * sanitizer decides its fate (allowlisted → element; otherwise stripped), while
 * a lone `<`, a `<` that never forms a tag (`a < b`, `<3`), and an unterminated
 * `<div` (escaped by the surrounding split leaving no closing `>`) stay literal.
 * Deliberately liberal — even attributed/event-handler tags pass, because
 * `sanitize.ts` is the sole arbiter (#600); it is NOT a safety filter.
 */
const PASSTHROUGH_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>$/

/** Whole-name test for the attributes {@link narrowAnchor} keeps. */
const SAFE_ANCHOR_ATTR_NAME_RE = /^(?:href|title|target|rel|class|data-[a-z0-9-]+)$/i

/** One attribute inside an open tag: a name, optionally with a quoted value. */
const TAG_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g

/** An open `<a>` tag carrying at least one attribute, captured for narrowing. */
const ANCHOR_OPEN_TAG_RE = /^<a\s+([^>]*?)\s*>$/i

/** A double-quoted `href`, the shape every renderer/decorator anchor has. */
const QUOTED_HREF_RE = /\bhref\s*=\s*"/i

/**
 * Fail-safe for an anchor {@link SAFE_OUTER_TAG_RE} does not recognise: re-emit
 * it carrying only the allowlisted attributes instead of escaping it whole.
 *
 * The all-or-nothing test this backstops fails *badly*, not safely — `</a>` is a
 * separate arm and survives on its own, so one unrecognised attribute turns a
 * link into escaped source text followed by a stray unbalanced close tag (#146's
 * `data-*` fallout was one instance; any attribute the core or a host adds later
 * is the next). Degrading to a narrowed anchor keeps the markup well-formed and
 * keeps the decision conservative: the tag is rebuilt from the allowlist, so an
 * unknown attribute is dropped rather than passed on to the sink, and
 * `isSanctionedRendererTag` still rejects event handlers and dangerous schemes.
 *
 * Requires a quoted `href` — the shape the renderer and every decorator emit,
 * and the only one `isSanctionedRendererTag` can read a scheme out of. An
 * unquoted `<a href=javascript:…>` therefore still escapes whole, as before.
 */
function narrowAnchor(tag: string): string | null {
  const body = ANCHOR_OPEN_TAG_RE.exec(tag)?.[1]
  if (body === undefined || !QUOTED_HREF_RE.test(body)) return null
  if (!isSanctionedRendererTag(tag)) return null
  const kept: string[] = []
  let hasHref = false
  for (const [, rawName = '', value] of body.matchAll(TAG_ATTR_RE)) {
    const name = rawName.toLowerCase()
    if (!SAFE_ANCHOR_ATTR_NAME_RE.test(name)) continue
    if (name === 'href') {
      // The guard above can be satisfied by a `href="` *inside* another
      // attribute's value, so confirm a real one survived the scan: this
      // salvages links, and an `<a>` with no href is not one.
      if (value === undefined) continue
      hasHref = true
    }
    // Values came out of a `<[^>]+>` split inside double quotes, so they carry
    // no `<`, `>` or `"` and need no re-escaping to be re-emitted.
    kept.push(value === undefined ? name : `${name}="${value}"`)
  }
  return hasHref ? `<a ${kept.join(' ')}>` : null
}

/** The HTML to emit for a raw tag, or `null` to escape it as literal text. */
function safeRawTag(part: string, policy: HtmlPolicy): string | null {
  if (policy === 'passthrough') return PASSTHROUGH_TAG_RE.test(part) ? part : null
  // Renderer-generated tags (re-validated for forged content) always survive —
  // this escaper runs over the renderer's own output. Verbatim, so output for
  // everything this arm already matched stays byte-identical.
  if (SAFE_OUTER_TAG_RE.test(part) && isSanctionedRendererTag(part)) return part
  // Only then: salvage an anchor the shape test missed rather than mangle it.
  const narrowed = narrowAnchor(part)
  if (narrowed !== null) return narrowed
  // Escape policy keeps the benign attribute-less inline allowlist;
  // escape-all literalizes everything but the void <br>.
  const keep = policy === 'escape-all' ? BR_TAG_RE.test(part) : BENIGN_RAW_INLINE_TAG_RE.test(part)
  return keep ? part : null
}

function escapeHtmlOutsideSafeTags(html: string): string {
  const policy = getHtmlPolicy()
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith('<') ? (safeRawTag(part, policy) ?? escapeHtml(part)) : escapeHtml(part)))
    .join('')
}

/**
 * Streaming hold: start index of a trailing, still-forming raw HTML tag/comment
 * so the passthrough tail never flashes a half-typed `<div class="` as escaped
 * source before its `>` arrives (cf. the entity/strikethrough/math holds it
 * composes with in `pendingHoldIndex`). Returns `s.length` when the trailing
 * `<` is already closed, is not tag-like (`< 3`, `<3`, `<=`), or is masked
 * (inside a code span). Only meaningful under the passthrough policy — the
 * caller gates on it so escape mode reproduces today's tail output.
 */
export function rawHtmlTagHoldStart(s: string, mask: boolean[]): number {
  // Native `lastIndexOf` keeps this a cheap check on the pending tail; only a
  // `<` inside a code span (rare) forces a step back to the previous one.
  for (let i = s.lastIndexOf('<'); i >= 0; i = s.lastIndexOf('<', i - 1)) {
    if (mask[i]) continue
    const segment = s.slice(i)
    // A closed trailing tag is complete: nothing forming to hold.
    if (segment.includes('>')) return s.length
    // Hold only a genuine tag/comment start (`<`, `<x`, `</x`, `<!--`); a `<`
    // followed by a space/digit/etc. is literal text and reveals as `&lt;`.
    return /^<(?:[a-zA-Z/!]|$)/.test(segment) ? i : s.length
  }
  return s.length
}

/**
 * Escape literal text while preserving Copse-generated inline HTML tags.
 *
 * @internal Low-level renderer internal, not part of the stable v1 surface
 * (#147) and not exported from the package entry since 1.0. Prefer
 * `renderMarkdown` / `renderMarkdownUnsafe`.
 */
export function escapeHtmlTextNodes(html: string): string {
  return html
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) {
        const match = segment.match(/^(<code>)([\s\S]*?)(<\/code>)$/)
        if (!match) return segment
        return `${match[1] ?? ''}${escapeHtml(match[2] ?? '')}${match[3] ?? ''}`
      }
      return escapeHtmlOutsideSafeTags(segment)
    })
    .join('')
}

/**
 * Mermaid reads arrow syntax (`-->`) so `>` must survive, but everything that
 * could break out of `<pre>` (`&`, `<`, and both quote styles) is still encoded
 * in one order-independent pass.
 */
export function escapeMermaidHtml(text: string): string {
  return text.replace(/[&<"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/** Reverse {@link escapeHtml} for parsing href/src attributes embedded in markdown. */
export function decodeEscapedHref(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// Hex non-breaking space is `#xa0` (U+00A0), not `#xa` (U+000A, a line feed) —
// the arm must be `#x0*a0` so `&#xa0;` decodes and the LF escape does not. The
// global scanner and the anchored completeness check below both derive from this
// one source so the two can never drift apart — that drift (one copy fixed, one
// not) was #143 itself.
const SAFE_MARKDOWN_ENTITY_SOURCE = '&(?:amp;)?(?:nbsp|#160|#x0*a0);'
const SAFE_MARKDOWN_ENTITY_RE = new RegExp(SAFE_MARKDOWN_ENTITY_SOURCE, 'gi')
const COMPLETE_SAFE_MARKDOWN_ENTITY_RE = new RegExp(`^${SAFE_MARKDOWN_ENTITY_SOURCE}$`, 'i')

const KNOWN_SAFE_ENTITIES = [
  '&nbsp;',
  '&#160;',
  '&#xa0;',
  '&amp;nbsp;',
  '&amp;#160;',
  '&amp;#xa0;',
] as const

/** Drop a trailing incomplete safe-entity prefix so streaming never flashes literal `&nbsp`. */
export function stripIncompleteSafeEntities(text: string): string {
  const amp = text.lastIndexOf('&')
  if (amp === -1) return text
  const suffix = text.slice(amp)
  if (COMPLETE_SAFE_MARKDOWN_ENTITY_RE.test(suffix)) return text
  const lower = suffix.toLowerCase()
  if (
    KNOWN_SAFE_ENTITIES.some((entity) => entity.startsWith(lower) && lower.length < entity.length)
  ) {
    return text.slice(0, amp)
  }
  return text
}

/**
 * Decode a small allowlist of HTML entities models emit in prose (e.g. &nbsp;).
 *
 * @internal Low-level renderer internal, not part of the stable v1 surface
 * (#147) and not exported from the package entry since 1.0. It is called by
 * the streaming pending paths; hosts should not need it.
 */
export function decodeSafeMarkdownEntities(text: string): string {
  const stripped = stripIncompleteSafeEntities(text)
  // Every spelling `SAFE_MARKDOWN_ENTITY_RE` matches \u2014 `nbsp`, decimal `#160`,
  // hex `#x0*a0`, each optionally `&amp;`-escaped \u2014 is a non-breaking space.
  return stripped.replace(SAFE_MARKDOWN_ENTITY_RE, () => '\u00A0')
}
