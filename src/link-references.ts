import { decodeHtmlEntities } from './entity-decoder.ts'
import { canonicalizeEscapedPunctuation } from './backslash-escapes.ts'

/** Parsed link reference definition from block-level `[label]: destination`. */
export interface LinkReference {
  href: string
  title?: string
}

export type LinkReferenceMap = ReadonlyMap<string, LinkReference>

/**
 * CommonMark reference label normalization (whitespace + Unicode case fold).
 * The lower→upper round-trip approximates full case folding the way
 * commonmark.js does: `ẞ`.toLowerCase() is `ß` and `ß`.toUpperCase() is `SS`,
 * so `[ẞ]` matches a `[SS]` definition (spec 540).
 */
export function normalizeReferenceLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase()
}

/** True if `[` or `]` appears unescaped in the label content (a backslash escapes the next char). */
function hasUnescapedBrackets(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '[' || ch === ']') return true
  }
  return false
}

/**
 * A valid CommonMark link label has at least one non-whitespace character and
 * no unescaped brackets, so neither a definition nor a reference is formed by
 * empty labels (`[]`), whitespace-only labels, or bracket-nesting labels like
 * `[foo]` inside `[[foo]]` / `[ref[bar]]` (spec 547, 548, 551, 552, 590).
 */
export function isValidReferenceLabel(raw: string): boolean {
  return raw.trim() !== '' && !hasUnescapedBrackets(raw)
}

/** Escape-aware label canonicalization (raw `\!` and PUA forms both → `!`). */
function decodeEscapes(text: string): string {
  return canonicalizeEscapedPunctuation(text)
}

/** Backslash escapes in link destinations (CommonMark: any ASCII punctuation). */
function decodeDestinationEscapes(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
}

export function decodeHtmlCharRefs(text: string): string {
  // Numeric + named character references, semicolon required (CommonMark).
  // Named coverage is the pluggable set from entity-decoder.ts (HTML4 by
  // default, full HTML5 when a host registers a decoder). Escaped-at-source
  // markup is re-encoded by the caller.
  return decodeHtmlEntities(text)
}

/**
 * Percent-encode an already-decoded href for HTML output (preserves existing
 * %XX sequences). Split out from {@link encodeHrefForOutput} so callers that
 * validate an href's scheme can decode once, check the decoded form, then
 * encode — without a second {@link decodeHtmlCharRefs} pass re-hiding a
 * dangerous scheme behind double-encoded entities (`&amp;#x6a;avascript:`).
 */
export function percentEncodeHref(decoded: string): string {
  let out = ''
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded.charAt(i)
    if (ch === '%' && /^%[0-9A-Fa-f]{2}/.test(decoded.slice(i, i + 3))) {
      out += decoded.slice(i, i + 3)
      i += 2
      continue
    }
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp < 0x80 && /[A-Za-z0-9\-._~:/?#@!$&'()*+,;=]/.test(ch)) {
      out += ch
    } else {
      out += encodeURIComponent(ch)
    }
  }
  return out
}

/** Decode HTML character references then percent-encode an href for output. */
export function encodeHrefForOutput(href: string): string {
  return percentEncodeHref(decodeHtmlCharRefs(href))
}

const TITLE_TOKEN_RES = [/^"((?:\\.|[^"\\])*)"/, /^'((?:\\.|[^'\\])*)'/, /^\(((?:\\.|[^()\\])*)\)/]

/** A blank line — the one thing neither a label, a title, nor a whitespace gap may span. */
const BLANK_LINE_RE = /\n[ \t]*\n/

/**
 * Parse a link title delimited by `"…"`, `'…'`, or `(…)` starting exactly at
 * `at`. Titles may span lines but not blank lines (spec 197).
 */
function parseTitleToken(source: string, at: number): { title: string; end: number } | null {
  const slice = source.slice(at)
  for (const re of TITLE_TOKEN_RES) {
    const m = re.exec(slice)
    if (m?.[1] !== undefined) {
      if (BLANK_LINE_RE.test(m[1])) return null
      return {
        title: decodeHtmlCharRefs(decodeDestinationEscapes(m[1])),
        end: at + m[0].length,
      }
    }
  }
  return null
}

/**
 * Skip the whitespace that must separate a destination from its title: at
 * least one space/tab/newline, at most one newline (a blank line ends the
 * construct). Returns `null` when there is no whitespace at `from` — a title
 * jammed against the destination is not a title (spec 201).
 */
function skipTitleGap(source: string, from: number): number | null {
  let i = from
  let sawNewline = false
  while (i < source.length) {
    const c = source[i]
    if (c === ' ' || c === '\t') i++
    else if (c === '\n' && !sawNewline) {
      sawNewline = true
      i++
    } else break
  }
  return i === from ? null : i
}

/** Parse a link destination (angle-bracketed or bare) with no title attached. */
function parseBareDestination(source: string, start: number): { href: string; end: number } | null {
  if (source[start] === '<') {
    let i = start + 1
    while (i < source.length) {
      if (source[i] === '\n') return null
      if (source[i] === '\\' && i + 1 < source.length) {
        i += 2
        continue
      }
      if (source[i] === '>') {
        return { href: decodeDestinationEscapes(source.slice(start + 1, i)), end: i + 1 }
      }
      i++
    }
    return null
  }

  let i = start
  let parenDepth = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === '(') parenDepth++
    else if (ch === ')') {
      if (parenDepth > 0) parenDepth--
      else break
    } else if (ch === ' ' || ch === '\n' || ch === '\t') {
      // Whitespace ends a bare destination; inside parentheses it means the
      // parens can never balance, so the destination is invalid.
      if (parenDepth > 0) return null
      break
    }
    i++
  }
  const raw = source.slice(start, i)
  if (raw === '') return null
  return { href: decodeDestinationEscapes(raw), end: i }
}

function parseBracketedLabel(source: string, start: number): { label: string; end: number } | null {
  if (source[start] !== '[') return null
  let i = start + 1
  let depth = 1
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') depth--
    i++
  }
  if (depth !== 0) return null
  const label = source.slice(start + 1, i - 1)
  return { label, end: i }
}

/** One parsed definition plus the offset just past its final line. */
export interface LinkReferenceDefinitionSpan {
  label: string
  href: string
  title?: string
  /** Offset just past the definition's final newline (or EOF). */
  end: number
}

/** Offset past the line end at `from` when only spaces/tabs remain on it, else null. */
function cleanLineEnd(source: string, from: number): number | null {
  let i = from
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
  if (i >= source.length) return i
  return source[i] === '\n' ? i + 1 : null
}

/**
 * Parse one link reference definition anchored at `start` — the `[` that opens
 * the label. The caller is responsible for the line-start / up-to-3-spaces
 * indent rule. Implements the spec construct: label + `:` (immediately),
 * destination optionally on the next line, optional whitespace-separated title
 * that may span lines but not blank lines, and nothing but whitespace after
 * the construct on its final line (#209). A title that fails those rules on
 * its own line falls back to a destination-only definition (spec 207); on the
 * destination's line it invalidates the whole definition (spec 197/201).
 */
export function parseLinkReferenceDefinitionAt(
  source: string,
  start: number,
): LinkReferenceDefinitionSpan | null {
  const labelPart = parseBracketedLabel(source, start)
  if (!labelPart || BLANK_LINE_RE.test(labelPart.label)) return null
  if (source[labelPart.end] !== ':') return null
  let j = labelPart.end + 1
  // Spaces/tabs and at most one line ending separate the colon from the
  // destination (CommonMark ref-def whitespace).
  let sawNewline = false
  while (j < source.length) {
    const c = source[j]
    if (c === ' ' || c === '\t') {
      j++
    } else if (c === '\n' && !sawNewline) {
      sawNewline = true
      j++
    } else {
      break
    }
  }
  const dest = parseBareDestination(source, j)
  if (!dest) return null

  const gap = skipTitleGap(source, dest.end)
  if (gap !== null) {
    const title = parseTitleToken(source, gap)
    if (title) {
      const end = cleanLineEnd(source, title.end)
      if (end !== null) {
        return { label: labelPart.label, href: dest.href, title: title.title, end }
      }
      // Dirty tail after the title: when the title began on its own line the
      // definition still stands without it (spec 207); on the destination's
      // line the whole definition fails (spec 197).
      if (!source.slice(dest.end, gap).includes('\n')) return null
    }
  }
  const end = cleanLineEnd(source, dest.end)
  if (end === null) return null
  return { label: labelPart.label, href: dest.href, end }
}

/**
 * Scan text for link reference definitions. First definition wins for a
 * normalized label (#544). This is a raw line-anchored scan with no block
 * context — callers that need fences/paragraph-continuation awareness use
 * `collectLinkReferenceDefinitions` (block-tokenizer.ts), which applies this
 * scanner per `link_ref_def` block.
 */
export function parseLinkReferenceDefinitions(source: string): LinkReferenceMap {
  const refs = new Map<string, LinkReference>()
  let lineStart = 0
  while (lineStart < source.length) {
    let i = lineStart
    let indent = 0
    while (source[i] === ' ' && indent < 4) {
      i++
      indent++
    }
    if (indent <= 3 && source[i] === '[') {
      const def = parseLinkReferenceDefinitionAt(source, i)
      if (def && isValidReferenceLabel(def.label)) {
        const key = normalizeReferenceLabel(decodeEscapes(def.label))
        if (!refs.has(key)) {
          const entry: LinkReference = { href: def.href }
          if (def.title !== undefined) entry.title = def.title
          refs.set(key, entry)
        }
        lineStart = def.end
        continue
      }
    }
    const nl = source.indexOf('\n', lineStart)
    if (nl === -1) break
    lineStart = nl + 1
  }
  return refs
}

export function lookupLinkReference(
  refs: LinkReferenceMap,
  label: string,
): LinkReference | undefined {
  if (!isValidReferenceLabel(label)) return undefined
  return refs.get(normalizeReferenceLabel(decodeEscapes(label)))
}

/** Parse inline destination inside `(...)` after a link label. */
export function parseInlineLinkDestination(
  source: string,
  openParenIndex: number,
): { href: string; end: number; title?: string } | null {
  if (source[openParenIndex] !== '(') return null
  let j = openParenIndex + 1
  while (j < source.length && (source[j] === ' ' || source[j] === '\t' || source[j] === '\n')) j++
  if (source[j] === ')') return { href: '', end: j + 1 }
  const dest = parseBareDestination(source, j)
  if (!dest) return null
  let end = dest.end
  let title: string | undefined
  const gap = skipTitleGap(source, dest.end)
  if (gap !== null) {
    const titlePart = parseTitleToken(source, gap)
    if (titlePart) {
      title = titlePart.title
      end = titlePart.end
    }
  }
  while (
    end < source.length &&
    (source[end] === ' ' || source[end] === '\t' || source[end] === '\n')
  ) {
    end++
  }
  if (source[end] !== ')') return null
  return {
    href: dest.href,
    end: end + 1,
    ...(title !== undefined ? { title } : {}),
  }
}

/** Parse second label in `[text][ref]` form; `[]` uses the first label. */
export function parseReferenceLabel(
  source: string,
  openBracketIndex: number,
  fallbackLabel: string,
): { label: string; end: number } | null {
  if (source[openBracketIndex] !== '[') return null
  if (source[openBracketIndex + 1] === ']') {
    return { label: fallbackLabel, end: openBracketIndex + 2 }
  }
  const parsed = parseBracketedLabel(source, openBracketIndex)
  if (!parsed) return null
  return { label: parsed.label, end: parsed.end }
}

export { parseBracketedLabel, decodeEscapes }
