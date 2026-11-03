import { escapeHtml } from './escape.ts'
import { INLINE_HTML_SHIELD_RE } from './inline-emphasis.ts'
import { isAllowedHref } from './inline-links.ts'
import { encodeHrefForOutput } from './link-references.ts'
import { applyUrlPolicy, urlPolicyMarkerAttr } from './url-policy.ts'

/**
 * CommonMark URI autolink: `<scheme:...>`. Scheme is an ASCII letter followed by
 * 1–31 letters/digits/`+`/`.`/`-`; the rest is any run of characters other than
 * ASCII whitespace, control characters, `<`, and `>`. Backslash escapes are NOT
 * recognized inside autolinks — every character is literal (spec 603).
 */
const URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/

/**
 * CommonMark email autolink grammar (spec's `email address` production). The
 * local part is a restricted punctuation set (notably no backslash, so
 * `<foo\+@bar>` is not an email autolink, spec 606) and the domain is
 * dot-separated labels of alphanumerics/hyphens.
 */
const EMAIL_AUTOLINK_RE =
  /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/

/**
 * Percent-encode an autolink destination, or return `null` to leave the autolink
 * literal. Angle autolinks route through the same scheme allowlist as markdown
 * links (#139), so an unlisted scheme (`file:`, `chrome:`, arbitrary handlers)
 * fails closed rather than becoming a live `<a href>` — the denylist that only
 * caught `javascript:`/`data:`/`vbscript:` was the sole fail-open link path.
 * Autolink destinations are verbatim (no backslash escapes, spec 603), so the
 * raw scheme is checked directly.
 */
function autolinkHref(raw: string): string | null {
  if (!isAllowedHref(raw)) return null
  return encodeHrefForOutput(raw)
}

function renderedAutolink(label: string, href: string): string {
  // Label stays raw so the outer `escapeHtmlTextNodes` pass escapes it exactly
  // once; pre-escaping here would double-encode `&` in URLs (`&amp;amp;`, #595).
  const decided = applyUrlPolicy(href, 'navigation', 'markdown', 'a', 'href')
  const hrefAttr = decided === null ? '' : ` href="${escapeHtml(decided)}"`
  return `<a${hrefAttr}${urlPolicyMarkerAttr()}>${label}</a>`
}

/**
 * CommonMark autolink: `<scheme:...>` or `<email@domain>`. URI autolinks are
 * tried before email autolinks so `<MAILTO:foo@bar.baz>` is a scheme autolink
 * (href kept verbatim) rather than being mangled into a `mailto:` link (spec 597).
 */
function tryAngleAutolink(text: string, start: number): { html: string; end: number } | null {
  if (text[start] !== '<') return null
  const slice = text.slice(start)

  const uri = URI_AUTOLINK_RE.exec(slice)
  if (uri?.[1] !== undefined) {
    const href = autolinkHref(uri[1])
    if (href === null) return null
    return { html: renderedAutolink(uri[1], href), end: start + uri[0].length }
  }

  const email = EMAIL_AUTOLINK_RE.exec(slice)
  if (email?.[1] !== undefined) {
    const href = autolinkHref(`mailto:${email[1]}`)
    if (href === null) return null
    return { html: renderedAutolink(email[1], href), end: start + email[0].length }
  }

  return null
}

/** Render `<url>` and `<email>` autolinks outside inline HTML shields. */
export function renderAngleAutolinks(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      let out = ''
      let i = 0
      while (i < segment.length) {
        const parsed = tryAngleAutolink(segment, i)
        if (parsed) {
          out += parsed.html
          i = parsed.end
          continue
        }
        out += segment[i] ?? ''
        i++
      }
      return out
    })
    .join('')
}
