/**
 * CommonMark backslash escapes (#593).
 *
 * A backslash before an ASCII punctuation character makes it literal and inert:
 * it must not open emphasis, links, code spans, headings, autolinks, etc. The
 * inline pipeline is a sequence of string passes, so escapes are handled by
 * ENCODING each escaped punctuation character to a private-use-area codepoint
 * (U+E000 + charCode) before any pass runs, and DECODING back to the literal
 * character (HTML-escaped) after the final escape pass. No pass recognizes the
 * PUA characters, so escaped punctuation flows through as plain text.
 *
 * Escapes do not apply inside code spans (backslashes there are literal) or
 * inside angle autolinks — both regions are copied verbatim by the encoder.
 * An escaped backtick cannot open a code span precisely because the encoder
 * walks left to right: the backslash consumes the backtick before the code
 * span scanner (which runs on encoded text) ever sees it.
 */
import { decodeHtmlEntities } from './entity-decoder.ts'
import { ANGLE_AUTOLINK_VERBATIM_RE, nextCodeSpan } from './inline-code-spans.ts'

const ESCAPED_BASE = 0xe000

/** ASCII punctuation per the CommonMark spec's escapable set. */
function isEscapablePunctuation(ch: string): boolean {
  return /^[!-/:-@[-`{-~]$/.test(ch)
}

/**
 * Angle autolinks are verbatim regions: backslash escapes do not apply. The
 * email branch mirrors the spec's email grammar closely enough to exclude
 * backslash from the local part — `<foo\+@bar.example.com>` is NOT an email
 * autolink, so its `\+` escape must still be processed (spec 606).
 */
const ANGLE_AUTOLINK_RE = ANGLE_AUTOLINK_VERBATIM_RE

/**
 * Raw inline `<tag ...>` spans are verbatim regions too (matches
 * markHardBreaks). This follows the CommonMark open/closing-tag grammar rather
 * than a lenient `<letter…>` scan: something like `<foo\>` is not a valid tag,
 * so the `\>` escape inside it stays live (spec 493).
 */
const TAG_NAME = '[a-zA-Z][a-zA-Z0-9-]*'
const TAG_ATTR = `\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?`
export const RAW_TAG_LIKE_RE = new RegExp(
  `^(?:<${TAG_NAME}(?:${TAG_ATTR})*\\s*/?>|</${TAG_NAME}\\s*>)`,
)

/** A complete entity/numeric character reference candidate (semicolon required). */
const ENTITY_CANDIDATE_RE = /^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,31};)/

/** Trailing text that could still grow into a valid reference (streaming hold). */
const INCOMPLETE_ENTITY_RE = /&(?:#[0-9]{0,7}|#[xX][0-9a-fA-F]{0,6}|[a-zA-Z][a-zA-Z0-9]{0,31})?$/

/** Encode a decoded-literal character: ASCII punctuation becomes inert PUA. */
function encodeLiteralChar(ch: string): string {
  return isEscapablePunctuation(ch) ? String.fromCharCode(ESCAPED_BASE + ch.charCodeAt(0)) : ch
}

/**
 * Start index of a trailing incomplete entity/char reference, or `s.length`
 * when none. Streaming pending tails hold from here so `&amp` never flashes
 * literally before its semicolon arrives.
 */
export function trailingEntityHoldStart(s: string): number {
  const window = Math.min(34, s.length)
  const m = INCOMPLETE_ENTITY_RE.exec(s.slice(s.length - window))
  if (!m) return s.length
  return s.length - window + m.index
}

/** Encode `\X` (X = ASCII punctuation) to inert PUA characters. Idempotent. */
export function encodeBackslashEscapes(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '`') {
      const span = nextCodeSpan(text, i)
      if (span && span.type === 'closed' && span.open === i) {
        out += text.slice(i, span.closeEnd)
        i = span.closeEnd
        continue
      }
      const runEnd = span && span.type === 'unclosed' && span.open === i ? i + span.runLen : i + 1
      out += text.slice(i, runEnd)
      i = runEnd
      continue
    }
    if (ch === '<') {
      const verbatim =
        ANGLE_AUTOLINK_RE.exec(text.slice(i))?.[0] ?? RAW_TAG_LIKE_RE.exec(text.slice(i))?.[0]
      if (verbatim) {
        out += verbatim
        i += verbatim.length
        continue
      }
    }
    if (ch === '&') {
      const candidate = ENTITY_CANDIDATE_RE.exec(text.slice(i))?.[0]
      if (candidate) {
        const decoded = decodeHtmlEntities(candidate)
        if (decoded !== candidate) {
          for (const c of decoded) out += encodeLiteralChar(c)
          i += candidate.length
          continue
        }
      }
    }
    const next = text[i + 1] ?? ''
    if (ch === '\\' && isEscapablePunctuation(next)) {
      out += String.fromCharCode(ESCAPED_BASE + next.charCodeAt(0))
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

const ENCODED_PUNCT_RE = /[\uE021-\uE07E]/g

const DECODE_HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Decode PUA-encoded escaped punctuation back to its literal character,
 * HTML-escaped so the result is safe in both text and attribute contexts.
 */
export function decodeEscapedPunctuation(html: string): string {
  return html.replace(ENCODED_PUNCT_RE, (c) => {
    const ch = String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE)
    return DECODE_HTML_ESCAPES[ch] ?? ch
  })
}

/**
 * Decode PUA-encoded escaped punctuation to the raw character (no HTML
 * escaping). For contexts that re-encode themselves: link destinations before
 * percent-encoding, and reference-label canonicalization.
 */
export function decodeEscapedPunctuationRaw(text: string): string {
  return text.replace(ENCODED_PUNCT_RE, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE))
}

/**
 * Canonicalize backslash escapes for reference-label matching: `foo\!` (raw)
 * and its PUA-encoded form both become `foo\!` — the backslash is KEPT, because
 * label matching treats an escaped character as distinct from the bare one
 * (`[foo\!]` does not match a `[foo!]` definition, spec 545). Definitions
 * parsed from raw source and labels parsed from encoded inline text land on the
 * same canonical form either way.
 */
export function canonicalizeEscapedPunctuation(text: string): string {
  return encodeBackslashEscapes(text).replace(
    ENCODED_PUNCT_RE,
    (c) => `\\${String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE)}`,
  )
}
