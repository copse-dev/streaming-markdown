import { isEmailAutolinksEnabled } from './autolink-syntax.ts'
import { decodeEscapedPunctuation, encodeBackslashEscapes } from './backslash-escapes.ts'
import { escapeHtmlTextNodes } from './escape.ts'
import { renderAngleAutolinks } from './inline-autolinks.ts'
import { renderInlineCode } from './inline-code-spans.ts'
import { INLINE_HTML_SHIELD_RE, renderEmphasisOutsideInlineHtml } from './inline-emphasis.ts'
import { renderAnchor, renderInlineLinks, safeLinkHref } from './inline-links.ts'
import { renderInlineMathSpans } from './inline-math.ts'
import {
  beginInlinePassRender,
  getInlinePasses,
  inlinePassContext,
  type InlinePassStage,
  restoreInlinePassHtml,
} from './inline-passes.ts'
import { renderStrikethrough } from './inline-strikethrough.ts'
import { getActiveFootnoteContext, renderFootnoteRefs } from './footnotes.ts'
import { type LinkReferenceMap } from './link-references.ts'

/**
 * Run the registered inline passes for one pipeline stage (#53). Each pass is
 * applied only outside rendered inline HTML — `<code>`/`<a>`/`<img>` interiors
 * are shielded exactly like the bare-autolink pass below — and splices any
 * generated HTML via `inlinePassContext.emit`, restored after escaping.
 */
function applyInlinePasses(t: string, stage: InlinePassStage): string {
  const passes = getInlinePasses(stage)
  if (passes.length === 0) return t
  for (const pass of passes) {
    t = t
      .split(INLINE_HTML_SHIELD_RE)
      .map((segment, index) => (index % 2 === 1 ? segment : pass.apply(segment, inlinePassContext)))
      .join('')
  }
  return t
}

/**
 * Core footnote-reference pass (#72): resolvable `[^label]` becomes a
 * `<sup class="footnote-ref">` reference. Runs like a built-in `before-links`
 * pass — outside rendered inline HTML, emitting through the same shielded side
 * table — so a bracketed footnote consumes its text before markdown-link
 * resolution reads `[` as a label opener, and code spans never trigger.
 */
function applyFootnoteRefs(t: string): string {
  if (getActiveFootnoteContext() === null || !t.includes('[^')) return t
  return t
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) =>
      index % 2 === 1 ? segment : renderFootnoteRefs(segment, (html) => inlinePassContext.emit(html)),
    )
    .join('')
}

/** The inline passes that run before link rendering, in pipeline order. */
function renderInlineSpansBeforeLinks(t: string, linkRefs: LinkReferenceMap): string {
  // Backslash-escaped punctuation is encoded to inert PUA characters first so
  // no later pass can interpret it (encoding is idempotent for nested calls).
  t = encodeBackslashEscapes(t)
  t = renderInlineCode(t)
  t = renderAngleAutolinks(t)
  // Inline math (#70) runs before emphasis because its content is verbatim,
  // like code: `$a_i * b$` must reach KaTeX untouched. Emitted scaffolding is
  // shielded through the inline-pass emit table.
  t = renderInlineMathSpans(t, linkRefs)
  t = renderEmphasisOutsideInlineHtml(t, linkRefs)
  // GFM strikethrough after emphasis (so `~~*x*~~` nests) and before links (so a
  // struck `~~[a](b)~~` still resolves the link inside the <del>).
  t = renderStrikethrough(t)
  // Core GFM footnote references (#72) run before registered passes and links.
  t = applyFootnoteRefs(t)
  // Custom bracket-adjacent syntaxes (e.g. citation `[@key]`) must consume
  // their text before markdown-link resolution treats `[` as a label opener.
  t = applyInlinePasses(t, 'before-links')
  return t
}

function renderNestedInlineSpans(t: string, linkRefs: LinkReferenceMap): string {
  t = renderInlineSpansBeforeLinks(t, linkRefs)
  // The pre-link pipeline doubles as the label-match renderer: reference labels
  // in the text have already been through it, so definition labels must be run
  // through the same passes before comparing (spec 554/558/585).
  t = renderInlineLinks(t, linkRefs, renderNestedInlineSpans, (label) =>
    renderInlineSpansBeforeLinks(label, linkRefs),
  )
  // Strong spans around rendered <code>/<a>/<img> run after links so patterns
  // like `**[#264](url)**` and `**[`path`](path) tail**` resolve to real
  // anchors instead of literal `[label](dest)` inside <strong>.
  t = renderStrongAroundCode(t)
  t = renderStrongWithInlineHtml(t)
  t = renderExtendedAutolinks(t)
  t = applyInlinePasses(t, 'after-links')
  return t
}

/**
 * Inline span markup (code, emphasis, links) for a single line/segment of
 * already-escaped text. Shared by block rendering and per-cell table rendering
 * so emphasis cannot pair across cell boundaries (#469).
 */
export function renderInlineSpans(t: string, linkRefs: LinkReferenceMap = new Map()): string {
  // Inline-pass bracketing (#53): strip attacker-typed placeholder characters
  // before any pass runs, and swap pass-emitted HTML back in after the escape
  // step (but before punctuation decode, so PUA-encoded escapes a pass captured
  // into its emitted HTML still decode to their escaped literal form). The
  // built-in math (#70) and footnote (#72) passes share the same side table.
  t = beginInlinePassRender(t)
  return decodeEscapedPunctuation(
    restoreInlinePassHtml(escapeHtmlTextNodes(renderNestedInlineSpans(t, linkRefs))),
  )
}

/** Delimiter stack cannot pair `**` across a `<code>` shield. */
function renderStrongAroundCode(text: string): string {
  return text.replace(/\*\*(<code>[\s\S]*?<\/code>)\*\*/g, '<strong>$1</strong>')
}

/**
 * Strong spans that contain rendered inline HTML, optionally with trailing prose.
 * Runs after link rendering so `<a>` is already in the DOM-shaped string. Covers
 * agent captions like `**`file.png` — description**` and bold-wrapped links
 * like `**[#264](url) — Track 1**` where linkBeatsEmphasis blocks the stack.
 */
function renderStrongWithInlineHtml(text: string): string {
  return text.replace(
    /\*\*(?=\S)([^*\n]*<(?:code|a|img)\b[\s\S]*?(?:<\/(?:code|a)>|<img\b[^>]*>)[^*\n]*)\*\*/g,
    '<strong>$1</strong>',
  )
}

function renderedBareLink(label: string, href: string): string {
  // Bare autolinks route through the active LinkDecorator like markdown links (#601).
  return renderAnchor(label, href)
}

/**
 * Opt-in override (default `null`) that flags CJK / full-width punctuation as a
 * bare-autolink boundary — the seam the CJK entry
 * (`@copse/streaming-markdown/cjk`, `src/cjk.ts`) uses so a run-together URL like
 * `https://example.com。次` does not swallow the trailing `。次` into the `href`.
 * Left `null` in the default build (Latin URLs never contain these code points),
 * so non-CJK output is byte-identical.
 */
let bareUrlCjkBoundary: ((ch: string) => boolean) | null = null

/** Inject (or clear with `null`) the bare-autolink CJK-punctuation boundary. */
export function setBareUrlCjkBoundary(fn: ((ch: string) => boolean) | null): void {
  bareUrlCjkBoundary = fn
}

/** The active bare-autolink CJK boundary, or `null`. Snapshot for `withConfig`. */
export function getBareUrlCjkBoundary(): ((ch: string) => boolean) | null {
  return bareUrlCjkBoundary
}

/** Split a captured bare URL at the first CJK-punctuation boundary, if any. */
function splitBareUrlAtCjkBoundary(rawUrl: string): { url: string; tail: string } {
  const boundary = bareUrlCjkBoundary
  if (boundary !== null) {
    for (let i = 0; i < rawUrl.length; i++) {
      if (boundary(rawUrl[i] ?? '')) return { url: rawUrl.slice(0, i), tail: rawUrl.slice(i) }
    }
  }
  return { url: rawUrl, tail: '' }
}

/**
 * Run `fn` over the non-shielded slices of `text`, exactly like the inline-pass
 * splitter: rendered `<code>`/`<a>`/`<img>` interiors (odd indices) pass through
 * untouched so a generated autolink never re-scans the URL/email inside it.
 */
function mapOutsideInlineHtml(text: string, fn: (segment: string) => string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => (index % 2 === 1 ? segment : fn(segment)))
    .join('')
}

/**
 * GFM extended autolinks (extension) — recognised in plain text alongside the
 * bare `http(s)://` pass this replaces:
 *   - `www.` hosts       → `http://` prefixed href.
 *   - `http`/`https`/`ftp` URLs.
 *   - bare `user@host`   → `mailto:` href.
 *
 * The `www.`/URL forms may only start at the beginning of a segment, after
 * whitespace, or after one of `*`, `_`, `~`, `(` (the GFM left-flank set); email
 * addresses are recognised anywhere their local part rewinds to a valid start.
 * Trailing punctuation, unbalanced `)`, and entity-like `&…;` are trimmed with
 * {@link trimAutolinkTail} (a self-contained implementation of the extension's
 * path-validation rules), and the CJK boundary hook still splits a run-together
 * full-width tail out of the href. Generated hrefs go through {@link safeLinkHref}
 * so the scheme allowlist is enforced on them too.
 */
function renderExtendedAutolinks(text: string): string {
  // URL/`www.` first, then email over the result: an email inside a freshly
  // generated `<a>` (e.g. userinfo in a linked URL) is shielded on the re-split.
  const withUrls = mapOutsideInlineHtml(text, linkifyWwwAndUrlAutolinks)
  // Email autolinking is a separately toggleable GFM feature (#115): a consumer
  // targeting base CommonMark/GFM leaves a bare address as plain text.
  return isEmailAutolinksEnabled() ? mapOutsideInlineHtml(withUrls, linkifyEmailAutolinks) : withUrls
}

/**
 * GFM left-flank characters an extended `www.`/URL autolink may follow. `*_~(`
 * are the source flank set (for a literal, unpaired flank char); `>` is the
 * close of a non-shielded inline tag (`<em>`/`<strong>`/`<del>`), since this
 * pass runs after emphasis/strikethrough rendering — without it `*www.x.com*`
 * arrives as `<em>www.x.com</em>` and the run's preceding char is `>`, so it
 * would never link where GitHub renders a styled link. A literal source `>` is
 * escaped to `&gt;` before this pass, so a bare `>` is always a tag close.
 */
function isExtendedAutolinkBoundary(prev: string | undefined): boolean {
  return (
    prev === undefined ||
    /\s/.test(prev) ||
    prev === '*' ||
    prev === '_' ||
    prev === '~' ||
    prev === '(' ||
    prev === '>'
  )
}

const URL_SCHEME_RE = /^(?:https?|ftp):\/\//i
const WWW_DOMAIN_RE = /^www(?:\.[A-Za-z0-9_-]+)+/i

/** No underscore in the last two segments of a `www.` domain (GFM valid-domain rule). */
function wwwDomainIsValid(domain: string): boolean {
  const segments = domain.split('.')
  return !segments.slice(-2).some((segment) => segment.includes('_'))
}

/** Trailing punctuation trimmed off an extended autolink (`< immediately ends`). */
const AUTOLINK_TRAILING_PUNCTUATION = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"'])

/**
 * GFM "extended autolink path validation": trim trailing punctuation, drop
 * unmatched trailing `)` (scanning the whole link for paren balance), and strip
 * a trailing entity-like `&word;`. Iterates because trimming one class can
 * expose another (`…business))` → `…business)` → stop). Self-contained so this
 * PR is correct on its own; a later merge may dedupe with the bare-URL paren fix.
 */
function trimAutolinkTail(link: string): string {
  let end = link.length
  // Count parens once up front. Only the `)` branch removes a paren (from the
  // tail), so decrementing `close` per trim keeps the balance exact while a long
  // run of trailing `)` costs O(n) total instead of re-counting the whole link
  // each time (which was O(n²) on hostile input like `www.a/))))…`).
  let open = 0
  let close = 0
  for (let i = 0; i < link.length; i++) {
    if (link[i] === '(') open++
    else if (link[i] === ')') close++
  }
  while (end > 0) {
    const c = link[end - 1] ?? ''
    if (AUTOLINK_TRAILING_PUNCTUATION.has(c)) {
      end--
      continue
    }
    if (c === ')') {
      if (close <= open) break
      close--
      end--
      continue
    }
    if (c === ';') {
      let scan = end - 2
      while (scan > 0 && /[A-Za-z]/.test(link[scan] ?? '')) scan--
      if (scan < end - 2 && link[scan] === '&') {
        end = scan // trim a whole entity-like `&word;`
        continue
      }
      // A lone trailing `;` is ordinary trailing punctuation (matches cmark's
      // autolink_delim and the bare-URL pass on main); trim just the `;`.
      end--
      continue
    }
    break
  }
  return link.slice(0, end)
}

/**
 * Consume the extended-autolink run at `start` (all non-space, non-`<`
 * characters), split off any CJK full-width tail, trim the path per
 * {@link trimAutolinkTail}, and build the `<a>`. `schemePrefix` is prepended to
 * the href for `www.` hosts (`http://`) and empty for already-schemed URLs.
 */
function buildExtendedAutolink(
  segment: string,
  start: number,
  schemePrefix: string,
): { html: string; end: number } | null {
  let run = start
  while (run < segment.length && !/\s/.test(segment[run] ?? '') && segment[run] !== '<') run++
  const raw = segment.slice(start, run)
  const { url: beforeCjk, tail: cjkTail } = splitBareUrlAtCjkBoundary(raw)
  const url = trimAutolinkTail(beforeCjk)
  if (url === '') return null
  const trailing = beforeCjk.slice(url.length)
  const href = safeLinkHref(schemePrefix + url)
  if (!href) return null
  return { html: `${renderedBareLink(url, href)}${trailing}${cjkTail}`, end: run }
}

function linkifyWwwAndUrlAutolinks(segment: string): string {
  let out = ''
  let i = 0
  while (i < segment.length) {
    if (isExtendedAutolinkBoundary(i === 0 ? undefined : segment[i - 1])) {
      const rest = segment.slice(i)
      const urlScheme = URL_SCHEME_RE.exec(rest)
      if (urlScheme) {
        const after = segment[i + urlScheme[0].length]
        const schemedDomain = /^[A-Za-z0-9._-]+/.exec(rest.slice(urlScheme[0].length))?.[0] ?? ''
        // Require a domain character after the scheme (like the bare pass) and
        // enforce the same valid-domain underscore rule GFM applies to `www.`
        // hosts (cmark runs the same check_domain on schemed URLs).
        if (
          after !== undefined &&
          !/\s/.test(after) &&
          after !== '<' &&
          schemedDomain !== '' &&
          wwwDomainIsValid(schemedDomain)
        ) {
          const built = buildExtendedAutolink(segment, i, '')
          if (built) {
            out += built.html
            i = built.end
            continue
          }
        }
      } else {
        const www = WWW_DOMAIN_RE.exec(rest)
        if (www && wwwDomainIsValid(www[0])) {
          const built = buildExtendedAutolink(segment, i, 'http://')
          if (built) {
            out += built.html
            i = built.end
            continue
          }
        }
      }
    }
    out += segment[i] ?? ''
    i++
  }
  return out
}

/** Local-part / domain characters an email autolink may contain, per GFM. */
const EMAIL_LOCAL_CHAR_RE = /[A-Za-z0-9.+_-]/

/**
 * GFM extended email autolink at the `@` in `segment` at index `at`: rewind the
 * local part, scan the domain, and validate per the extension's rules (exactly
 * one `@`, at least one interior `.`, no trailing `-`/`_`, a trailing `.` left
 * as prose). Returns the `<a>` span and its bounds, or null when it is not a
 * valid address.
 */
interface EmailMatch {
  html: string
  start: number
  end: number
}

function matchEmailAutolink(
  segment: string,
  at: number,
): { match: EmailMatch | null; scanEnd: number } {
  let start = at
  while (start > 0 && EMAIL_LOCAL_CHAR_RE.test(segment[start - 1] ?? '')) start--
  if (start === at) return { match: null, scanEnd: at + 1 } // no local part

  let dotCount = 0
  let end = at
  while (end < segment.length) {
    const c = segment[end] ?? ''
    if (/[A-Za-z0-9]/.test(c)) {
      end++
    } else if (c === '@') {
      // Stop at a second `@`: a valid address has exactly one, and consuming
      // past it would rescan the whole tail from every `@`, giving O(n²) on
      // hostile input like `a@a@a@…` (GHSA-29g3-96g3-jg6c). cmark stops here too.
      if (end > at) break
      end++
    } else if (c === '.' && end < segment.length - 1 && /[A-Za-z0-9]/.test(segment[end + 1] ?? '')) {
      dotCount++
      end++
    } else if (c === '-' || c === '_') {
      end++
    } else {
      break
    }
  }
  const last = segment[end - 1] ?? ''
  if (end - at < 2 || dotCount === 0 || (!/[A-Za-z]/.test(last) && last !== '.')) {
    return { match: null, scanEnd: end }
  }
  const email = segment.slice(start, end)
  const href = safeLinkHref(`mailto:${email}`)
  if (!href) return { match: null, scanEnd: end }
  return { match: { html: renderedBareLink(email, href), start, end }, scanEnd: end }
}

function linkifyEmailAutolinks(segment: string): string {
  if (!segment.includes('@')) return segment
  let out = ''
  let emitted = 0
  let i = 0
  while (i < segment.length) {
    if (segment[i] === '@') {
      const { match, scanEnd } = matchEmailAutolink(segment, i)
      if (match) {
        out += segment.slice(emitted, match.start) + match.html
        i = match.end
        emitted = match.end
        continue
      }
      // No match: jump past the region already scanned as `@`+domain. The only
      // `@` in (i, scanEnd) is this one, so nothing there can start an address —
      // skipping it keeps the outer pass O(n) rather than retrying every char.
      i = Math.max(i + 1, scanEnd)
      continue
    }
    i++
  }
  return out + segment.slice(emitted)
}
