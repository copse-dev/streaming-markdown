// Pending-line plain-text fast path: when a delta merely extends a plain-prose
// pending line with provably inert characters, the renderer appends them to
// the pending element's trailing text node and skips the inline re-render +
// sanitize + innerHTML swap. The invariant under test: every frame the fast
// path produces must be byte-identical (innerHTML) to what the full re-render
// path produces for the same prefix — engaging is an optimization, never a
// visible behavior. The oracle is a second incremental renderer whose fast
// path is suppressed before every update, i.e. exactly the pre-existing slow
// path (cf. streaming-reroot.test.ts's committed-region oracle).
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

/** Null the private fast-path state so `oracle` always takes the full path. */
function suppressFastPath(oracle: StreamingMarkdownRenderer): void {
  ;(oracle as unknown as { pendingFast: unknown }).pendingFast = null
}

/**
 * Stream `input` in `step`-char deltas through a fast-path renderer and a
 * suppressed oracle, asserting full-host innerHTML equality after EVERY
 * update. Returns the fast-path renderer's hit count.
 */
function streamComparing(input: string, step = 1, label = ''): number {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  const oracleHost = document.createElement('div')
  const oracle = new StreamingMarkdownRenderer(oracleHost)
  for (let cut = step; cut < input.length + step; cut += step) {
    const prefix = input.slice(0, Math.min(cut, input.length))
    renderer.update(prefix)
    suppressFastPath(oracle)
    oracle.update(prefix)
    assert.equal(
      host.innerHTML,
      oracleHost.innerHTML,
      `${label} cut=${String(Math.min(cut, input.length))} prefix=${JSON.stringify(prefix)}`,
    )
  }
  assert.equal(oracle.pendingFastPathHits, 0, 'suppressed oracle must never fast-path')
  return renderer.pendingFastPathHits
}

describe('pending-line plain-text fast path', () => {
  it('engages on every delta of a plain prose line, byte-identical to the full path', () => {
    const input = 'The quick brown fox jumps over the lazy dog, then keeps going quietly.'
    const hits = streamComparing(input)
    // First char is the arming full render; every later char is inert prose.
    assert.equal(hits, input.length - 1)
  })

  it('matches a fresh single-shot renderer at every prose prefix', () => {
    const input = "Streaming prose stays identical; a fresh render can't tell the difference."
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= input.length; cut++) {
      const prefix = input.slice(0, cut)
      renderer.update(prefix)
      const freshHost = document.createElement('div')
      new StreamingMarkdownRenderer(freshHost).update(prefix)
      assert.equal(host.innerHTML, freshHost.innerHTML, `cut=${String(cut)}`)
    }
    assert.ok(renderer.pendingFastPathHits > input.length / 2)
  })

  it('engages for a paragraph-continuation pending line', () => {
    const input = 'A first line of prose that commits\nand a second line following it.'
    const hits = streamComparing(input)
    assert.ok(hits > 10, `expected continuation-line hits, got ${String(hits)}`)
  })

  it('engages in 5-char deltas (LLM-shaped chunks)', () => {
    const input =
      'Language models stream small deltas of plain words, and the renderer should ' +
      'absorb each one without re-rendering the entire pending sentence again.'
    const hits = streamComparing(input, 5)
    assert.ok(hits > 20, `expected chunked hits, got ${String(hits)}`)
  })

  it('resumes after completed inline markup earlier in the line', () => {
    const input = 'some **bold** then plain prose keeps flowing after the markup ends here'
    const hits = streamComparing(input)
    // The `**bold**` region falls back; the long plain tail re-arms and appends.
    assert.ok(hits > 30, `expected post-markup hits, got ${String(hits)}`)
  })

  for (const [name, input] of [
    ['emphasis', 'watch **bold text reveal** and then *italics too* here'],
    ['underscore emphasis', 'some _emphasis_ mid line and word_internal_underscores too'],
    ['code span', 'inline `code span arrives` and more `x` after'],
    ['unclosed backtick', 'a dangling `code span that never closes stays held'],
    ['link', 'a [link label](https://example.dev/path) with a tail'],
    ['forming link label', '[label grows while streaming with plain words'],
    ['forming link destination', 'see [xyz](za and more text that must not append'],
    ['image', 'an ![alt text](https://example.dev/i.png) image then words'],
    ['strikethrough', 'this ~~struck text~~ then more prose'],
    ['entity', 'AT&amp;T works; ditto &copy; and &#160; refs'],
    ['nbsp strip', 'x &amp;nbsp; y and a tail'],
    ['raw angle text', 'compare 1 < 2 and a <b>bold tag</b> then <div attr'],
    ['inline math', 'math $x+y$ inline and $a_i$ more'],
    ['emoji shortcode', 'party :tada: time and :smile: again'],
    ['footnote ref', 'cites[^1] mid line and more words'],
    ['hard break backslash', 'line one\\\nline two continues'],
    ['bare autolink', 'visit https://example.com/docs today for more'],
    ['www autolink', 'see www.example.com now and keep writing'],
    ['email autolink', 'mail a@b.co now and continue with prose'],
    ['leading spaces', '   indented prose still normalizes per frame'],
    ['indented code drift', '    four spaces becomes code'],
    ['list marker drift', ' - grows into a list item'],
    ['ordered marker drift', '12. numbered list forms late'],
    ['heading drift', '## a heading streams in'],
    ['blockquote drift', '> quoted text streams in'],
    ['thematic break drift', '--- and then words'],
    ['pipe table drift', '| a | b | maybe a table'],
    ['trailing backslash', 'escape coming \\. and then more'],
    ['dollar tail', 'price is $5 and rising fast'],
  ] as const) {
    it(`stays byte-identical with markup mid-stream: ${name}`, () => {
      streamComparing(input, 1, name)
    })
  }

  it('stays byte-identical across held-to-revealed transitions', () => {
    for (const input of [
      'hold **until the closer arrives** then plain again for a while',
      'entity hold &am then &amp; resolves and prose continues after it',
      'tilde hold ~~strike opens and closes~~ tail words follow here',
      'math hold $a+b then $a+b$ closes and words resume after that',
    ]) {
      streamComparing(input, 1, input.slice(0, 12))
    }
  })

  it('falls back for multi-line pending tails', () => {
    for (const input of [
      'Maybe a setext heading\n=== \nand after',
      'para line\nsecond pending line\nthird one',
    ]) {
      streamComparing(input, 1, input.slice(0, 12))
    }
  })

  it('falls back for CJK text (non-ASCII is never inert)', () => {
    const hits = streamComparing('这是一段中文文本，用来测试流式渲染。')
    assert.equal(hits, 0)
    streamComparing('CJK 中文 mixed with ASCII words 混在一起 here', 1, 'mixed CJK')
  })

  it('never engages when the whole line is a single markup span', () => {
    const hits = streamComparing('**all bold from the first character to the last**')
    assert.equal(hits, 0)
  })

  it('treats a byte-identical repeat update as a fast-path no-op', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('plain words')
    const before = host.innerHTML
    const hits = renderer.pendingFastPathHits
    renderer.update('plain words')
    assert.equal(host.innerHTML, before)
    assert.equal(renderer.pendingFastPathHits, hits + 1)
  })

  it('falls back and self-heals when the pending DOM was mutated externally', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('plain words')
    // A host script rewrites the pending paragraph behind the renderer's back.
    const pendingP = host.querySelector('.stream-pending-paragraph')
    assert.ok(pendingP)
    pendingP.textContent = 'mutated'
    renderer.update('plain words grow')
    const fresh = document.createElement('div')
    new StreamingMarkdownRenderer(fresh).update('plain words grow')
    assert.equal(host.innerHTML, fresh.innerHTML)
    // A byte-identical repeat update must also detect the mutation, not no-op.
    pendingP.textContent = 'mutated again'
    renderer.update('plain words grow')
    assert.equal(host.innerHTML, fresh.innerHTML)
  })

  it('holds equivalence over CommonMark baseline examples streamed char-by-char', () => {
    const examples = loadBaselinePassingExamples().filter((_, i) => i % 25 === 0)
    for (const ex of examples) {
      streamComparing(ex.markdown, 1, `example #${String(ex.example)}`)
    }
  })
})
