// Gap-discovery corpus mined from remend's `__tests__` (Vercel/streamdown).
//
// We adopt remend's streaming edge-case INPUTS, not its assertions: remend
// asserts `remend(input) === healedString` (which closing markers to append to
// a raw string), a claim about an output type copse does not produce. copse
// emits HTML/DOM with engineered pending states, so instead of matching a
// healed string we assert copse's OWN invariants on each input:
//   (a) no raw markdown marker "flashes" as structural markup in any prefix frame,
//   (b) once the input commits, the streamed render equals the static render,
//   (c) every prefix converges to the same fresh full streamed render.
// See docs/decisions/0001-streaming-markdown-vs-remend-streamdown.md.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
} from './streaming.ts'

/** Visible streaming HTML: committed blocks + any forming table + live tail. */
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
  for (const cut of cuts) {
    renderer.update(markdown.slice(0, cut))
  }
  return extractStreamingDisplay(host)
}

/** Every prefix length — the corpus inputs are short, so exhaustive is cheap. */
function everyPrefix(text: string): number[] {
  return Array.from({ length: text.length + 1 }, (_, i) => i)
}

/** Parse a streamed HTML frame into a detached element for structural queries. */
function frameElement(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

interface CorpusCase {
  /** remend `__tests__` file this input is mined from. */
  readonly source: string
  readonly input: string
  /**
   * Structural markup that must never appear in any prefix frame — the marker
   * would be a mid-stream "flash" copse deliberately holds back.
   */
  readonly forbiddenSelectors: string
  /** Substrings that must never appear in any prefix frame (e.g. a partial URL). */
  readonly forbiddenText?: readonly RegExp[]
  /**
   * When true, the marker stays literal text end to end: every prefix frame's
   * visible text is a prefix of the raw input (a half-open trailing marker may
   * be *held*, never turned into markup or extra characters), and the full
   * input reveals the marker verbatim.
   */
  readonly literalText?: boolean
}

const CORPUS: readonly CorpusCase[] = [
  {
    source: 'single-tilde.test.ts',
    input: '20~25',
    // A lone `~` must never open a strikethrough while streaming.
    forbiddenSelectors: 'del, s, strike',
    literalText: true,
  },
  {
    source: 'comparison-operators.test.ts',
    input: '20 < 30',
    // `<` is escaped, never a spurious tag or entity-driven element mid-stream.
    forbiddenSelectors: 'del, s, em, strong, a, img',
    literalText: true,
  },
  {
    source: 'underscore-bug',
    input: 'foo_bar_baz',
    // Intra-word underscores must not italicise mid-stream.
    forbiddenSelectors: 'em, strong, i, b',
    literalText: true,
  },
  {
    source: 'images.test.ts',
    input: '![alt](partial',
    // A forming image reveals its alt text — never a broken <img>/partial src.
    forbiddenSelectors: 'img',
    forbiddenText: [/src=/, /partial/],
  },
  {
    source: 'images.test.ts (link form)',
    input: '[alt](partial',
    // A forming link reveals label only — no <a>, no partial destination.
    forbiddenSelectors: 'a',
    forbiddenText: [/partial/],
  },
  {
    source: 'incomplete-link.test.ts (bare label)',
    input: '[documentation',
    // Label-only reveal: no placeholder href (copse's divergence from remend).
    forbiddenSelectors: 'a',
    forbiddenText: [/\[documentation/],
  },
  {
    source: 'incomplete-link.test.ts (opened destination)',
    input: '[Click here](http://exam',
    // No clickable partial href, no partial URL text, until the URL closes.
    forbiddenSelectors: 'a',
    forbiddenText: [/http:\/\/exam/],
  },
]

describe('remend corpus: no marker flash across prefix frames (invariant a)', () => {
  for (const testCase of CORPUS) {
    it(`${testCase.source}: ${JSON.stringify(testCase.input)}`, () => {
      for (const cut of everyPrefix(testCase.input)) {
        const prefix = testCase.input.slice(0, cut)
        const frame = renderStreamingMarkdown(prefix)
        const el = frameElement(frame)
        assert.equal(
          el.querySelectorAll(testCase.forbiddenSelectors).length,
          0,
          `unexpected ${testCase.forbiddenSelectors} at prefix ${JSON.stringify(prefix)}`,
        )
        for (const pattern of testCase.forbiddenText ?? []) {
          assert.doesNotMatch(
            frame,
            pattern,
            `unexpected ${String(pattern)} at prefix ${JSON.stringify(prefix)}`,
          )
        }
        if (testCase.literalText) {
          const visible = el.textContent ?? ''
          // Visible text is always a prefix of the raw input: a half-open
          // trailing marker may be held back, but nothing is injected and no
          // marker becomes markup.
          assert.ok(
            testCase.input.startsWith(visible),
            `visible text ${JSON.stringify(visible)} is not a prefix of the input at ${JSON.stringify(prefix)}`,
          )
          // At the full input the marker is revealed verbatim as literal text.
          if (cut === testCase.input.length) {
            assert.equal(visible, testCase.input, 'full input did not reveal the marker literally')
          }
        }
      }
    })
  }
})

describe('remend corpus: every prefix converges to the fresh full render (invariant c)', () => {
  for (const testCase of CORPUS) {
    it(`${testCase.source}: ${JSON.stringify(testCase.input)}`, () => {
      const markdown = testCase.input
      const fresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      for (const cut of everyPrefix(markdown)) {
        const viaHistory = streamingDisplayAfterUpdates(markdown, [cut, markdown.length])
        assert.equal(viaHistory, fresh, `cut=${String(cut)}`)
      }
    })
  }
})

describe('remend corpus: committed render equals the static render (invariant b)', () => {
  for (const testCase of CORPUS) {
    it(`${testCase.source}: ${JSON.stringify(testCase.input)}`, () => {
      // A trailing blank line commits the forming line so nothing stays pending.
      const committed = `${testCase.input}\n\n`
      assert.equal(
        splitForStreaming(committed).pending,
        '',
        'expected the input to fully commit after a blank line',
      )
      const streamed = streamingDisplayAfterUpdates(committed, [committed.length])
      const atRest = sanitizeRenderedMarkdown(renderMarkdown(committed))
      assert.equal(streamed, atRest)
    })
  }
})
