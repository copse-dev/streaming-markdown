/** Shared block-level line patterns and fence helpers (tokenizer + renderer). */
import { decodeHtmlEntities } from './entity-decoder.ts'

/** Width of a line's leading whitespace in columns, expanding tabs to 4-col stops. */
export function leadingIndentWidth(line: string): number {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/**
 * Remove up to four columns of leading indentation, expanding tabs to 4-col
 * stops. A tab that straddles the fourth column leaves its remainder as spaces
 * (CommonMark tab handling for indented code).
 */
export function stripFourColumnIndent(line: string): string {
  let col = 0
  let i = 0
  while (i < line.length && col < 4) {
    const ch = line[i]
    if (ch === ' ') {
      col++
      i++
      continue
    }
    if (ch === '\t') {
      const advance = 4 - (col % 4)
      if (col + advance > 4) return ' '.repeat(col + advance - 4) + line.slice(i + 1)
      col += advance
      i++
      continue
    }
    break
  }
  return line.slice(i)
}

// A backtick fence's info string may not contain backticks, but a tilde
// fence's may contain anything — even ``` (spec 146).
export const FENCE_OPEN_RE = /^ {0,3}(?:(`{3,})([^\n`]*)|(~{3,})([^\n]*?))\s*$/
export const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

/** ATX heading detection (tokenizer): `#` through `######` followed by space, tab, or EOL. */
export const ATX_HEADING_DETECT_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/

/** ATX heading capture (renderer): optional title after `#` markers (space or tab separator). */
export const ATX_HEADING_CAPTURE_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/

/** Blockquote line detection (CommonMark: up to 3 spaces, `>`, optional space). */
export const BLOCKQUOTE_DETECT_RE = /^ {0,3}> ?/

/** Expand a whitespace run starting at `i`/`col` to spaces at 4-column tab stops. */
function expandWhitespaceRun(
  text: string,
  i: number,
  col: number,
): { out: string; i: number; col: number } {
  let out = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ') {
      out += ' '
      col++
      i++
    } else if (ch === '\t') {
      const advance = 4 - (col % 4)
      out += ' '.repeat(advance)
      col += advance
      i++
    } else break
  }
  return { out, i, col }
}

/**
 * Expand tabs in a line's leading whitespace to spaces at 4-column stops
 * (CommonMark block-structure tab handling, spec 4/5/9). Content past the
 * first non-whitespace character is untouched — tabs there stay literal.
 */
export function expandLeadingTabs(line: string): string {
  const lead = expandWhitespaceRun(line, 0, 0)
  return lead.out + line.slice(lead.i)
}

/**
 * Like {@link expandLeadingTabs}, but also expands the whitespace straight
 * after a list marker at its absolute column (`-\t\tfoo`, spec 7), so
 * character offsets equal columns throughout the marker prefix.
 */
export function expandListPrefixTabs(line: string): string {
  const lead = expandWhitespaceRun(line, 0, 0)
  const marker = /^(?:\d{1,9}[.)]|[-*+])/.exec(line.slice(lead.i))?.[0]
  if (!marker) return lead.out + line.slice(lead.i)
  const after = expandWhitespaceRun(line, lead.i + marker.length, lead.col + marker.length)
  return lead.out + marker + after.out + line.slice(after.i)
}

/**
 * Strip one blockquote marker level from a line. The marker consumes one
 * optional following space — or one COLUMN of a following tab, whose
 * remaining columns become spaces (`>\t\tfoo` → six columns of code indent,
 * spec 6).
 */
export function stripBlockquoteMarker(line: string): string {
  const m = /^ {0,3}>/.exec(line)
  if (!m) return line
  const rest = line.slice(m[0].length)
  if (!/^[\t ]/.test(rest)) return rest
  const expanded = expandWhitespaceRun(rest, 0, m[0].length)
  return expanded.out.slice(1) + rest.slice(expanded.i)
}

/** Drop the block-terminating newline token slices include. */
export function dropTrailingNewline(slice: string): string {
  return slice.endsWith('\n') ? slice.slice(0, -1) : slice
}

/** Strip optional ATX closing hash run (` ##` at end of heading text). */
export function stripAtxClosingHashes(title: string): string {
  // A title that is nothing but hashes ("### ###") is a bare closing sequence.
  if (/^#+\s*$/.test(title)) return ''
  return title.replace(/(?<!\\)\s+#+\s*$/, '').trimEnd()
}

export function fenceMarker(line: string): { marker: string; len: number; info: string } | null {
  const m = line.match(FENCE_OPEN_RE)
  const marker = m?.[1] ?? m?.[3]
  if (!marker) return null
  return { marker, len: marker.length, info: ((m?.[1] ? m[2] : m?.[4]) ?? '').trim() }
}

/** Number of leading spaces on the opening fence line (CommonMark allows 0–3). */
function fenceOpenIndent(open: string): number {
  return open.match(/^ {0,3}/)?.[0].length ?? 0
}

/** Remove up to `max` leading spaces from a content line (fence-indent removal). */
function stripLeadingSpaces(line: string, max: number): string {
  let i = 0
  while (i < max && line[i] === ' ') i++
  return line.slice(i)
}

const FENCE_INFO_BACKSLASH_RE = /\\([!-/:-@[-`{-~])/g

/**
 * The code-fence language: the first word of the info string, with backslash
 * escapes and HTML entities decoded (CommonMark spec #24, ``` ```foo\+bar ```
 * → `language-foo+bar`). Everything after the first whitespace run is metadata
 * and does not affect the language class.
 */
export function fenceInfoLanguage(info: string): string {
  const firstWord = info.trim().split(/\s+/)[0] ?? ''
  if (!firstWord) return ''
  return decodeHtmlEntities(firstWord.replace(FENCE_INFO_BACKSLASH_RE, '$1'))
}

export function fenceCloses(marker: string, len: number, line: string): boolean {
  const m = line.match(FENCE_CLOSE_RE)
  if (!m?.[1] || m[1][0] !== marker[0]) return false
  return m[1].length >= len
}

export function parseFenceSlice(slice: string): { lang: string; code: string } {
  const lines = dropTrailingNewline(slice).split('\n')
  const open = lines[0] ?? ''
  const openFence = fenceMarker(open)
  const marker = openFence?.marker ?? '```'
  const lang = fenceInfoLanguage(openFence?.info ?? '')
  const indent = fenceOpenIndent(open)
  let closeIndex = lines.length - 1
  while (closeIndex > 0) {
    const line = lines[closeIndex] ?? ''
    if (fenceCloses(marker, marker.length, line)) {
      break
    }
    closeIndex--
  }
  // An unclosed fence is closed by the end of the document: everything after
  // the opener is content (spec 127/137/139).
  const contentEnd = closeIndex > 0 ? closeIndex : lines.length
  // Content is verbatim between the fences (blank lines and indentation kept);
  // only the opening fence's own indentation is stripped, per spec. Every
  // content line is newline-terminated, including the last — a bare `join`
  // would silently drop a trailing blank line (spec 318).
  const contentLines = lines.slice(1, contentEnd)
  const code = contentLines.map((line) => stripLeadingSpaces(line, indent)).join('\n')
  return { lang, code: contentLines.length > 0 ? `${code}\n` : code }
}

/** Parse an open (still streaming) fenced block — body includes all lines after the opener. */
export function parseOpenFenceContent(source: string): { lang: string; code: string } | null {
  const lines = source.split('\n')
  const open = lines[0] ?? ''
  const openFence = fenceMarker(open)
  if (!openFence) return null
  const lang = fenceInfoLanguage(openFence.info)
  const indent = fenceOpenIndent(open)
  let bodyLines = lines.slice(1)
  const last = bodyLines.at(-1) ?? ''
  if (bodyLines.length > 0 && fenceCloses(openFence.marker, openFence.len, last)) {
    bodyLines = bodyLines.slice(0, -1)
  }
  return { lang, code: bodyLines.map((line) => stripLeadingSpaces(line, indent)).join('\n') }
}
