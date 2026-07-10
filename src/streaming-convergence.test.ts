// Property test: incremental streaming must converge to the same display as a
// fresh complete render, using CommonMark baseline examples as fuzz inputs.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { loadGfmExtensionBaselineExamples } from '../tests/gfm/baseline-examples.ts'
import { streamingCutIndices } from '../tests/streaming-cuts.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
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

// CommonMark alone contains no GFM extensions — the streaming table regression
// fixed alongside this corpus change streamed cleanly past a table-free fuzz —
// so the GFM-only baseline examples (tables, task lists, strikethrough) join
// the corpus. Empty when spec.txt is not fetched (CI fetches it first).
const baselineExamples = [...loadBaselinePassingExamples(), ...loadGfmExtensionBaselineExamples()]

describe('streaming markdown convergence (CommonMark baseline fuzz)', () => {
  it('incremental cuts converge to a fresh complete StreamingMarkdownRenderer render', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      const fresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      for (const cut of streamingCutIndices(markdown)) {
        const viaHistory = streamingDisplayAfterUpdates(markdown, [cut, markdown.length])
        assert.equal(
          viaHistory,
          fresh,
          `example #${String(ex.example)} (${ex.section}) cut=${String(cut)}`,
        )
      }
    }
  })

  it('matches at-rest render when the tokenizer commits the full input', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      if (splitForStreaming(markdown).pending !== '') continue
      const fresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      const atRest = sanitizeRenderedMarkdown(renderMarkdownUnsafe(markdown))
      assert.equal(fresh, atRest, `example #${String(ex.example)} (${ex.section}) at-rest`)
    }
  })

  // #109: a pending top-level bullet after a trailing blockquote whose last
  // block is itself a list must stream as a sibling list, matching both the DOM
  // emitter and the fresh render — not be spliced inside the quote's list. The
  // pending bullet renders as a committed-position block inside `stream-complete`
  // for both emitters, so compare that subtree directly (the shared helper's
  // `.stream-pending` lookup targets the trailing inline span, not this block).
  it('streams a pending top-level bullet after a trailing blockquote as a sibling in both emitters', () => {
    const midStream = '> - a\n\n- b'
    const host = document.createElement('div')
    new StreamingMarkdownRenderer(host).update(midStream)
    const domComplete = host.querySelector('.stream-complete')?.innerHTML ?? ''
    const stringMid = renderStreamingMarkdown(midStream)
    assert.equal(stringMid, domComplete, 'string emitter matches DOM stream-complete mid-stream')
    assert.match(stringMid, /<\/blockquote><ul><li[^>]*>b<\/li><\/ul>$/)
    assert.doesNotMatch(stringMid, /<li>a<\/li><li[^>]*>b<\/li>/)
  })

  it('sweeps a stale pending <li> when a later held frame empties the list tail (#108)', () => {
    // Frame `- ~~` renders a pending list item; frame `- ~~[` makes the `~~` an
    // unmatched opener, so the whole tail holds. The pending <li>/<ul> from the
    // prior frame must be swept, matching a fresh (empty) render.
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('- ~~')
    renderer.update('- ~~[')
    assert.equal(host.querySelectorAll('li').length, 0, 'stale pending <li> persisted')
    assert.equal(extractStreamingDisplay(host), streamingDisplayAfterUpdates('- ~~[', [5]))
  })

  it('never flashes a literal trailing ~~ that a later character retracts (#108)', () => {
    // A trailing `~~` at end-of-input is held, so no frame shows literal `~~`.
    for (const md of ['- ~~', 'a ~~', '- ~~[', 'a ~~b']) {
      const dom = streamingDisplayAfterUpdates(md, [md.length])
      assert.ok(!dom.includes('~~'), `DOM frame flashed literal ~~ for ${JSON.stringify(md)}`)
      assert.ok(
        !renderStreamingMarkdown(md).includes('~~'),
        `string frame flashed literal ~~ for ${JSON.stringify(md)}`,
      )
    }
  })

  it('converges the held-list-tail history in the string emitter (#108)', () => {
    assert.equal(renderStreamingMarkdown('- ~~[').includes('<li'), false)
    assert.equal(renderStreamingMarkdown('- ~~['), streamingDisplayAfterUpdates('- ~~[', [5]))
  })

  it('renderStreamingMarkdown matches the incremental renderer when fully committed', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      if (splitForStreaming(markdown).pending !== '') continue
      const domFresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      const stringFresh = renderStreamingMarkdown(markdown)
      assert.equal(
        domFresh,
        stringFresh,
        `example #${String(ex.example)} (${ex.section}) string API`,
      )
    }
  })
})
