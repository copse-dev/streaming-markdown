import { decodeEscapedPunctuationRaw } from './backslash-escapes.ts'
import { getHtmlPolicy } from './html-policy.ts'
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

const SAFE_OUTER_TAG_RE =
  /^(?:<a(?:\s+href="[^"]*")(?:\s+(?:title|target|rel|data-browser-link|data-workspace-link|class)="[^"]*")*\s*>|<\/(?:a|code|em|strong)>|<(?:code|em|strong)\b[^>]*>|<img\b[^>]*\bdata-md-rendered="1"[^>]*\/?>)$/i

/**
 * Benign raw inline HTML models emit in prose (strikethrough, sub/superscript,
 * keyboard keys, explicit breaks). Attribute-less phrasing tags only — anything
 * with attributes, and all block/structural tags, stays escaped. The DOMPurify
 * sink allowlist (`sanitize.ts`) mirrors this set.
 */
const BENIGN_RAW_INLINE_TAG_RE = /^<\/?(?:b|i|u|s|del|ins|sub|sup|kbd|mark|br)\s*\/?>$/i

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

function keepRawTag(part: string, passthrough: boolean): boolean {
  if (passthrough) return PASSTHROUGH_TAG_RE.test(part)
  // Escape policy: only renderer-generated tags (re-validated for forged
  // content) and the benign attribute-less inline allowlist survive.
  return (
    (SAFE_OUTER_TAG_RE.test(part) && isSanctionedRendererTag(part)) ||
    BENIGN_RAW_INLINE_TAG_RE.test(part)
  )
}

function escapeHtmlOutsideSafeTags(html: string): string {
  const passthrough = getHtmlPolicy() === 'passthrough'
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith('<') && keepRawTag(part, passthrough) ? part : escapeHtml(part)))
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

/** Escape literal text while preserving Copse-generated inline HTML tags. */
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
// the arm must be `#x0*a0` so `&#xa0;` decodes and the LF escape does not.
const SAFE_MARKDOWN_ENTITY_RE = /&(?:amp;)?(?:nbsp|#160|#x0*a0);/gi

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
  if (/^&(?:amp;)?(?:nbsp|#160|#x0*a0);$/i.test(suffix)) return text
  const lower = suffix.toLowerCase()
  if (
    KNOWN_SAFE_ENTITIES.some((entity) => entity.startsWith(lower) && lower.length < entity.length)
  ) {
    return text.slice(0, amp)
  }
  return text
}

/** Decode a small allowlist of HTML entities models emit in prose (e.g. &nbsp;). */
export function decodeSafeMarkdownEntities(text: string): string {
  const stripped = stripIncompleteSafeEntities(text)
  // Every spelling `SAFE_MARKDOWN_ENTITY_RE` matches \u2014 `nbsp`, decimal `#160`,
  // hex `#x0*a0`, each optionally `&amp;`-escaped \u2014 is a non-breaking space.
  return stripped.replace(SAFE_MARKDOWN_ENTITY_RE, () => '\u00A0')
}
