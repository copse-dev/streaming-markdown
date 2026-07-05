// Streaming edge-case corpus mirrored from Vercel remend's __tests__
// (https://github.com/vercel/streamdown/tree/main/packages/remend/__tests__).
//
// Policy (see docs/streamdown-gap-analysis.md, #12): we adopt remend's *input
// scenarios*, NOT its assertions. remend asserts `remend(str) === healedString`
// — a claim about which closing markers to append to a raw string. This renderer
// emits HTML/DOM with pending states, so those fixtures can't run verbatim, and
// matching remend's expected strings would regress us by design (e.g. remend
// heals `[doc` → `[doc](streamdown:incomplete-link)`, a fake href; we reveal the
// label with no href until the real URL arrives).
//
// So each remend input is fed through our own harness and checked against our
// own invariants instead:
//   1. convergence   — streaming any prefix chunking converges to the fresh
//                       full render (chunk-invariance), like
//                       streaming-convergence.test.ts but on these inputs.
//   2. no-flash       — held constructs never leak their raw marker mid-stream.
//   3. literal-safe   — characters that look like markers but aren't (lone `~`,
//                       `<`, intraword `_`) stay literal, never a tag/entity slip.
//   4. known-gap      — constructs we don't support yet are pinned to current
//                       behaviour so the gap is visible and a future feature
//                       (e.g. KaTeX) trips this test on purpose.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown, splitForStreaming, StreamingMarkdownRenderer } from './streaming.ts'

interface CorpusCase {
  /** Test label. */
  name: string
  /** remend __tests__ file this scenario is drawn from. */
  source: string
  /** The partial (mid-stream) markdown as it would arrive token-by-token. */
  input: string
  /** Patterns that must NOT appear in the visible text while streaming. */
  forbidText?: RegExp[]
  /** Patterns that must NOT appear in the raw streaming HTML (e.g. a real tag). */
  forbidHtml?: RegExp[]
  /** Substrings that must appear in the visible text while streaming. */
  requireText?: string[]
  /** Unsupported feature: pins current pass-through behaviour instead of no-flash. */
  knownGap?: string
  /** Completed form; when set, the fully-committed stream must equal at-rest render. */
  completed?: string
}

const CORPUS: CorpusCase[] = [
  // --- emphasis / code / strike: marker + span held until closed (no flash) ---
  {
    name: 'open bold holds marker and span',
    source: 'bold.test.ts',
    input: 'This is **bold',
    forbidText: [/\*/],
    forbidHtml: [/\*\*/, /<strong>/],
    completed: 'This is **bold** text',
  },
  {
    name: 'mismatched bold (**bold*) holds the whole run',
    source: 'broken-markdown-variants.test.ts',
    input: '**bold*',
    forbidText: [/\*/],
  },
  {
    name: 'open italic holds marker and span',
    source: 'italic.test.ts',
    input: 'this is *italic',
    forbidText: [/\*/],
    forbidHtml: [/<em>/],
    completed: 'this is *italic* here',
  },
  {
    name: 'open underscore italic holds marker and span',
    source: 'italic.test.ts',
    input: 'this is _italic',
    forbidText: [/(?<![A-Za-z0-9])_/],
    forbidHtml: [/<em>/],
    completed: 'this is _italic_ here',
  },
  {
    name: 'bold wrapping an open italic holds both',
    source: 'bold-italic.test.ts',
    input: 'This is **bold with *ital',
    forbidText: [/\*/],
    completed: 'This is **bold with *ital*ic** done',
  },
  {
    name: 'open inline code holds backtick and span',
    source: 'inline-code.test.ts',
    input: 'use `const x = 1',
    forbidText: [/`/],
    forbidHtml: [/<code>/],
    completed: 'use `const x = 1` now',
  },
  {
    name: 'bold then open code holds from first unclosed marker',
    source: 'mixed-formatting.test.ts',
    input: 'Text **bold `code',
    forbidText: [/[*`]/],
  },
  {
    name: 'open strikethrough holds double tilde and span',
    source: 'strikethrough.test.ts',
    input: 'strike ~~through',
    forbidText: [/~~/],
    forbidHtml: [/<del>/],
    completed: 'strike ~~through~~ done',
  },

  // --- literal characters that look like markers but must stay literal ---
  {
    name: 'lone tilde in a range stays literal',
    source: 'single-tilde.test.ts',
    input: 'range 20~25 units',
    requireText: ['20~25'],
    forbidHtml: [/<del>/],
  },
  {
    name: 'spaced tilde stays literal',
    source: 'single-tilde.test.ts',
    input: 'a ~ b',
    requireText: ['a ~ b'],
    forbidHtml: [/<del>/],
  },
  {
    name: 'less-than comparison escapes, never opens a tag',
    source: 'comparison-operators.test.ts',
    input: 'if 20 < 30 then',
    requireText: ['20 < 30'],
    forbidHtml: [/<30/, /<\/?[a-z]+30/],
  },
  {
    name: 'lt/gt operators both escape',
    source: 'comparison-operators.test.ts',
    input: 'x < y and a > b',
    requireText: ['x < y and a > b'],
  },
  {
    name: 'intraword single underscores are not emphasis',
    source: 'underscore-bug.test.tsx',
    input: 'call foo_bar_baz now',
    requireText: ['foo_bar_baz'],
    forbidHtml: [/<em>/],
  },
  {
    name: 'snake_case identifier is not emphasis',
    source: 'underscore-bug.test.tsx',
    input: 'some_variable_name here',
    requireText: ['some_variable_name'],
    forbidHtml: [/<em>/],
  },

  // --- links / images: reveal label/alt, hide bracket + partial URL ---
  {
    name: 'forming link reveals label, no bracket, no href',
    source: 'links.test.ts',
    input: 'Check the [documentation',
    requireText: ['documentation'],
    forbidText: [/\[/],
    forbidHtml: [/<a\b/, /streamdown:incomplete-link/],
    completed: 'Check the [documentation](https://example.com)',
  },
  {
    name: 'forming link with partial URL never leaks the URL',
    source: 'links.test.ts',
    input: 'see [label](https://exa',
    requireText: ['label'],
    forbidText: [/https?:\/\//, /\(/],
    forbidHtml: [/<a\b/],
    completed: 'see [label](https://example.com)',
  },
  {
    name: 'forming image reveals alt, hides ![ and URL',
    source: 'images.test.ts',
    input: 'pic ![alt](https://ex',
    requireText: ['alt'],
    forbidText: [/!\[/, /https?:\/\//],
    forbidHtml: [/<img\b/],
    completed: 'pic ![alt](https://ex.com/a.png)',
  },

  // --- nested structures (blockquote) still hold inner emphasis ---
  {
    name: 'blockquote holds an open bold in its body',
    source: 'streaming.test.ts',
    input: '> Quote with **bold',
    forbidText: [/\*/],
    completed: '> Quote with **bold** text',
  },

  // --- KNOWN GAP: no KaTeX/math support; $$ passes through literally ---
  {
    name: 'math block passes through literally (no KaTeX support)',
    source: 'katex.test.ts',
    input: '$$\\frac{x}{y',
    knownGap: 'katex',
    requireText: ['$$'],
  },
  {
    name: 'inline math passes through literally (no KaTeX support)',
    source: 'katex.test.ts',
    input: 'inline $x^2 + y',
    knownGap: 'katex',
    requireText: ['$x^2'],
  },
]

// --- convergence harness (mirrors streaming-convergence.test.ts) ---

function extractStreamingDisplay(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector('.stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector('.stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector('.stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function streamingDisplayAfterUpdates(markdown: string, cuts: number[]): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (const cut of cuts) renderer.update(markdown.slice(0, cut))
  return extractStreamingDisplay(host)
}

/** Visible text of the string-emitter render for a given input. */
function streamingText(input: string): string {
  const div = document.createElement('div')
  div.innerHTML = renderStreamingMarkdown(input)
  return div.textContent ?? ''
}

describe('remend corpus: chunk-invariant convergence', () => {
  it('every prefix cut converges to the fresh full render', () => {
    for (const c of CORPUS) {
      const fresh = streamingDisplayAfterUpdates(c.input, [c.input.length])
      for (let cut = 0; cut <= c.input.length; cut++) {
        const viaHistory = streamingDisplayAfterUpdates(c.input, [cut, c.input.length])
        assert.equal(viaHistory, fresh, `${c.name} [${c.source}] cut=${String(cut)}`)
      }
    }
  })
})

describe('remend corpus: no raw-syntax flash while streaming', () => {
  for (const c of CORPUS) {
    if (c.knownGap) continue
    it(`${c.name} [${c.source}]`, () => {
      const text = streamingText(c.input)
      const html = renderStreamingMarkdown(c.input)
      for (const re of c.forbidText ?? []) {
        assert.doesNotMatch(text, re, `visible text leaked ${String(re)}: ${JSON.stringify(text)}`)
      }
      for (const re of c.forbidHtml ?? []) {
        assert.doesNotMatch(html, re, `html leaked ${String(re)}: ${html}`)
      }
      for (const needle of c.requireText ?? []) {
        assert.ok(text.includes(needle), `visible text missing ${JSON.stringify(needle)}: ${JSON.stringify(text)}`)
      }
    })
  }
})

describe('remend corpus: completed forms match at-rest render', () => {
  for (const c of CORPUS) {
    if (!c.completed) continue
    it(`${c.name} [${c.source}]`, () => {
      // A single line with no trailing newline is held as a pending tail until
      // the line ends, so terminate it to force the block to commit. Once
      // committed (no pending tail) the streaming render must equal the
      // sanitized at-rest render — the markers closed and nothing stays held.
      const completed = (c.completed as string) + '\n'
      assert.equal(splitForStreaming(completed).pending, '', `${completed} left a pending tail`)
      const streamed = streamingDisplayAfterUpdates(completed, [completed.length])
      const atRest = sanitizeRenderedMarkdown(renderMarkdown(completed))
      assert.equal(streamed, atRest, `completed=${JSON.stringify(completed)}`)
    })
  }
})

describe('remend corpus: known gaps (pinned so a future feature trips this)', () => {
  for (const c of CORPUS) {
    if (!c.knownGap) continue
    it(`${c.knownGap}: ${c.name} [${c.source}]`, () => {
      // No support yet — the source passes through as literal text. When the
      // feature lands, update this expectation (and remove the gap flag).
      const text = streamingText(c.input)
      for (const needle of c.requireText ?? []) {
        assert.ok(text.includes(needle), `expected literal pass-through of ${JSON.stringify(needle)}: ${JSON.stringify(text)}`)
      }
    })
  }
})
