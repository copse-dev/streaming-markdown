/**
 * Inline math (#70): `$x$` / `$$x$$` / `\(x\)` as a built-in inline pass.
 *
 * The pass runs early in the pipeline — after code spans and angle autolinks,
 * *before* emphasis — because math content is verbatim like code: `$a_i * b$`
 * must reach KaTeX untouched, not as `a<em>i * b</em>`. It emits the same
 * inert two-phase scaffolding as display math
 * (`<span class="math-inline math-inline--pending">…escaped…</span>`), shielded
 * through the inline-pass emit table (`inline-passes.ts`) so later passes and
 * the escape step never mangle it; `hydratePendingMath` (`math.ts`) upgrades it
 * after the sink sanitizer.
 *
 * Single-dollar math uses remark-math's currency guards: the opening `$` must
 * not be followed by whitespace, the closing `$` must not be preceded by
 * whitespace nor followed by a digit — so `$20 and $30` stays literal prose.
 * Double-dollar (`$$x$$` mid-line) and `\(x\)` only require a non-blank body.
 * `\$` is a CommonMark escape and never delimits; `\(…\)` is recognized *by*
 * its escape — a deliberate, documented divergence from CommonMark's
 * literal-paren reading, gated to non-empty single-line bodies so the spec
 * suite's escaped-punctuation examples still pass.
 */
import { canonicalizeEscapedPunctuation } from './backslash-escapes.ts'
import { escapeHtml } from './escape.ts'
import { INLINE_HTML_SHIELD_RE, maskLinkSpans } from './inline-emphasis.ts'
import { inlinePassContext } from './inline-passes.ts'
import { type LinkReferenceMap } from './link-references.ts'

// The render pass runs on encoded text (`encodeBackslashEscapes`), where `\(`
// and `\)` are single PUA characters (U+E000 + charCode) — matching those, not
// raw parens, is what makes `\$` inert and `\(` recognizable in one move.
const ESCAPED_LPAREN = '\uE028'
const ESCAPED_RPAREN = '\uE029'

/** Mask every character inside rendered inline HTML (`<code>`, `<a>`, `<img>`). */
function inlineHtmlMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  for (const match of text.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++) mask[i] = true
  }
  return mask
}

/** Inline-math span content never crosses a line ending (soft or hard break). */
function isContentBarrier(ch: string): boolean {
  return ch === '\n' || ch === '\uFFFE'
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isWhitespaceChar(ch: string): boolean {
  return ch === '' || /\s/.test(ch)
}

/**
 * The inert pending scaffolding for one inline expression. `source` is the
 * canonical TeX (PUA escapes restored to their `\X` form so `\{`, `\$`, `\\`
 * keep their TeX meaning), HTML-escaped; `hydratePendingMath` reads it back
 * via textContent.
 */
function mathInlineHtml(source: string): string {
  return `<span class="math-inline math-inline--pending">${escapeHtml(source)}</span>`
}

function emitMathSpan(rawContent: string): string {
  return inlinePassContext.emit(mathInlineHtml(canonicalizeEscapedPunctuation(rawContent)))
}

/**
 * Index of the `$`-run of exactly `runLen` closing a span opened at `openEnd`,
 * or -1. Content may not cross a masked region (rendered `<code>`/`<a>`) or a
 * line ending; a run of a different length is ordinary content, like code-span
 * backtick matching.
 */
function findDollarClose(text: string, openEnd: number, runLen: number, mask: boolean[]): number {
  let k = openEnd
  while (k < text.length) {
    const ch = text[k] ?? ''
    if (mask[k] || isContentBarrier(ch)) return -1
    if (ch === '$') {
      let runEnd = k
      while (runEnd < text.length && text[runEnd] === '$' && !mask[runEnd]) runEnd++
      if (runEnd - k === runLen) return k
      k = runEnd
      continue
    }
    k++
  }
  return -1
}

/** Closing `\)` (encoded) for a span opened at `openEnd`, or -1. */
function findParenClose(text: string, openEnd: number, mask: boolean[]): number {
  for (let k = openEnd; k < text.length; k++) {
    const ch = text[k] ?? ''
    if (mask[k] || isContentBarrier(ch)) return -1
    if (ch === ESCAPED_RPAREN) return k
  }
  return -1
}

/** remark-math's single-dollar constraints; double-dollar needs only a body. */
function dollarGuardsPass(
  text: string,
  openEnd: number,
  close: number,
  runLen: number,
): boolean {
  if (!/\S/.test(text.slice(openEnd, close))) return false
  if (runLen === 2) return true
  if (isWhitespaceChar(text[openEnd] ?? '')) return false
  if (isWhitespaceChar(text[close - 1] ?? '')) return false
  if (isAsciiDigit(text[close + runLen] ?? '')) return false
  return true
}

/**
 * Replace inline math spans with shielded pending scaffolding. Runs on encoded
 * pipeline text: code spans and angle autolinks are already rendered (masked
 * via the inline-HTML shield), backslash escapes are PUA characters, and
 * complete link spans are masked so destinations can never host math.
 */
export function renderInlineMathSpans(
  text: string,
  linkRefs: LinkReferenceMap = new Map(),
): string {
  if (!text.includes('$') && !text.includes(ESCAPED_LPAREN)) return text
  const mask = maskLinkSpans(text, inlineHtmlMask(text), linkRefs)
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (mask[i]) {
      out += ch
      i++
      continue
    }
    if (ch === ESCAPED_LPAREN) {
      const close = findParenClose(text, i + 1, mask)
      if (close !== -1 && /\S/.test(text.slice(i + 1, close))) {
        out += emitMathSpan(text.slice(i + 1, close))
        i = close + 1
        continue
      }
      out += ch
      i++
      continue
    }
    if (ch === '$') {
      let runEnd = i
      while (runEnd < text.length && text[runEnd] === '$' && !mask[runEnd]) runEnd++
      const runLen = runEnd - i
      // Three or more dollars never delimit (mirrors remark-math).
      if (runLen <= 2) {
        const close = findDollarClose(text, runEnd, runLen, mask)
        if (close !== -1 && dollarGuardsPass(text, runEnd, close, runLen)) {
          out += emitMathSpan(text.slice(runEnd, close))
          i = close + runLen
          continue
        }
      }
      out += text.slice(i, runEnd)
      i = runEnd
      continue
    }
    out += ch
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// Streaming hold (raw pending text — escapes are still literal backslashes).

/** Whether the character at `i` is consumed by a preceding backslash escape. */
function isEscapedAt(s: string, i: number): boolean {
  let backslashes = 0
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) backslashes++
  return backslashes % 2 === 1
}

/** Closing raw `$`-run of exactly `runLen` (unescaped), or -1 — hold variant. */
function findRawDollarClose(s: string, openEnd: number, runLen: number, mask: boolean[]): number {
  let k = openEnd
  while (k < s.length) {
    const ch = s[k] ?? ''
    if (mask[k] || isContentBarrier(ch)) return -1
    if (ch === '$' && !isEscapedAt(s, k)) {
      let runEnd = k
      while (runEnd < s.length && s[runEnd] === '$' && !mask[runEnd]) runEnd++
      if (runEnd - k === runLen && dollarGuardsPass(s, openEnd, k, runLen)) return k
      k = runEnd
      continue
    }
    k++
  }
  return -1
}

/** Closing raw `\)` (unescaped backslash) for the hold walk, or -1. */
function findRawParenClose(s: string, openEnd: number, mask: boolean[]): number {
  for (let k = openEnd; k < s.length - 1; k++) {
    const ch = s[k] ?? ''
    if (mask[k] || isContentBarrier(ch)) return -1
    if (ch === '\\' && s[k + 1] === ')' && !isEscapedAt(s, k)) return k
  }
  return -1
}

/**
 * Streaming: index from which a half-open inline math span should hold, so
 * `$x+` or `\(a` never flashes raw mid-stream (composed into
 * `pendingHoldIndex`, like the strikethrough hold). Currency heuristic: a `$`
 * directly followed by a digit (`$20 and`) — or a trailing `$` directly after
 * one (`20$`) — is far more likely money than an opening delimiter, so it is
 * left visible; if it later completes as valid math, the at-rest render still
 * upgrades it.
 */
export function mathHoldStart(s: string, mask: boolean[]): number {
  let i = 0
  while (i < s.length) {
    if (mask[i]) {
      i++
      continue
    }
    const ch = s[i] ?? ''
    if (ch === '\\' && s[i + 1] === '(' && !isEscapedAt(s, i)) {
      const close = findRawParenClose(s, i + 2, mask)
      if (close === -1) return i
      i = close + 2
      continue
    }
    if (ch === '$' && !isEscapedAt(s, i)) {
      let runEnd = i
      while (runEnd < s.length && s[runEnd] === '$' && !mask[runEnd]) runEnd++
      const runLen = runEnd - i
      if (runLen > 2) {
        i = runEnd
        continue
      }
      const close = findRawDollarClose(s, runEnd, runLen, mask)
      if (close !== -1) {
        i = close + runLen
        continue
      }
      // Unmatched opener. A double run always holds; a single `$` holds unless
      // it reads as currency (digit follows, or a trailing `$` after a digit).
      if (runLen === 2) return i
      const next = s[runEnd] ?? ''
      if (runEnd === s.length) {
        if (!isAsciiDigit(s[i - 1] ?? '')) return i
      } else if (!isWhitespaceChar(next) && !isAsciiDigit(next)) {
        return i
      }
      i = runEnd
      continue
    }
    i++
  }
  return s.length
}
