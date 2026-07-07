import { dropTrailingNewline } from './block-patterns.ts'
import { escapeHtml } from './escape.ts'

// Display-math block scaffolding (#70): the string/DOM emission shared by the
// `$$ … $$` / `\[ … \]` block construct (block-tokenizer.ts, render-blocks.ts)
// and the built-in ```math fence handler (fence-handlers.ts). Like mermaid, the
// generator emits only inert, escaped scaffolding
// (`<div class="math-block math-block--pending"><pre class="math">…`) built
// from allowlisted tags; the KaTeX library stays behind
// `@copse/streaming-markdown/math/katex` and hydrates the scaffolding after the
// sink sanitizer via `hydratePendingMath` (`math.ts`).

/** Which display-math delimiter pair a block uses. */
export type MathBlockDelimiter = 'dollar' | 'bracket'

/** A recognized display-math start line (own-line opener or one-line block). */
export interface MathBlockStart {
  delimiter: MathBlockDelimiter
  /** The line is a complete `$$ … $$` / `\[ … \]` one-liner (non-empty body). */
  oneline: boolean
}

// Delimiters follow CommonMark block conventions: up to three columns of
// indentation (four is indented code), nothing else on the line. `$$` (and the
// OpenAI-style `\[` / `\]`) must sit on their own line to open a multi-line
// block; a single line carrying both delimiters around a non-empty body is a
// complete one-line block (`$$E=mc^2$$`, `\[ E=mc^2 \]`).
const MATH_DOLLAR_LINE_RE = /^ {0,3}\$\$\s*$/
const MATH_BRACKET_OPEN_LINE_RE = /^ {0,3}\\\[\s*$/
const MATH_BRACKET_CLOSE_LINE_RE = /^ {0,3}\\\]\s*$/
const MATH_OPEN_PREFIX_RE = /^ {0,3}(\$\$|\\\[)/

/** Body of a trimmed one-line `$$…$$` / `\[…\]`, or null when not one. */
function onelineMathBody(trimmed: string, delimiter: MathBlockDelimiter): string | null {
  const [open, close] = delimiter === 'dollar' ? ['$$', '$$'] : ['\\[', '\\]']
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return null
  if (trimmed.length < open.length + close.length + 1) return null
  const body = trimmed.slice(open.length, -close.length)
  return body.trim() === '' ? null : body
}

/**
 * Classify a line as a display-math start: an own-line `$$` / `\[` opener, or a
 * complete one-line block. Returns null for anything else — a line with content
 * after the opener but no closer (`$$ x`) is ordinary prose, not math.
 */
export function mathBlockDelimiterLine(line: string): MathBlockStart | null {
  const m = MATH_OPEN_PREFIX_RE.exec(line)
  if (!m) return null
  const delimiter: MathBlockDelimiter = m[1] === '$$' ? 'dollar' : 'bracket'
  if (delimiter === 'dollar' ? MATH_DOLLAR_LINE_RE.test(line) : MATH_BRACKET_OPEN_LINE_RE.test(line)) {
    return { delimiter, oneline: false }
  }
  if (onelineMathBody(line.trim(), delimiter) !== null) return { delimiter, oneline: true }
  return null
}

/**
 * Streaming: classify a still-unterminated final line that may yet grow into a
 * display-math block. Anything starting with `$$` / `\[` (after up to three
 * spaces) qualifies — a partial `$$E=mc` is held as an open math block until
 * its newline decides between a one-line block and ordinary prose. The one
 * exclusion is a delimiter pair around an *empty* body (`\[\]`, `$$$$`): the
 * spec's escaped-punctuation examples demand literal text there, so it reads
 * as prose immediately (even at rest, where input often lacks a final newline).
 */
export function mathBlockOpenCandidate(line: string): MathBlockStart | null {
  const complete = mathBlockDelimiterLine(line)
  if (complete) return complete
  const m = MATH_OPEN_PREFIX_RE.exec(line)
  if (!m) return null
  const delimiter: MathBlockDelimiter = m[1] === '$$' ? 'dollar' : 'bracket'
  const trimmed = line.trim()
  const close = delimiter === 'dollar' ? '$$' : '\\]'
  if (trimmed.length >= 4 && trimmed.endsWith(close) && onelineMathBody(trimmed, delimiter) === null) {
    return null
  }
  return { delimiter, oneline: false }
}

/** Whether `line` closes a multi-line math block opened with `delimiter`. */
export function mathBlockCloses(delimiter: MathBlockDelimiter, line: string): boolean {
  return delimiter === 'dollar'
    ? MATH_DOLLAR_LINE_RE.test(line)
    : MATH_BRACKET_CLOSE_LINE_RE.test(line)
}

/** TeX body of a tokenized math block slice (delimiters stripped, verbatim). */
export function parseMathBlockSlice(slice: string): string {
  const lines = dropTrailingNewline(slice).split('\n')
  const first = lines[0] ?? ''
  const start = mathBlockDelimiterLine(first) ?? mathBlockOpenCandidate(first)
  if (start?.oneline) return onelineMathBody(first.trim(), start.delimiter) ?? ''
  let end = lines.length
  const last = lines.at(-1)
  // An unclosed block is closed by the end of the document, like a fence.
  if (start && lines.length > 1 && last !== undefined && mathBlockCloses(start.delimiter, last)) {
    end = lines.length - 1
  }
  return lines.slice(1, end).join('\n')
}

/** Trailing partial closer on a still-streaming one-liner (`$`, `$$`, `\`, `\]`). */
const PARTIAL_DOLLAR_CLOSER_RE = /\${1,2}\s*$/
const PARTIAL_BRACKET_CLOSER_RE = /\\\]?\s*$/
/** A body line that is only a partial closer (`$` / `\`), dropped while forming. */
const PARTIAL_DOLLAR_CLOSER_LINE_RE = /^ {0,3}\$\s*$/
const PARTIAL_BRACKET_CLOSER_LINE_RE = /^ {0,3}\\\s*$/

/**
 * Body shown while a math block is still streaming: the opener (and any partial
 * closer already typed) is stripped so raw `$$` / `\[` never flashes in the
 * forming scaffolding.
 */
export function parseOpenMathBlock(source: string): string {
  const lines = source.split('\n')
  const first = lines[0] ?? ''
  const start = mathBlockOpenCandidate(first)
  if (!start) return source
  if (lines.length === 1) {
    // A complete one-liner (`$$x$$` on the still-unterminated final line).
    if (start.oneline) return onelineMathBody(first.trim(), start.delimiter) ?? ''
    // Own-line opener alone — no body streamed yet.
    if (mathBlockDelimiterLine(first)) return ''
    // Partial one-liner (`$$E=mc` / `\[ E=mc`): body follows the opener.
    const body = first.trim().slice(2)
    return body
      .replace(start.delimiter === 'dollar' ? PARTIAL_DOLLAR_CLOSER_RE : PARTIAL_BRACKET_CLOSER_RE, '')
      .trim()
  }
  let end = lines.length
  const last = lines.at(-1) ?? ''
  const partialCloserLine =
    start.delimiter === 'dollar' ? PARTIAL_DOLLAR_CLOSER_LINE_RE : PARTIAL_BRACKET_CLOSER_LINE_RE
  if (end > 1 && partialCloserLine.test(last) && last.trim() !== '') end = lines.length - 1
  return lines.slice(1, end).join('\n')
}

/**
 * At-rest scaffolding for a display-math block. Inert and allowlisted (the
 * sink sanitizer passes `div`/`pre` + `class` unchanged); `hydratePendingMath`
 * upgrades it after sanitization. `extraClass` carries the forming-state class
 * while the block is still streaming.
 */
export function mathBlockHtml(source: string, extraClass = ''): string {
  const cls = extraClass ? ` ${extraClass}` : ''
  return `<div class="math-block math-block--pending${cls}"><pre class="math">${escapeHtml(source)}</pre></div>`
}

/**
 * Forward-pass DOM update for forming math scaffolding (shared by the ```math
 * fence handler and the `$$` block's streaming path). Recreates its own
 * scaffolding when the container holds foreign content, then patches only the
 * source text — a minimal per-token update, like the mermaid handler's sync.
 */
export function syncFormingMathBlockDom(
  container: HTMLElement,
  source: string,
  formingClass: string,
): void {
  let block = container.querySelector<HTMLElement>(`.math-block.${formingClass}`)
  if (!block) {
    container.replaceChildren()
    block = document.createElement('div')
    block.className = `math-block math-block--pending ${formingClass}`
    const pre = document.createElement('pre')
    pre.className = 'math'
    block.append(pre)
    container.append(block)
  }
  const pre = block.querySelector('pre.math')
  if (pre) pre.textContent = source
}
