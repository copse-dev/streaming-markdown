// `StreamingMarkdownRenderer.finish()` — the end-of-stream call. Mid-stream the
// renderer holds what a later character could still change (a trailing
// `~~old`, the last table row / list item / paragraph line) and shows unclosed
// fences, `$$` blocks and tables as forming scaffolding. After `finish(text)`
// the committed subtree must equal the at-rest render of `text`, with nothing
// left pending or forming, whatever streaming history led there; and a later
// `update()` must resume streaming exactly as a fresh renderer would.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { loadGfmExtensionBaselineExamples } from '../tests/gfm/baseline-examples.ts'
import { streamingCutIndices } from '../tests/streaming-cuts.ts'
import { renderMarkdown } from './renderer.ts'
import { StreamingMarkdownRenderer, type StreamingMarkdownOptions } from './streaming.ts'

/** Visible streaming HTML: committed blocks + any forming block + live tail. */
function display(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector(':scope > .stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector(':scope > .stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector(':scope > .stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function freshStreamingDisplay(text: string, options: StreamingMarkdownOptions = {}): string {
  const host = document.createElement('div')
  new StreamingMarkdownRenderer(host, options).update(text)
  return display(host)
}

// `finish()` commits the final text line-terminated (see `finishWithPolicy`).
// For three shapes `renderMarkdown` itself renders an unterminated last line
// differently from the terminated one, and in each the terminated render is
// the spec-correct one (end of input ends the line in CommonMark):
//   - a setext underline after a multi-line paragraph (`a\nb\n=`, `a\nb\n--`)
//     stays `<p>` at rest — #105 resolved only the single-line form;
//   - an unterminated delimiter row whose column count does not match the
//     header (`| a | b |\n| - |`) renders a header-only table at rest, where
//     GFM requires a matching row (terminated: a paragraph);
//   - a link reference definition whose destination is still invalid
//     (`[a]:my_(url` — unbalanced paren) renders nothing at rest, as if it
//     were a definition (terminated: a paragraph).
// Those inputs are compared against the terminated render; any OTHER
// divergence fails the test, so the carve-out cannot silently widen.
const SETEXT_UNDERLINE_LINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/
const DELIMITER_ROW_LINE_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const LINK_DEFINITION_LINE_RE = /^ {0,3}\[.*\]:/
const atRestDivergences = new Set<string>()

/** What a finished renderer must show for `text` (see the note above). */
function expectedFinished(text: string, options: StreamingMarkdownOptions): string {
  const atRest = renderMarkdown(text, options)
  if (text === '' || text.endsWith('\n')) return atRest
  const terminated = renderMarkdown(`${text}\n`, options)
  if (terminated !== atRest) {
    const lastLine = text.slice(text.lastIndexOf('\n') + 1)
    assert.ok(
      (text.includes('\n') &&
        (SETEXT_UNDERLINE_LINE_RE.test(lastLine) || DELIMITER_ROW_LINE_RE.test(lastLine))) ||
        LINK_DEFINITION_LINE_RE.test(lastLine),
      `unexpected at-rest divergence for ${JSON.stringify(text)}`,
    )
    atRestDivergences.add(text)
  }
  return terminated
}

/**
 * The finished-state contract: `.stream-complete` is byte-identical to the
 * at-rest render, it carries no streaming-only classes, and the host-level
 * forming / pending elements are empty and hidden.
 */
function assertFinished(
  host: HTMLElement,
  text: string,
  label: string,
  options: StreamingMarkdownOptions = {},
): void {
  const complete = host.querySelector(':scope > .stream-complete')
  assert.ok(complete, `${label}: .stream-complete exists`)
  assert.equal(complete.innerHTML, expectedFinished(text, options), `${label}: matches at-rest`)
  const leftovers = complete.querySelectorAll(
    '.stream-pending, .stream-pending-block, .stream-pending-row, .stream-fence-forming, .stream-table-forming, .stream-forming-inline-code',
  )
  assert.equal(leftovers.length, 0, `${label}: no pending/forming markup left`)
  const forming = host.querySelector(':scope > .stream-forming') as HTMLElement
  assert.equal(forming.hidden, true, `${label}: forming hidden`)
  assert.equal(forming.childNodes.length, 0, `${label}: forming empty`)
  const pending = host.querySelector(':scope > .stream-pending') as HTMLElement
  assert.equal(pending.hidden, true, `${label}: pending hidden`)
  assert.equal(pending.childNodes.length, 0, `${label}: pending empty`)
}

/** Stream `text` through every prefix in `cuts`, then finish with the whole text. */
function streamThenFinish(
  text: string,
  cuts: number[],
  options: StreamingMarkdownOptions = {},
): HTMLElement {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host, options)
  for (const cut of cuts) renderer.update(text.slice(0, cut))
  renderer.finish(text)
  return host
}

// Answers that end mid-construct — each one leaves something held or forming
// in the last streaming frame, which is the gap `finish()` closes.
const ENDS_MID_CONSTRUCT: { name: string; text: string; options?: StreamingMarkdownOptions }[] = [
  { name: 'strikethrough', text: 'Intro.\n\nThe ~~old' },
  { name: 'closed strikethrough without a newline', text: 'Price is ~~$10~~ now $8' },
  { name: 'strong run', text: 'Some **bold' },
  { name: 'inline code', text: 'Run `npm test' },
  { name: 'link text', text: 'See [the docs' },
  { name: 'link destination', text: 'See [the docs](https://example.com/a' },
  { name: 'paragraph line', text: 'First line\nsecond line without newline' },
  { name: 'heading', text: '# Title\n\n## Sub' },
  { name: 'table row', text: '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4' },
  { name: 'table header and partial separator', text: 'Before.\n\n| a | b |\n| - |' },
  { name: 'forming table', text: '| a | b |' },
  { name: 'list item', text: '- one\n- two\n- thr' },
  { name: 'ordered list item', text: '1. one\n2. two\n3. ~~thr' },
  { name: 'list continuation', text: '- one\n  continued' },
  { name: 'nested list item', text: '- one\n  - nested' },
  { name: 'task list item', text: '- [x] done\n- [ ] to' },
  { name: 'blockquote', text: '> quoted\n> still quo' },
  { name: 'alert', text: '> [!NOTE]\n> Remem' },
  { name: 'unclosed fence', text: 'Code:\n\n```js\nconst a = 1\nconst b' },
  { name: 'unclosed fence, newline-terminated', text: '```py\nprint(1)\n' },
  { name: 'fence opener only', text: 'Text\n\n```' },
  { name: 'nested fence in a list', text: '- step\n\n  ```sh\n  npm ci\n  npm te' },
  { name: 'fence in a blockquote', text: '> ```\n> code' },
  { name: 'unclosed mermaid fence', text: '```mermaid\ngraph TD\n  A-->B' },
  { name: 'unclosed math fence', text: '```math\nx^2' },
  { name: 'display math', text: 'Euler:\n\n$$\ne^{i\\pi} + 1', options: { mathSyntax: true } },
  { name: 'inline math', text: 'Area is $\\pi r^2', options: { mathSyntax: true } },
  { name: 'footnote definition', text: 'Claim[^1].\n\n[^1]: Sou' },
  { name: 'link reference definition', text: '[a]\n\n[a]: https://example.com' },
  { name: 'open raw details', text: '<details>\n<summary>More</summary>\n\nBody' },
  { name: 'setext underline', text: 'Title\n---' },
  { name: 'multi-line setext underline', text: 'Foo\nbar\n===' },
  { name: 'trailing spaces', text: 'Hard break  ' },
  { name: 'thematic break', text: 'a\n\n***' },
]

describe('StreamingMarkdownRenderer.finish() matches the at-rest render', () => {
  it('for answers ending mid-construct, from every streaming history', () => {
    for (const { name, text, options } of ENDS_MID_CONSTRUCT) {
      // No history, one prefix frame per cut, and the whole char-by-char stream.
      assertFinished(streamThenFinish(text, [], options), text, `${name} (no history)`, options)
      for (const cut of streamingCutIndices(text)) {
        assertFinished(
          streamThenFinish(text, [cut], options),
          text,
          `${name} (cut=${String(cut)})`,
          options,
        )
      }
      const all = Array.from({ length: text.length + 1 }, (_, i) => i)
      assertFinished(streamThenFinish(text, all, options), text, `${name} (char stream)`, options)
    }
  })

  it('releases what the last streaming frame held back', () => {
    // The concrete Duck.ai failure: a finished answer ending mid-line kept its
    // last words hidden until the host appended a `\n` by hand.
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('Intro.\n\nThe ~~old')
    assert.doesNotMatch(display(host), /old/, 'held mid-stream')
    renderer.finish()
    assert.match(host.querySelector('.stream-complete')?.innerHTML ?? '', /<p>The ~~old<\/p>/)
  })

  it('turns a never-closed fence into a finished code block, not forming scaffolding', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('```js\nconst a = 1')
    assert.ok(host.querySelector('.stream-fence-forming'), 'forming mid-stream')
    renderer.finish()
    assert.equal(host.querySelector('.stream-fence-forming'), null)
    assert.match(host.querySelector('.stream-complete')?.innerHTML ?? '', /^<pre><code class="[^"]*">/)
  })

  it('for every truncation of the CommonMark + GFM baseline examples', () => {
    const examples = [...loadBaselinePassingExamples(), ...loadGfmExtensionBaselineExamples()]
    for (const ex of examples) {
      for (const cut of streamingCutIndices(ex.markdown)) {
        const text = ex.markdown.slice(0, cut)
        // Streamed as one frame, then finished: the realistic end-of-stream
        // shape (multi-frame histories are covered by the corpus above).
        const host = streamThenFinish(text, [cut])
        assertFinished(host, text, `example #${String(ex.example)} (${ex.section}) cut=${String(cut)}`)
      }
    }
    // The setext carve-out stays narrow: the spec corpus does reach it, and
    // nothing else diverges (asserted inside expectedFinished).
    if (examples.length > 0) assert.ok(atRestDivergences.size > 0)
  })

  it('defaults to the text of the last update and is idempotent', () => {
    const text = '- a\n- b'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.finish()
    assertFinished(host, '', 'finish before any update')
    renderer.update(text)
    renderer.finish()
    assertFinished(host, text, 'bare finish')
    const li = host.querySelector('li')
    renderer.finish()
    renderer.finish(text)
    assertFinished(host, text, 'repeated finish')
    assert.equal(host.querySelector('li'), li, 'a repeated finish keeps node identity')
  })

  it('keeps the committed prefix node identity across the finishing commit', () => {
    const text = '# Title\n\nFirst paragraph.\n\nLast ~~words'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update(text)
    const h1 = host.querySelector('h1')
    renderer.finish()
    assertFinished(host, text, 'finish')
    assert.equal(host.querySelector('h1'), h1)
  })

  it('applies the construction-time config', () => {
    const text = 'Inline $x^2 <b>raw</b>'
    const options: StreamingMarkdownOptions = { mathSyntax: true, htmlPolicy: 'escape' }
    assertFinished(streamThenFinish(text, [3, 8], options), text, 'mathSyntax + escape', options)
  })
})

describe('StreamingMarkdownRenderer.update() after finish()', () => {
  it('resumes streaming exactly as a fresh renderer would', () => {
    const cases: [string, string][] = [
      ['The ~~old', 'The ~~old~~ new text'],
      ['The ~~old', 'The ~~old'], // un-finishing the same text holds it again
      ['| a |\n| - |\n| 1', '| a |\n| - |\n| 1 |\n| 2 |\n\nAfter.\n'],
      ['```js\nconst a', '```js\nconst a = 1\n```\n\nDone.'],
      ['```js\nconst a', '```js\nconst a = 1\n'],
      ['- one\n- tw', '- one\n- two\n- three'],
      ['Para one.\n\nPara tw', 'Para one.\n\nPara two.\n\nPara three'],
      ['Claim[^1].\n\n[^1]: Sou', 'Claim[^1].\n\n[^1]: Source.\n\nMore[^2].'],
      ['Title\n---', 'Title\n----\n\nBody'],
      ['A long answer.', 'Something else entirely.'], // regenerated in place
      ['Some text', ''],
    ]
    for (const [finished, next] of cases) {
      const host = document.createElement('div')
      const renderer = new StreamingMarkdownRenderer(host)
      renderer.update(finished.slice(0, Math.floor(finished.length / 2)))
      renderer.finish(finished)
      renderer.update(next)
      assert.equal(
        display(host),
        freshStreamingDisplay(next),
        `${JSON.stringify(finished)} → ${JSON.stringify(next)}`,
      )
      renderer.finish()
      assertFinished(host, next, `${JSON.stringify(next)} finished again`)
    }
  })

  it('never leaves the frozen-tail memo trusting stale DOM (finish, then stream on)', () => {
    // Long enough to freeze blocks, with lists, a table, a fence, a link
    // reference and footnotes. Finish at a cut, then stream the rest: every
    // frame must equal a fresh render of the same text, and the final finish
    // must equal at-rest.
    const doc = [
      '# Report\n\n',
      'Intro with ~~struck~~ and **bold** text.\n\n',
      '- item one\n- item two\n  continued\n\n',
      '| h1 | h2 |\n| -- | -- |\n| a | b |\n\n',
      '```ts\nconst x = 1\n```\n\n',
      'Ref [x] and note[^n].\n\n',
      '> quote\n\n',
      '[x]: https://example.com\n\n',
      '[^n]: The note.\n\n',
      'Closing ~~old line',
    ].join('')
    for (let cut = 0; cut <= doc.length; cut += 7) {
      const host = document.createElement('div')
      const renderer = new StreamingMarkdownRenderer(host)
      renderer.update(doc.slice(0, cut))
      renderer.finish()
      for (let end = cut; end <= doc.length; end += 13) {
        renderer.update(doc.slice(0, end))
        assert.equal(
          display(host),
          freshStreamingDisplay(doc.slice(0, end)),
          `finish at ${String(cut)}, update to ${String(end)}`,
        )
      }
      renderer.finish(doc)
      assertFinished(host, doc, `finish at ${String(cut)}, finished`)
    }
  })
})
