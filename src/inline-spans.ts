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
  t = renderBareHttpLinks(t)
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

const BARE_HTTP_URL_RE = /(^|[\s(])((?:https?:\/\/)[^\s<]+)/gi
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?_]+$/

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

function renderBareHttpLinks(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(BARE_HTTP_URL_RE, (_match, prefix: string, rawUrl: string) => {
        // A CJK full-width punctuation mark ends the URL and stays as prose.
        const { url: beforeCjk, tail: cjkTail } = splitBareUrlAtCjkBoundary(rawUrl)
        if (beforeCjk === '') return `${prefix}${rawUrl}`
        const asciiTrailing = beforeCjk.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? ''
        const url = asciiTrailing ? beforeCjk.slice(0, -asciiTrailing.length) : beforeCjk
        const href = safeLinkHref(url)
        if (!href) return `${prefix}${rawUrl}`
        return `${prefix}${renderedBareLink(url, href)}${asciiTrailing}${cjkTail}`
      })
    })
    .join('')
}
