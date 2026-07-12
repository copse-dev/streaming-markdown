import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { withConfig } from './config.ts'

// Grammar feature gates (`MarkdownConfig.footnotes` / `.linkReferences`): both
// default on; `false` disables the grammar for one render so the feature-parity
// benchmark profile (docs/BENCHMARKS.md) can compare against renderers without
// footnote / reference-link support. Disabled means the definition lines are
// ordinary paragraphs (their text is visible) and references stay literal.
describe('footnotes config gate', () => {
  const doc = 'text[^1]\n\n[^1]: the note\n'

  it('defaults on: reference resolves and the section renders', () => {
    const html = renderMarkdownUnsafe(doc)
    assert.match(html, /class="footnotes"/)
    assert.match(html, /the note/)
    assert.doesNotMatch(html, /\[\^1\]/)
  })

  it('off: definition renders as a visible paragraph and the reference stays literal', () => {
    const html = renderMarkdownUnsafe(doc, { footnotes: false })
    assert.doesNotMatch(html, /class="footnotes"/)
    assert.match(html, /text\[\^1\]/)
    // CommonMark without the footnote extension: `[^1]: the note` is a link
    // reference definition with label `^1` (consumed, rendering nothing).
    // With BOTH gates off it is a plain paragraph.
    const both = renderMarkdownUnsafe(doc, { footnotes: false, linkReferences: false })
    assert.match(both, /<p>\[\^1\]: the note<\/p>/)
  })

  it('off: tokenizer emits no footnote_def blocks', () => {
    withConfig({ footnotes: false }, () => {
      const kinds = tokenizeBlocks(doc).map((t) => t.kind)
      assert.ok(!kinds.includes('footnote_def'))
    })
    const kinds = tokenizeBlocks(doc).map((t) => t.kind)
    assert.ok(kinds.includes('footnote_def'))
  })
})

describe('linkReferences config gate', () => {
  const doc = '[site]\n\n[site]: https://example.com "T"\n'

  it('defaults on: the reference resolves and the definition renders nothing', () => {
    const html = renderMarkdownUnsafe(doc)
    assert.match(html, /<a href="https:\/\/example\.com"/)
    assert.doesNotMatch(html, /\[site\]:/)
  })

  it('off: definition is a visible paragraph and the reference stays literal', () => {
    const html = renderMarkdownUnsafe(doc, { linkReferences: false })
    // The reference does not resolve; the definition line is visible prose
    // (its bare URL still extended-autolinks, as in any paragraph).
    assert.match(html, /<p>\[site\]<\/p>/)
    assert.match(html, /<p>\[site\]: <a href="https:\/\/example\.com"/)
  })

  it('off: inline links still render', () => {
    const html = renderMarkdownUnsafe('[x](https://example.com)', { linkReferences: false })
    assert.match(html, /<a href="https:\/\/example\.com"/)
  })

  it('off, footnotes on: `[^1]:` is still a footnote definition', () => {
    const html = renderMarkdownUnsafe('text[^1]\n\n[^1]: note\n', { linkReferences: false })
    assert.match(html, /class="footnotes"/)
  })
})

describe('gates in the streaming path', () => {
  const doc = 'para one[^1]\n\n[ref] and more\n\n[^1]: note\n\n[ref]: https://example.com\n'
  const gated = { footnotes: false, linkReferences: false }

  it('renderStreamingMarkdown converges to the gated document render', () => {
    const streamed = renderStreamingMarkdown(doc, gated)
    assert.doesNotMatch(String(streamed), /class="footnotes"/)
    assert.match(String(streamed), /<p>\[ref\] and more<\/p>/)
    assert.match(String(streamed), /<p>\[\^1\]: note<\/p>/)
    assert.match(String(streamed), /<p>\[ref\]: <a href="https:\/\/example\.com"/)
  })

  it('StreamingMarkdownRenderer.update applies construction-time gates on every chunk', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, gated)
    let acc = ''
    for (let i = 0; i < doc.length; i += 7) {
      acc = doc.slice(0, i + 7)
      renderer.update(acc)
    }
    renderer.update(doc)
    assert.doesNotMatch(host.innerHTML, /class="footnotes"/)
    assert.match(host.textContent ?? '', /\[\^1\]: note/)
    assert.match(host.textContent ?? '', /\[ref\] and more/)
    assert.match(host.textContent ?? '', /\[ref\]: https:\/\/example\.com/)
  })

  it('a gated renderer and a default renderer coexist without bleed', () => {
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const gatedRenderer = new StreamingMarkdownRenderer(hostA, gated)
    const defaultRenderer = new StreamingMarkdownRenderer(hostB)
    gatedRenderer.update(doc)
    defaultRenderer.update(doc)
    assert.doesNotMatch(hostA.innerHTML, /class="footnotes"/)
    assert.match(hostB.innerHTML, /class="footnotes"/)
    assert.match(hostB.innerHTML, /<a href="https:\/\/example\.com"/)
  })
})
