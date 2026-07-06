import { decodeEscapedPunctuation, encodeBackslashEscapes } from './backslash-escapes.ts'
import { escapeHtmlTextNodes } from './escape.ts'
import { renderAngleAutolinks } from './inline-autolinks.ts'
import { renderInlineCode } from './inline-code-spans.ts'
import { INLINE_HTML_SHIELD_RE, renderEmphasisOutsideInlineHtml } from './inline-emphasis.ts'
import { renderAnchor, renderInlineLinks, safeLinkHref } from './inline-links.ts'
import {
  beginInlinePassRender,
  getInlinePasses,
  inlinePassContext,
  type InlinePassStage,
  restoreInlinePassHtml,
} from './inline-passes.ts'
import { renderStrikethrough } from './inline-strikethrough.ts'
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

/** The inline passes that run before link rendering, in pipeline order. */
function renderInlineSpansBeforeLinks(t: string, linkRefs: LinkReferenceMap): string {
  // Backslash-escaped punctuation is encoded to inert PUA characters first so
  // no later pass can interpret it (encoding is idempotent for nested calls).
  t = encodeBackslashEscapes(t)
  t = renderInlineCode(t)
  t = renderAngleAutolinks(t)
  t = renderEmphasisOutsideInlineHtml(t, linkRefs)
  // GFM strikethrough after emphasis (so `~~*x*~~` nests) and before links (so a
  // struck `~~[a](b)~~` still resolves the link inside the <del>).
  t = renderStrikethrough(t)
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
  // into its emitted HTML still decode to their escaped literal form).
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

function renderBareHttpLinks(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(BARE_HTTP_URL_RE, (_match, prefix: string, rawUrl: string) => {
        const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? ''
        const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
        const href = safeLinkHref(url)
        if (!href) return `${prefix}${rawUrl}`
        return `${prefix}${renderedBareLink(url, href)}${trailing}`
      })
    })
    .join('')
}
